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
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .db import query

app = FastAPI(title="Impulse Event Explorer")

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
    except Exception:
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
             e.event_name, e.event_type,
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
      ev.container_id, ev.event_instance_id, ev.event_name, ev.event_type,
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
        r["event_instance_id"] = int(r["event_instance_id"])
        r["container_id"] = int(r["container_id"])
        r["lat"] = float(r["lat"]) if r["lat"] is not None else None
        r["lon"] = float(r["lon"]) if r["lon"] is not None else None
        r["has_clip"] = _clip_name(r["event_name"], r["container_id"], r["event_instance_id"]) in clips
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


def _safe_clip_path(cid: int, eiid: int, event_name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_]+", event_name):
        raise HTTPException(400, "bad event_name")
    name = _clip_name(event_name, int(cid), int(eiid))
    return Path(config.clips_dir()) / name


@app.get("/api/events/{cid}/{eiid}/clip")
def event_clip(cid: int, eiid: int, event_name: str, request: Request):
    path = _safe_clip_path(cid, eiid, event_name)
    data: bytes | None = None
    # Prefer direct FUSE read; fall back to SDK Files API.
    try:
        data = path.read_bytes()
    except Exception:
        try:
            from databricks.sdk import WorkspaceClient

            w = WorkspaceClient()
            resp = w.files.download(str(path))
            data = resp.contents.read()  # type: ignore[union-attr]
        except Exception as e:  # noqa: BLE001
            raise HTTPException(404, f"clip not found: {e}")
    if data is None:
        raise HTTPException(404, "clip not found")

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
# Static SPA (must be mounted last so /api/* wins).
# --------------------------------------------------------------------------- #
_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="spa")
