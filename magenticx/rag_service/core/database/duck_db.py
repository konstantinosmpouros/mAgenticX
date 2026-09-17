"""Excel workbooks → in-memory DuckDB tables, registered once at import.

The tabular half of retrieval: every workbook in ``data/`` becomes one read-only
table, and ``TABLES`` is the allowlist the Excel endpoints check a requested
table against. The connection is locked down here rather than per query — see the
comment below — so the read-only posture cannot be relaxed at runtime.
"""
import re
from pathlib import Path

import duckdb
import pandas as pd
from core.logging import get_logger

logger = get_logger(__name__)

DATA_DIR = Path("data")

db = duckdb.connect(
    database=":memory:",
    config={
        "enable_external_access": "false",
        "allow_unsigned_extensions": "false",
    },
)
# Defense-in-depth, applied post-connect (these are rejected inside connect()'s
# config): block all filesystem access, then freeze the configuration so the
# read-only posture cannot be relaxed at runtime even if a setting is flipped.
# lock_configuration must come last — once set, no further SET is permitted.
db.execute("SET disabled_filesystems='LocalFileSystem'")
db.execute("SET lock_configuration=true")
TABLES: dict[str, dict] = {}

if not DATA_DIR.exists():
    raise FileNotFoundError(f"DATA_DIR '{DATA_DIR}' does not exist – create it and add Excel files.")

for file_path in DATA_DIR.iterdir():
    if file_path.suffix.lower() in {".xlsx", ".xls", ".xlsm"} and file_path.is_file():
        raw_name = file_path.stem
        safe_name = re.sub(r"\W+", "_", raw_name).strip("_").lower()
        try:
            df = pd.read_excel(file_path, sheet_name=0)
        except Exception as exc:
            logger.warning("workbook_load_skipped", "Failed to read workbook; skipping it", workbook_name=file_path.name, error=str(exc))
            continue

        db.register(safe_name, df)
        TABLES[safe_name] = {
            "table_name": safe_name,
            "schema": {col: str(dtype) for col, dtype in df.dtypes.items()},
        }
        logger.info("workbook_loaded", "Workbook registered in DuckDB", workbook_name=file_path.name, table_name=safe_name, column_count=len(df.columns), row_count=len(df))

if not TABLES:
    raise RuntimeError("No Excel workbooks were successfully loaded from 'data/'.")
