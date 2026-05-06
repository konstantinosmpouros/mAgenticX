import re
from pathlib import Path

from chromadb.config import Settings as ChromaSettings
from langchain_openai import OpenAIEmbeddings

import duckdb
import pandas as pd
from observability import get_logger
from core.settings import settings

logger = get_logger(__name__)

# --------------------------------------------------------------------------------------
# Excel db setup
# --------------------------------------------------------------------------------------
DATA_DIR = Path("data")

db = duckdb.connect(database=":memory:")
TABLES: dict[str, dict] = {}  # table_name -> metadata (file path, columns)

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


# --------------------------------------------------------------------------------------
# RAG setup
# --------------------------------------------------------------------------------------
_openai_key = settings.api_keys.openai
embeddings_model = OpenAIEmbeddings(
    model="text-embedding-3-large",
    api_key=_openai_key.get_secret_value() if _openai_key else None,
)

chroma_settings = ChromaSettings(
    chroma_api_impl="rest",
    chroma_server_host=settings.rag.host,
    chroma_server_http_port=str(settings.rag.port),
)
