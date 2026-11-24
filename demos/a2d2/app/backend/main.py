"""A2D2 event-explorer FastAPI backend.

Single-process app: serves /api/* JSON and the built React SPA from
frontend/dist. All data comes from Unity Catalog (mda_demo.a2d2_demo) via a
serverless SQL warehouse; MP4 clips are streamed from a UC Volume.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config
from .db import query, reconfigure_warehouse
from .reports import DERIVED, build_report

app = FastAPI(title="Impulse Event Explorer")
US = 1_000_000  # A2D2 channel/event time unit: epoch microseconds
print(f"[config] catalog={config.CATALOG} schema={config.SCHEMA} prefix={config.TABLE_PREFIX} "
      f"volume={config.VOLUME} warehouse={config.WAREHOUSE_ID}", flush=True)


@app.middleware("http")
async def _no_cache_spa_shell(request: Request, call_next):
    """index.html must be revalidated so a redeploy is picked up immediately; the
    content-hashed /assets/* bundles stay cacheable."""
    resp = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/") and not path.startswith("/assets/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp

# --------------------------------------------------------------------------- #
# Clip listing cache (the volume lists slowly; refresh every few minutes).
# --------------------------------------------------------------------------- #
_clip_cache: dict[str, float | set] = {"ts": 0.0, "names": set()}
_CLIP_TTL = 300  # seconds


def _list_clips() -> set[str]:
    now = time.time()
    if now - _clip_cache["ts"] < _CLIP_TTL and _clip_cache["names"]:
        return _clip_cache["names"]  # type: ignore[return-value]
    names: set[str] = set()
    folder = config.clips_dir()
    # Try a direct FUSE listing first; fall back to the SDK Files API.
    try:
        names = {p.name for p in Path(folder).iterdir() if p.suffix == ".mp4"}
    except Exception:
        try:
            from databricks.sdk import WorkspaceClient

            w = WorkspaceClient()
            for entry in w.files.list_directory_contents(folder):
                nm = os.path.basename(entry.path or "")
                if nm.endswith(".mp4"):
                    names.add(nm)
        except Exception as e:  # noqa: BLE001
            print(f"[clips] listing failed: {e}")
    _clip_cache["ts"] = now
    _clip_cache["names"] = names
    return names


def _clip_name(event_name: str, cid: int, eiid: int) -> str:
    return f"{event_name}_{cid}_{eiid}.mp4"


# --------------------------------------------------------------------------- #
# Verification table presence (it may not exist until the verify job has run).
# Cached so we don't probe on every request.
# --------------------------------------------------------------------------- #
_verify_cache: dict[str, float | bool] = {"ts": 0.0, "exists": False}
_VERIFY_TTL = 300  # seconds


def _verify_table_exists() -> bool:
    now = time.time()
    if now - _verify_cache["ts"] < _VERIFY_TTL and _verify_cache["ts"] > 0:
        return bool(_verify_cache["exists"])
    exists = False
    try:
        query(f"SELECT 1 FROM {config.table('event_verification_fact')} LIMIT 1", {})
        exists = True
    except Exception as e:  # noqa: BLE001 — optional table; log why
        print(f"[probe] event_verification_fact not readable: {str(e)[:300]}", flush=True)
        exists = False
    _verify_cache["ts"] = now
    _verify_cache["exists"] = exists
    return exists


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health():
    return {"status": "ok", "catalog": config.CATALOG, "schema": config.SCHEMA}


class ConfigUpdate(BaseModel):
    warehouse_id: str


@app.get("/api/config")
def get_config():
    return {
        "warehouse_id": config.get_warehouse_id(),
        "http_path": config.WAREHOUSE_HTTP_PATH,
    }


@app.post("/api/config")
def set_config(payload: ConfigUpdate):
    wid = payload.warehouse_id.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{16}", wid):
        raise HTTPException(400, "warehouse_id must be 16 hexadecimal characters")
    reconfigure_warehouse(wid)
    # Drop caches that may be warehouse-specific so they re-probe the new target.
    _verify_cache["ts"] = 0.0
    return {
        "warehouse_id": config.get_warehouse_id(),
        "http_path": config.WAREHOUSE_HTTP_PATH,
    }


@app.get("/api/filters")
def filters():
    fact = config.table("event_instance_fact")
    dim = config.table("event_dimension")
    tags = config.table("container_tags")

    bounds = query(
        f"SELECT min(start_ts) AS min_ts, max(end_ts) AS max_ts FROM {fact}"
    )
    names = query(
        f"SELECT DISTINCT e.event_name AS v FROM {fact} f "
        f"JOIN {dim} e ON f.event_id = e.event_id "
        f"WHERE e.event_name IS NOT NULL ORDER BY v"
    )
    types = query(
        f"SELECT DISTINCT e.event_type AS v FROM {fact} f "
        f"JOIN {dim} e ON f.event_id = e.event_id "
        f"WHERE e.event_type IS NOT NULL ORDER BY v"
    )
    cities = query(
        f"SELECT DISTINCT value AS v FROM {tags} WHERE key = 'city' ORDER BY v"
    )
    vehicles = query(
        f"SELECT DISTINCT value AS v FROM {tags} WHERE key = 'vehicle' ORDER BY v"
    )
    b = bounds[0] if bounds else {"min_ts": None, "max_ts": None}
    return {
        "event_names": [r["v"] for r in names],
        "event_types": [r["v"] for r in types],
        "cities": [r["v"] for r in cities],
        "vehicles": [r["v"] for r in vehicles],
        "min_ts": b["min_ts"],
        "max_ts": b["max_ts"],
    }


def _split_csv(val: str | None) -> list[str]:
    if not val:
        return []
    return [p for p in val.split(",") if p != ""]


@app.get("/api/events")
def events(
    vehicle: str | None = None,
    city: str | None = None,
    event_name: str | None = None,
    event_type: str | None = None,
    start_ts: int | None = None,
    end_ts: int | None = None,
    verified_only: bool = False,
):
    fact = config.table("event_instance_fact")
    dim = config.table("event_dimension")
    tags = config.table("container_tags")
    chtags = config.table("channel_tags")
    channels = config.table("channels")
    vfact = config.table("event_verification_fact")
    has_vf = _verify_table_exists()

    where = ["1=1"]
    params: dict[str, object] = {}

    def add_in(col_expr: str, values: list[str], prefix: str):
        if not values:
            return
        ph = []
        for i, v in enumerate(values):
            key = f"{prefix}{i}"
            params[key] = v
            ph.append(f":{key}")
        where.append(f"{col_expr} IN ({', '.join(ph)})")

    add_in("e.event_name", _split_csv(event_name), "en")
    add_in("e.event_type", _split_csv(event_type), "et")
    add_in("city.value", _split_csv(city), "ci")
    add_in("veh.value", _split_csv(vehicle), "ve")
    if start_ts is not None:
        params["start_ts"] = int(start_ts)
        where.append("f.start_ts >= :start_ts")
    if end_ts is not None:
        params["end_ts"] = int(end_ts)
        where.append("f.start_ts <= :end_ts")

    where_sql = " AND ".join(where)

    # Verification verdict columns/join (only if the verify job has produced the table).
    if has_vf:
        vf_cols = ("vf.is_relevant AS is_relevant, vf.confidence AS relevance_score, "
                   "vf.reason AS relevance_reason")
        vf_join = (f"LEFT JOIN {vfact} vf ON vf.container_id = ev.container_id "
                   "AND vf.event_instance_id = ev.event_instance_id")
        vf_where = "WHERE vf.is_relevant = true" if verified_only else ""
    else:
        vf_cols = ("CAST(NULL AS BOOLEAN) AS is_relevant, "
                   "CAST(NULL AS DOUBLE) AS relevance_score, "
                   "CAST(NULL AS STRING) AS relevance_reason")
        vf_join = ""
        vf_where = ""

    # Resolve lat/lon channel ids dynamically per container, then pick, for each
    # event, the channel sample nearest its start_ts. Spark SQL does NOT allow a
    # correlated reference inside a scalar subquery's ORDER BY, so instead we join
    # events to the lat/lon channel samples on container_id and keep the nearest
    # sample per event via QUALIFY ROW_NUMBER(). lat and lon are computed in two
    # separate "nearest" CTEs and joined back to the event set.
    sql = f"""
    WITH lat_ch AS (
      SELECT container_id, channel_id FROM {chtags}
      WHERE key = 'channel_name' AND value = 'latitude_degree'
    ),
    lon_ch AS (
      SELECT container_id, channel_id FROM {chtags}
      WHERE key = 'channel_name' AND value = 'longitude_degree'
    ),
    ev AS (
      SELECT f.container_id, f.event_instance_id, f.start_ts, f.end_ts,
             e.event_name, e.event_type, e.event_description,
             city.value AS city, veh.value AS vehicle
      FROM {fact} f
      JOIN {dim} e ON f.event_id = e.event_id
      LEFT JOIN {tags} city ON city.container_id = f.container_id AND city.key = 'city'
      LEFT JOIN {tags} veh  ON veh.container_id  = f.container_id AND veh.key  = 'vehicle'
      WHERE {where_sql}
    ),
    nearest_lat AS (
      SELECT ev.container_id, ev.event_instance_id, c.value AS lat
      FROM ev
      JOIN lat_ch l ON l.container_id = ev.container_id
      JOIN {channels} c
        ON c.container_id = ev.container_id AND c.channel_id = l.channel_id
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY ev.container_id, ev.event_instance_id
        ORDER BY abs(c.timestamp - ev.start_ts)
      ) = 1
    ),
    nearest_lon AS (
      SELECT ev.container_id, ev.event_instance_id, c.value AS lon
      FROM ev
      JOIN lon_ch l ON l.container_id = ev.container_id
      JOIN {channels} c
        ON c.container_id = ev.container_id AND c.channel_id = l.channel_id
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY ev.container_id, ev.event_instance_id
        ORDER BY abs(c.timestamp - ev.start_ts)
      ) = 1
    )
    SELECT
      ev.container_id, ev.event_instance_id, ev.event_name, ev.event_type, ev.event_description,
      ev.city, ev.vehicle, ev.start_ts, ev.end_ts,
      nlat.lat AS lat,
      nlon.lon AS lon,
      {vf_cols}
    FROM ev
    LEFT JOIN nearest_lat nlat
      ON nlat.container_id = ev.container_id
     AND nlat.event_instance_id = ev.event_instance_id
    LEFT JOIN nearest_lon nlon
      ON nlon.container_id = ev.container_id
     AND nlon.event_instance_id = ev.event_instance_id
    {vf_join}
    {vf_where}
    ORDER BY ev.start_ts
    """
    rows = query(sql, params)
    clips = _list_clips()
    for r in rows:
        r["start_ts"] = int(r["start_ts"]) if r["start_ts"] is not None else None
        r["end_ts"] = int(r["end_ts"]) if r["end_ts"] is not None else None
        cid_i, eiid_i = int(r["container_id"]), int(r["event_instance_id"])
        r["lat"] = float(r["lat"]) if r["lat"] is not None else None
        r["lon"] = float(r["lon"]) if r["lon"] is not None else None
        r["has_clip"] = _clip_name(r["event_name"], cid_i, eiid_i) in clips
        # ids as strings: event_instance_id / container_id may exceed JS's 2^53 integer precision
        r["container_id"], r["event_instance_id"] = str(cid_i), str(eiid_i)
        r["is_relevant"] = bool(r["is_relevant"]) if r.get("is_relevant") is not None else None
        r["relevance_score"] = (
            float(r["relevance_score"]) if r.get("relevance_score") is not None else None
        )
        r["relevance_reason"] = r.get("relevance_reason")
    return rows


@app.get("/api/events/{cid}/{eiid}/stats")
def event_stats(cid: int, eiid: int):
    stats = config.table("stats_aggregator_fact")
    sql = f"""
      SELECT channel_name, aggregation_label, statistic_value
      FROM {stats}
      WHERE container_id = :cid AND event_instance_id = :eiid
      ORDER BY channel_name, aggregation_label
    """
    rows = query(sql, {"cid": int(cid), "eiid": int(eiid)})
    # Pivot to one row per channel with min/mean/max.
    by_channel: dict[str, dict] = {}
    for r in rows:
        ch = by_channel.setdefault(
            r["channel_name"], {"channel_name": r["channel_name"]}
        )
        val = r["statistic_value"]
        ch[r["aggregation_label"]] = float(val) if val is not None else None
    return list(by_channel.values())


_CLIP_BYTES: "dict[str, bytes]" = {}
_CLIP_BYTES_MAX = 300 * 1024 * 1024  # clips are a few MB each


def _clip_bytes(path: str) -> bytes:
    if path in _CLIP_BYTES:
        data = _CLIP_BYTES.pop(path)
        _CLIP_BYTES[path] = data  # move to the end (LRU)
        return data
    try:
        data = Path(path).read_bytes()
    except Exception:  # noqa: BLE001 — no FUSE (Databricks Apps): Files API
        from databricks.sdk import WorkspaceClient

        data = WorkspaceClient().files.download(path).contents.read()  # type: ignore[union-attr]
    _CLIP_BYTES[path] = data
    while sum(len(v) for v in _CLIP_BYTES.values()) > _CLIP_BYTES_MAX and len(_CLIP_BYTES) > 1:
        _CLIP_BYTES.pop(next(iter(_CLIP_BYTES)))
    return data


def _safe_clip_path(cid: int, eiid: int, event_name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_]+", event_name):
        raise HTTPException(400, "bad event_name")
    name = _clip_name(event_name, int(cid), int(eiid))
    return Path(config.clips_dir()) / name


@app.get("/api/events/{cid}/{eiid}/clip")
def event_clip(cid: int, eiid: int, event_name: str, request: Request):
    path = _safe_clip_path(cid, eiid, event_name)
    # Cached: a browser loads a video with several Range requests; without the cache each one
    # re-downloaded the whole MP4 from the volume (FUSE locally, Files API in Apps).
    try:
        data = _clip_bytes(str(path))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, f"clip not found: {e}")

    total = len(data)
    range_header = request.headers.get("range")
    if range_header:
        m = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else total - 1
            end = min(end, total - 1)
            chunk = data[start : end + 1]
            headers = {
                "Content-Range": f"bytes {start}-{end}/{total}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(len(chunk)),
                "Content-Type": "video/mp4",
            }
            return StreamingResponse(iter([chunk]), status_code=206, headers=headers)
    headers = {
        "Content-Length": str(total),
        "Accept-Ranges": "bytes",
        "Content-Type": "video/mp4",
    }
    return StreamingResponse(iter([data]), headers=headers)


@app.get("/api/route/{cid}")
def route(cid: int, max_points: int = 800):
    chtags = config.table("channel_tags")
    channels = config.table("channels")
    sql = f"""
    WITH lat_ch AS (
      SELECT channel_id FROM {chtags}
      WHERE container_id = :cid AND key = 'channel_name' AND value = 'latitude_degree'
    ),
    lon_ch AS (
      SELECT channel_id FROM {chtags}
      WHERE container_id = :cid AND key = 'channel_name' AND value = 'longitude_degree'
    ),
    lat AS (
      SELECT timestamp AS ts, value AS lat FROM {channels}
      WHERE container_id = :cid AND channel_id = (SELECT channel_id FROM lat_ch)
    ),
    lon AS (
      SELECT timestamp AS ts, value AS lon FROM {channels}
      WHERE container_id = :cid AND channel_id = (SELECT channel_id FROM lon_ch)
    ),
    joined AS (
      SELECT lat.ts, lat.lat, lon.lon FROM lat JOIN lon ON lat.ts = lon.ts
      WHERE lat.lat IS NOT NULL AND lon.lon IS NOT NULL
    ),
    numbered AS (
      SELECT ts, lat, lon, row_number() OVER (ORDER BY ts) AS rn,
             count(*) OVER () AS total
      FROM joined
    )
    SELECT lat, lon, ts FROM numbered
    WHERE rn % greatest(cast(total / :maxp AS INT), 1) = 0
    ORDER BY ts
    """
    rows = query(sql, {"cid": int(cid), "maxp": int(max_points)})
    return [
        [float(r["lat"]), float(r["lon"]), int(r["ts"])]
        for r in rows
        if r["lat"] is not None and r["lon"] is not None
    ]


# --------------------------------------------------------------------------- #
# Event deep dive: report definition, signals, markers, camera frames
# --------------------------------------------------------------------------- #
def _channel_names(cid: int) -> set[str]:
    rows = query(f"SELECT DISTINCT value FROM {config.table('channel_tags')} "
                 "WHERE container_id = :cid AND key = 'channel_name'", {"cid": int(cid)})
    return {r["value"] for r in rows}


@app.get("/api/events/{cid}/{eiid}/report")
def event_report(cid: int, eiid: int):
    """Event-specific panels + KPI definitions (restricted to channels present for this drive)."""
    rows = query(f"""
      SELECT e.event_name, e.event_description FROM {config.table('event_instance_fact')} f
      JOIN {config.table('event_dimension')} e ON f.event_id = e.event_id
      WHERE f.container_id = :cid AND f.event_instance_id = :eiid
    """, {"cid": int(cid), "eiid": int(eiid)})
    if not rows:
        raise HTTPException(404, "event instance not found")
    rep = build_report(rows[0]["event_name"], _channel_names(cid))
    return {"event_name": rows[0]["event_name"], "event_description": rows[0]["event_description"], **rep}


def _series(cid: int, names: list[str], a_us: int, b_us: int, max_points: int) -> dict[str, dict]:
    """RAW samples (timestamp µs, value) per channel in [a, b], evenly thinned to <= max_points."""
    if not names:
        return {}
    keys = [f"n{i}" for i in range(len(names))]
    params = {"cid": int(cid), "a": int(a_us), "b": int(b_us), "maxp": int(max_points), **dict(zip(keys, names))}
    rows = query(f"""
      WITH s AS (
        SELECT t.value AS name, c.timestamp AS ts, c.value AS v
        FROM {config.table('channels')} c
        JOIN {config.table('channel_tags')} t
          ON t.container_id = c.container_id AND t.channel_id = c.channel_id AND t.key = 'channel_name'
        WHERE c.container_id = :cid AND t.value IN ({', '.join(':' + k for k in keys)})
          AND c.timestamp BETWEEN :a AND :b
      ),
      n AS (
        SELECT name, ts, v, row_number() OVER (PARTITION BY name ORDER BY ts) AS rn,
               count(*) OVER (PARTITION BY name) AS total
        FROM s
      )
      SELECT name, ts, v FROM n
      WHERE rn % greatest(cast(ceil(total / :maxp) AS INT), 1) = 0 OR rn = 1 OR rn = total
      ORDER BY name, ts
    """, params)
    out: dict[str, dict] = {n: {"name": n, "t": [], "v": []} for n in names}
    for r in rows:
        s = out[r["name"]]
        s["t"].append(int(r["ts"]) / US)
        s["v"].append(float(r["v"]) if r["v"] is not None else None)
    return out


def _thw(dist: dict, speed: dict) -> dict:
    """Time headway [s] = in-path lead distance / ego speed, sampled at the distance timestamps
    (as-of join on speed; undefined below 1 km/h)."""
    t_out, v_out, j = [], [], -1
    st, sv = speed["t"], speed["v"]
    for t, d in zip(dist["t"], dist["v"]):
        while j + 1 < len(st) and st[j + 1] <= t:
            j += 1
        v_kmh = sv[j] if j >= 0 else None
        t_out.append(t)
        v_out.append(d / (v_kmh / 3.6) if d is not None and v_kmh is not None and v_kmh > 1.0 else None)
    return {"t": t_out, "v": v_out}


@app.get("/api/containers/{cid}/timeseries")
def timeseries(cid: int, channels: str, start_s: float, end_s: float, max_points: int = 4000):
    """Signals for the deep dive, clipped to [start_s, end_s] (epoch seconds). Supports derived:* channels."""
    names = _split_csv(channels)[:30]
    silver = {n for n in names if not n.startswith("derived:")}
    for n in names:
        silver.update(DERIVED.get(n, ()))
    raw = _series(cid, sorted(silver), int(start_s * US), int(end_s * US), max(100, min(int(max_points), 20000)))
    units = _channel_units(cid)
    out = []
    for n in names:
        if n == "derived:thw_s":
            d, sp = DERIVED[n]
            s = _thw(raw.get(d, {"t": [], "v": []}), raw.get(sp, {"t": [], "v": []}))
            out.append({"name": n, "unit": "s", **s})
        else:
            s = raw.get(n, {"t": [], "v": []})
            out.append({"name": n, "unit": units.get(n) or "", "t": s["t"], "v": s["v"]})
    return {"channels": out, "start_s": start_s, "end_s": end_s}


@app.get("/api/containers/{cid}/markers")
def markers(cid: int):
    """Recording bounds + every event instance of this drive (context markers on the timeline)."""
    rec = query(f"SELECT min(timestamp) AS a, max(timestamp) AS b FROM {config.table('channels')} "
                "WHERE container_id = :cid", {"cid": int(cid)})[0]
    inst = query(f"""
      SELECT e.event_name, f.event_instance_id, f.start_ts, f.end_ts FROM {config.table('event_instance_fact')} f
      JOIN {config.table('event_dimension')} e ON f.event_id = e.event_id
      WHERE f.container_id = :cid ORDER BY f.start_ts
    """, {"cid": int(cid)})
    return {
        "recording": {"start_s": int(rec["a"]) / US if rec["a"] is not None else None,
                      "end_s": int(rec["b"]) / US if rec["b"] is not None else None},
        "instances": [{"event_name": r["event_name"], "event_instance_id": str(r["event_instance_id"]),
                       "start_s": int(r["start_ts"]) / US, "end_s": int(r["end_ts"]) / US} for r in inst],
    }


# A2D2 units are A2D2 enum names (Unit_KiloMeterPerHour, ...) -> readable symbols.
_UNIT_NAMES = {
    "Unit_KiloMeterPerHour": "km/h", "Unit_MeterPerSeconSquar": "m/s²", "Unit_MeterPerSecondSquared": "m/s²",
    "Unit_Bar": "bar", "Unit_DegreOfArc": "deg", "Unit_DegreOfArcPerSecon": "deg/s", "Unit_PerCent": "%",
    "Unit_Meter": "m",
}


def _pretty_unit(u: str | None) -> str:
    if not u:
        return ""
    return _UNIT_NAMES.get(u, u.replace("Unit_", "") if u.startswith("Unit_") else u)


def _channel_units(cid: int) -> dict[str, str]:
    """channel_name -> unit from channel_tags (A2D2's channel_metrics carries neither)."""
    rows = query(f"""
      SELECT n.value AS channel_name, u.value AS unit FROM {config.table('channel_tags')} n
      LEFT JOIN {config.table('channel_tags')} u
        ON u.container_id = n.container_id AND u.channel_id = n.channel_id AND u.key = 'unit'
      WHERE n.container_id = :cid AND n.key = 'channel_name'
    """, {"cid": int(cid)})
    return {r["channel_name"]: _pretty_unit(r["unit"]) for r in rows}


@app.get("/api/containers/{cid}/channels")
def channel_catalog(cid: int, q: str = "", limit: int = 60):
    rows = query(f"""
      SELECT n.value AS channel_name, u.value AS unit, m.sample_count, m.min, m.max
      FROM {config.table('channel_tags')} n
      LEFT JOIN {config.table('channel_tags')} u
        ON u.container_id = n.container_id AND u.channel_id = n.channel_id AND u.key = 'unit'
      LEFT JOIN {config.table('channel_metrics')} m
        ON m.container_id = n.container_id AND m.channel_id = n.channel_id
      WHERE n.container_id = :cid AND n.key = 'channel_name' AND lower(n.value) LIKE :q
      ORDER BY n.value LIMIT {max(1, min(int(limit), 200))}
    """, {"cid": int(cid), "q": f"%{q.lower()}%"})
    for r in rows:
        r["unit"] = _pretty_unit(r["unit"])
    return [{**r, "min": float(r["min"]) if r["min"] is not None else None,
             "max": float(r["max"]) if r["max"] is not None else None} for r in rows]


_FRAME_CACHE: dict[str, bytes] = {}
_FRAME_CACHE_MAX = 400


def _read_volume_bytes_uncached(path: str) -> bytes:
    try:
        return Path(path).read_bytes()
    except Exception:  # noqa: BLE001 — Apps have no FUSE: use the Files API
        from databricks.sdk import WorkspaceClient
        return WorkspaceClient().files.download(path).contents.read()  # type: ignore[union-attr]


FRAME_WIDTH = 960  # A2D2 frames are 1920x1208 PNGs (~3.5 MB) -> ~100 KB JPEG for scrubbing


def _frame_jpeg(path: str) -> bytes:
    """Downscaled JPEG of a camera frame (cached), so hover-scrubbing stays responsive."""
    key = f"jpg:{path}"
    if key in _FRAME_CACHE:
        return _FRAME_CACHE[key]
    import io
    from PIL import Image

    src = _read_volume_bytes_uncached(path)
    im = Image.open(io.BytesIO(src)).convert("RGB")
    if im.width > FRAME_WIDTH:
        im = im.resize((FRAME_WIDTH, round(im.height * FRAME_WIDTH / im.width)))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=80)
    out = buf.getvalue()
    if len(_FRAME_CACHE) >= _FRAME_CACHE_MAX:
        _FRAME_CACHE.pop(next(iter(_FRAME_CACHE)))
    _FRAME_CACHE[key] = out
    return out


_FRAME_INDEX: dict[int, tuple[list[int], list[str]]] = {}


def _frame_index(cid: int) -> tuple[list[int], list[str]]:
    """(sorted cam_tstamp_us, png_path) of a drive, loaded once (~20k rows) so scrubbing needs no SQL."""
    if cid not in _FRAME_INDEX:
        rows = query(f"SELECT cam_tstamp_us, png_path FROM {config.table('camera_frames')} "
                     "WHERE container_id = :cid ORDER BY cam_tstamp_us", {"cid": int(cid)})
        _FRAME_INDEX[cid] = ([int(r["cam_tstamp_us"]) for r in rows], [r["png_path"] for r in rows])
    return _FRAME_INDEX[cid]


@app.get("/api/containers/{cid}/frame")
def camera_frame(cid: int, t: float):
    """Front-camera frame nearest to epoch second `t` (within 2 s), for events without an MP4 clip."""
    import bisect

    ts = int(t * US)
    times, paths = _frame_index(int(cid))
    i = bisect.bisect_left(times, ts)
    cand = [j for j in (i - 1, i) if 0 <= j < len(times)]
    if not cand:
        raise HTTPException(404, "no camera frames for this drive")
    j = min(cand, key=lambda k: abs(times[k] - ts))
    if abs(times[j] - ts) > 2 * US:
        raise HTTPException(404, "no camera frame near this time")
    rows = [{"png_path": paths[j], "cam_tstamp_us": times[j]}]
    path = rows[0]["png_path"]
    root = f"/Volumes/{config.CATALOG}/{config.SCHEMA}/{config.VOLUME}/"
    if not str(path).startswith(root):
        raise HTTPException(400, "frame outside the configured volume")
    data = _frame_jpeg(path)
    return Response(data, media_type="image/jpeg", headers={
        "Cache-Control": "private, max-age=3600",
        "X-Frame-Time": str(int(rows[0]["cam_tstamp_us"]) / US),
    })


# --------------------------------------------------------------------------- #
# Static SPA (must be mounted last so /api/* wins).
# --------------------------------------------------------------------------- #
_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="spa")
