"""Delta access via the Databricks SQL connector.

The app authenticates as its service principal using databricks.sdk.core.Config
(OAuth in the Apps runtime; profile/CLI locally). The connection is cached and
lazily (re)created. All caller SQL is parameterized.
"""
from __future__ import annotations

import threading
from typing import Any

from databricks import sql as dbsql
from databricks.sdk.core import Config

from . import config


_cfg = Config()  # picks up Apps env (OAuth) or local profile
_lock = threading.Lock()
_conn = None


def _credentials_provider():
    # databricks-sql-connector wants a callable returning a header provider.
    return _cfg.authenticate


def _get_conn():
    global _conn
    with _lock:
        if _conn is not None:
            try:
                # cheap liveness check
                with _conn.cursor() as c:
                    c.execute("SELECT 1")
                    c.fetchone()
                return _conn
            except Exception:
                try:
                    _conn.close()
                except Exception:
                    pass
                _conn = None
        if not config.WAREHOUSE_HTTP_PATH:
            raise RuntimeError(
                "No SQL warehouse configured (set DATABRICKS_WAREHOUSE_ID or "
                "A2D2_WAREHOUSE_HTTP_PATH)."
            )
        _conn = dbsql.connect(
            server_hostname=_cfg.host.replace("https://", "").replace("http://", ""),
            http_path=config.WAREHOUSE_HTTP_PATH,
            credentials_provider=_credentials_provider,
        )
        return _conn


def query(sql: str, params: dict[str, Any] | None = None) -> list[dict]:
    """Run a parameterized query and return rows as dicts."""
    conn = _get_conn()
    with conn.cursor() as cur:
        cur.execute(sql, params or {})
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchall()
        return [dict(zip(cols, r)) for r in rows]
