import os
import re
from pathlib import Path

from chromadb.config import Settings
from langchain_openai import OpenAIEmbeddings

import duckdb
import pandas as pd

# --------------------------------------------------------------------------------------
# Excel db Configs
# --------------------------------------------------------------------------------------
DATA_DIR = Path("data")

db = duckdb.connect(database=":memory:")
TABLES: dict[str, dict] = {}  # table_name -> metadata (file path, columns)

if not DATA_DIR.exists():
    raise FileNotFoundError(f"DATA_DIR '{DATA_DIR}' does not exist – create it and add Excel files.")

for file_path in DATA_DIR.iterdir():
    if file_path.suffix.lower() in {".xlsx", ".xls", ".xlsm"} and file_path.is_file():
        # Sanitise table name: "Financial Sample.xlsx" ➜ "financial_sample"
        raw_name = file_path.stem
        safe_name = re.sub(r"\W+", "_", raw_name).strip("_").lower()
        try:
            df = pd.read_excel(file_path, sheet_name=0)  # first sheet only
        except Exception as exc:
            print(f"[WARN] Could not read {file_path.name}: {exc}")
            continue
            
        db.register(safe_name, df)
        TABLES[safe_name] = {
            "table_name": safe_name,
            "schema": {col: str(dtype) for col, dtype in df.dtypes.items()},
        }

if not TABLES:
    raise RuntimeError("No Excel workbooks were successfully loaded from 'data/'.")


# --------------------------------------------------------------------------------------
# RAG Configs
# --------------------------------------------------------------------------------------
RAG_HOST = os.getenv("RAG_HOST")
RAG_PORT = os.getenv("RAG_PORT")
embeddings_model = OpenAIEmbeddings(model='text-embedding-3-large', api_key=os.getenv("OPENAI_API_KEY"))
settings = Settings(
    chroma_api_impl="rest",
    chroma_server_host=RAG_HOST,
    chroma_server_http_port=RAG_PORT
)
