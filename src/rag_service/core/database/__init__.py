"""The service's data layer — the in-memory DuckDB catalogue behind the Excel API.

One module today (``duck_db``), kept in a package so the tabular side has a home
of its own instead of sitting loose in ``core/``, mirroring
``dialogue_bridge/core/database``. Re-exported so callers use
``from core.database import ...`` regardless of how the package is split later.

Importing this package **loads the workbooks** — ``duck_db`` registers every
sheet in ``data/`` at import time — so it is deliberately imported once, from
``main.py``, rather than lazily from a request path.
"""
from core.database.duck_db import TABLES, db

__all__ = ["TABLES", "db"]
