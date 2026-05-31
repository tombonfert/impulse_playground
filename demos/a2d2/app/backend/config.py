"""Runtime configuration for the A2D2 event-explorer app.

All values come from environment variables that app.yaml injects (warehouse
http_path / id, UC catalog/schema, table prefix, volume). Falls back to sane
defaults pinned at mda_demo.a2d2_demo so the app always targets the real data
even though the demo jobs default their `catalog` var to `main`.
"""
import os


# --- Unity Catalog location (pinned to the real data, NOT the jobs' default) ---
CATALOG = os.environ.get("A2D2_CATALOG", "mda_demo")
SCHEMA = os.environ.get("A2D2_SCHEMA", "a2d2_demo")
TABLE_PREFIX = os.environ.get("A2D2_TABLE_PREFIX", "a2d2")
VOLUME = os.environ.get("A2D2_VOLUME", "a2d2_raw")

# --- SQL warehouse ---
# Databricks Apps inject the resource as DATABRICKS_WAREHOUSE_ID (valueFrom) and
# we also accept an explicit http_path. Either is enough to build the path.
WAREHOUSE_ID = os.environ.get("DATABRICKS_WAREHOUSE_ID") or os.environ.get("A2D2_WAREHOUSE_ID", "")
_http_path = os.environ.get("A2D2_WAREHOUSE_HTTP_PATH", "")
if not _http_path and WAREHOUSE_ID:
    _http_path = f"/sql/1.0/warehouses/{WAREHOUSE_ID}"
WAREHOUSE_HTTP_PATH = _http_path

# Sub-folder inside the volume that holds the analysis MP4 clips.
CLIPS_SUBDIR = "a2d2_analysis"


def table(name: str) -> str:
    """Fully-qualified UC table name for a logical table, e.g. table('channels')."""
    return f"{CATALOG}.{SCHEMA}.{TABLE_PREFIX}_{name}"


def clips_dir() -> str:
    return f"/Volumes/{CATALOG}/{SCHEMA}/{VOLUME}/{CLIPS_SUBDIR}"
