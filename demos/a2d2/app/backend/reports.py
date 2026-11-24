"""Per-event deep-dive reports for the A2D2 events mined in a2d2_analysis.ipynb.

Each event name maps to a report:
  - panels: time-synced signal panels (silver channel names or derived:* channels)
  - kpis:   headline figures computed in the browser over the event window from the
            same series (so every KPI can be clicked to jump to its moment)
  - focus:  the KPI whose moment the playhead starts on ("key moment")

The ego "vehicle context" panels are appended to every report. Panels/KPIs whose
channels don't exist in the deployment (e.g. no object detection run, no distance
estimation) are dropped by `build_report`, so the page degrades gracefully.

KPI aggregations (over [event start, event end]):
  min / max / mean / first / last / delta (last - first) / range (max - min)
  at_min_of:<channel> / at_max_of:<channel>  -> value of `channel` at the moment
                                              another channel is minimal/maximal
"""
from __future__ import annotations

# ---- channel shorthands (A2D2 bus + perception channels) ---------------------
SPEED = "vehicle_speed"                      # km/h
ACC_X = "acceleration_x"                     # m/s² (longitudinal; < 0 = deceleration)
ACC_Y = "acceleration_y"                     # m/s² (lateral)
BRAKE = "brake_pressure"                     # bar
STEER = "steering_angle_calculated"          # deg (unsigned magnitude)
ACCEL_PEDAL = "accelerator_pedal"            # %
YAW = "angular_velocity_omega_z"             # deg/s
PED_D, CYC_D, VEH_D = "pedestrian_nearest_distance_m", "cyclist_nearest_distance_m", "vehicle_nearest_distance_m"
PED_AHEAD_D, VEH_AHEAD_D = "pedestrian_ahead_nearest_distance_m", "vehicle_ahead_nearest_distance_m"
THW = "derived:thw_s"                        # time headway = in-path lead distance / speed (computed server-side)


def ch(name: str, label: str, axis: str | None = None, scale: float | None = None) -> dict:
    d = {"name": name, "label": label}
    if axis:
        d["axis"] = axis
    if scale:
        d["scale"] = scale
    return d


def kpi(label: str, channel: str, agg: str, unit: str, help_: str, digits: int = 1) -> dict:
    return {"label": label, "channel": channel, "agg": agg, "unit": unit, "help": help_, "digits": digits}


# ---- reusable panels ----------------------------------------------------------
P_BRAKING = {"id": "braking", "title": "Braking — deceleration & brake pressure",
             "channels": [ch(ACC_X, "Accel X [m/s²]"), ch(BRAKE, "Brake pressure [bar]", "right")]}
P_SPEED = {"id": "speed", "title": "Speed & accelerator",
           "channels": [ch(SPEED, "Speed [km/h]"), ch(ACCEL_PEDAL, "Accelerator [%]", "right")]}
P_STEER = {"id": "steer", "title": "Steering & lateral dynamics",
           "channels": [ch(STEER, "|Steering angle| [deg]"), ch(ACC_Y, "Accel Y [m/s²]", "right"),
                        ch(YAW, "Yaw rate [deg/s]", "right")]}
P_PED = {"id": "ped", "title": "Pedestrian proximity (camera + depth)",
         "channels": [ch(PED_D, "Nearest pedestrian [m]"), ch(PED_AHEAD_D, "Pedestrian in path [m]")]}
P_PED_COUNT = {"id": "pedcount", "title": "Pedestrian detections",
               "channels": [ch("detected_pedestrians", "Pedestrians (frame)"), ch("ahead_pedestrians", "Pedestrians in path")]}
P_CYC = {"id": "cyc", "title": "Cyclist proximity (camera + depth)",
         "channels": [ch(CYC_D, "Nearest cyclist [m]"), ch("detected_cyclists", "Cyclists (frame)", "right")]}
P_LEAD = {"id": "lead", "title": "Lead vehicle — distance & time headway",
          "channels": [ch(VEH_AHEAD_D, "In-path vehicle [m]"), ch(THW, "Time headway [s]", "right")]}
P_VEH_COUNT = {"id": "vehcount", "title": "Vehicle detections",
               "channels": [ch("detected_vehicles", "Vehicles (frame)"), ch("ahead_vehicles", "Vehicles in path")]}

# Vehicle context shown under every report (de-duplicated against the event panels).
CONTEXT = [P_SPEED, P_BRAKING, P_STEER]

K_PEAK_DECEL = kpi("Peak deceleration", ACC_X, "min", "m/s²", "Most negative longitudinal acceleration in the event.", 2)
K_MAX_BRAKE = kpi("Max brake pressure", BRAKE, "max", "bar", "Highest brake pressure in the event.")
K_SPEED_DROP = kpi("Speed change", SPEED, "delta", "km/h", "Speed at event end minus speed at event start.")
K_SPEED_START = kpi("Speed at start", SPEED, "first", "km/h", "Ego speed when the event starts.")
K_MAX_STEER = kpi("Max steering", STEER, "max", "deg", "Largest steering-wheel angle in the event.", 0)
K_MAX_LAT = kpi("Max lateral accel.", ACC_Y, "max_abs", "m/s²", "Largest absolute lateral acceleration.", 2)

REPORTS: dict[str, dict] = {
    "emergency_braking": {
        "summary": "Hard braking while moving: how hard, how long, and from what speed.",
        "panels": [P_BRAKING, P_SPEED, P_LEAD],
        "kpis": [K_PEAK_DECEL, K_MAX_BRAKE, K_SPEED_START, K_SPEED_DROP,
                 kpi("Lead vehicle at peak decel.", VEH_AHEAD_D, f"at_min_of:{ACC_X}", "m",
                     "In-path vehicle distance at the moment of peak deceleration (cause check).")],
        "focus": 0,
    },
    "sharp_cornering": {
        "summary": "Large steering input at speed — a tight or fast turn.",
        "panels": [P_STEER, P_SPEED],
        "kpis": [K_MAX_STEER, K_MAX_LAT,
                 kpi("Speed at max steering", SPEED, f"at_max_of:{STEER}", "km/h", "Ego speed at the largest steering angle."),
                 kpi("Max yaw rate", YAW, "max_abs", "deg/s", "Largest absolute yaw rate.")],
        "focus": 0,
    },
    "evasive_maneuver": {
        "summary": "Emergency braking followed by sharp steering — a brake-then-swerve avoidance.",
        "panels": [P_BRAKING, P_STEER, P_LEAD, P_PED],
        "kpis": [K_PEAK_DECEL, K_MAX_STEER, K_SPEED_START,
                 kpi("Speed at max steering", SPEED, f"at_max_of:{STEER}", "km/h", "Ego speed when steering peaks.")],
        "focus": 1,
    },
    "pedestrian_near_miss": {
        "summary": "A pedestrian close to the car while it moves at speed.",
        "panels": [P_PED, P_PED_COUNT, P_SPEED],
        "kpis": [kpi("Closest pedestrian", PED_D, "min", "m", "Smallest estimated pedestrian distance."),
                 kpi("Speed at closest approach", SPEED, f"at_min_of:{PED_D}", "km/h", "Ego speed when the pedestrian is closest."),
                 kpi("Max pedestrians", "detected_pedestrians", "max", "", "Most pedestrians detected in one frame.", 0),
                 K_PEAK_DECEL],
        "focus": 0,
    },
    "pedestrian_in_path": {
        "summary": "A pedestrian directly ahead in the ego path — the highest-criticality VRU scenario.",
        "panels": [P_PED, P_PED_COUNT, P_BRAKING],
        "kpis": [kpi("Closest pedestrian in path", PED_AHEAD_D, "min", "m", "Smallest distance to a pedestrian in the ego path."),
                 kpi("Speed at closest approach", SPEED, f"at_min_of:{PED_AHEAD_D}", "km/h", "Ego speed at the closest in-path approach."),
                 K_PEAK_DECEL, K_MAX_BRAKE],
        "focus": 0,
    },
    "cyclist_close_encounter": {
        "summary": "A cyclist within a few metres while the car is moving.",
        "panels": [P_CYC, P_SPEED, P_STEER],
        "kpis": [kpi("Closest cyclist", CYC_D, "min", "m", "Smallest estimated cyclist distance."),
                 kpi("Speed at closest approach", SPEED, f"at_min_of:{CYC_D}", "km/h", "Ego speed when the cyclist is closest."),
                 kpi("Steering at closest approach", STEER, f"at_min_of:{CYC_D}", "deg", "Steering angle at the closest pass.", 0)],
        "focus": 0,
    },
    "imminent_rear_end": {
        "summary": "Following the in-path lead vehicle too closely (short time headway).",
        "panels": [P_LEAD, P_VEH_COUNT, P_SPEED, P_BRAKING],
        "kpis": [kpi("Min time headway", THW, "min", "s", "Shortest time headway (lead distance ÷ ego speed).", 2),
                 kpi("Lead distance at min headway", VEH_AHEAD_D, f"at_min_of:{THW}", "m", "In-path vehicle distance at the shortest headway."),
                 kpi("Speed at min headway", SPEED, f"at_min_of:{THW}", "km/h", "Ego speed at the shortest headway."),
                 K_MAX_BRAKE],
        "focus": 0,
    },
    "vru_brake_reaction": {
        "summary": "A vulnerable road user appears close, then the driver brakes hard.",
        "panels": [P_PED, P_CYC, P_BRAKING],
        "kpis": [kpi("Closest pedestrian", PED_D, "min", "m", "Smallest pedestrian distance in the event."),
                 kpi("Closest cyclist", CYC_D, "min", "m", "Smallest cyclist distance in the event."),
                 K_PEAK_DECEL, K_MAX_BRAKE],
        "focus": 2,
    },
}
# Count-based fallbacks used when no distance estimation ran (see a2d2_analysis.ipynb).
REPORTS["vru_while_braking"] = {
    "summary": "A vulnerable road user is visible during emergency braking.",
    "panels": [P_PED_COUNT, P_BRAKING],
    "kpis": [K_PEAK_DECEL, K_MAX_BRAKE, kpi("Max pedestrians", "detected_pedestrians", "max", "", "Most pedestrians in one frame.", 0)],
    "focus": 0,
}
REPORTS["vru_then_braking"] = {**REPORTS["vru_while_braking"], "summary": "A vulnerable road user is visible, then the driver brakes."}

DEFAULT_REPORT = {"summary": "Vehicle dynamics during the event.", "panels": [],
                  "kpis": [K_SPEED_START, K_PEAK_DECEL, K_MAX_BRAKE, K_MAX_STEER], "focus": 0}

DERIVED = {THW: (VEH_AHEAD_D, SPEED)}  # derived channel -> the silver channels it needs


def _available(name: str, have: set[str]) -> bool:
    if name in DERIVED:
        return all(c in have for c in DERIVED[name])
    return name in have


def build_report(event_name: str, have: set[str]) -> dict:
    """Report for `event_name`, restricted to channels present in this deployment."""
    rep = REPORTS.get(event_name, DEFAULT_REPORT)
    panels, seen = [], set()
    for col, group in (("event", rep["panels"]), ("context", CONTEXT)):
        for p in group:
            if p["id"] in seen:
                continue
            chans = [c for c in p["channels"] if _available(c["name"], have)]
            if chans:
                seen.add(p["id"])
                panels.append({**p, "channels": chans, "column": col})
    kpis = [k for k in rep["kpis"] if _available(k["channel"], have)
            and (":" not in k["agg"] or _available(k["agg"].split(":", 1)[1], have))]
    focus = rep["kpis"][rep.get("focus", 0)] if rep["kpis"] else None
    return {"summary": rep["summary"], "panels": panels, "kpis": kpis,
            "focus": kpis.index(focus) if focus in kpis else (0 if kpis else None)}
