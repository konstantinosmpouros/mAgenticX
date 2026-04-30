from contextlib import asynccontextmanager
from pathlib import Path
import os
import re
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

from fastapi import Depends, FastAPI, HTTPException

import chromadb
from langchain_chroma import Chroma
from langchain_core.documents import Document

from observability import (
    RequestLoggingMiddleware,
    configure_logging,
    get_logger,
    register_exception_handlers,
)

configure_logging()
logger = get_logger(__name__)

from config import RAG_HOST, RAG_PORT, settings, embeddings_model
from config import TABLES, db
from core.error_handling import rag_operation_error_handler
from core.proxy import require_internal_caller
from schemas import Query, ExcelSQLQuery


_FORBIDDEN_SQL_TOKENS = re.compile(
    r"\b(insert|update|delete|drop|create|alter|truncate|copy|attach|detach|pragma|vacuum|call|execute)\b",
    re.IGNORECASE,
)


def _validate_read_only_sql(sql: str, table: str) -> str:
    cleaned = (sql or "").strip()
    cleaned = cleaned[:-1].strip() if cleaned.endswith(";") else cleaned
    if not cleaned:
        raise HTTPException(status_code=400, detail="SQL query is required.")
    if ";" in cleaned:
        raise HTTPException(status_code=400, detail="Only a single read-only SQL statement is allowed.")

    first_token = cleaned.split(None, 1)[0].lower()
    if first_token not in {"select", "with"}:
        raise HTTPException(status_code=400, detail="Only read-only SELECT queries are allowed.")
    if _FORBIDDEN_SQL_TOKENS.search(cleaned):
        raise HTTPException(status_code=400, detail="Only read-only SELECT queries are allowed.")
    if not re.search(rf"\b{re.escape(table)}\b", cleaned, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="SQL query must reference the requested table.")
    return cleaned


@asynccontextmanager
async def _lifespan(app: FastAPI):
    logger.info("service_startup", "RAG service startup initiated", loaded_tables=len(TABLES))
    yield
    logger.info("service_shutdown", "RAG service shutdown completed")


# Initialize FastAPI server
app = FastAPI(lifespan=_lifespan, title="RAG Service")
register_exception_handlers(app)
app.add_middleware(RequestLoggingMiddleware)


# --------------------------------------------------------------------------------------
# RAG APIs
# --------------------------------------------------------------------------------------
@app.post("/retrieve/{collection_name}", dependencies=[Depends(require_internal_caller)])
async def retrieve(request: Query, collection_name: str):
    """Retrieve documents from the specified collection using the provided query and k value."""
    logger.info("retrieval_started", "Vector retrieval started", collection_name=collection_name, k=request.k, query_length=len(request.query.strip()))
    client = chromadb.HttpClient(
        host=RAG_HOST,
        port=int(RAG_PORT),
        settings=settings
    )
    vectordb = Chroma(
        client=client,
        collection_name=collection_name,
        embedding_function=embeddings_model,
    )
    
    retriever = vectordb.as_retriever(search_kwargs={"k": request.k})
    try:
        docs: list[Document] = await retriever.ainvoke(request.query)
    except Exception as exc:
        rag_operation_error_handler.raise_dependency_error(
            logger,
            exc,
            event="retrieval_failed",
            message="Vector retrieval failed",
            public_detail="Document retrieval is temporarily unavailable. Please try again.",
            collection_name=collection_name,
            k=request.k,
        )
    if not docs:
        logger.warning("retrieval_no_results", "Vector retrieval returned no documents", collection_name=collection_name, k=request.k)
        raise HTTPException(status_code=404, detail="No documents found")
    logger.info("retrieval_completed", "Vector retrieval completed", collection_name=collection_name, k=request.k, document_count=len(docs))
    return {
        "query": request.query,
        "k": request.k,
        "documents": [
            {"content": d.page_content, "metadata": d.metadata} for d in docs
        ],
    }


# --------------------------------------------------------------------------------------
# Excel db APIs
# --------------------------------------------------------------------------------------
@app.get("/excel/{table}/schema", dependencies=[Depends(require_internal_caller)])
async def get_schema(table: str):
    """Return column names and DuckDB types so the agent can reason about them."""
    if table not in TABLES:
        logger.warning("schema_table_not_found", "Schema requested for unknown table", table=table)
        raise HTTPException(status_code=404, detail="Table not found.")

    description = db.execute(f"DESCRIBE {table}").fetchall()
    logger.info("schema_served", "DuckDB schema served", table=table, column_count=len(description))
    return [
        {"column": col, "type": dtype}
        for col, dtype, *_ in description
    ]


@app.post("/excel/{table}/query/sql", dependencies=[Depends(require_internal_caller)])
async def query_sql(body: ExcelSQLQuery, table: str):
    """Run arbitrary SQL and return result rows as JSON. The SQL *must* reference the table name provided in the path parameter."""
    logger.info("sql_query_started", "DuckDB SQL query started", table=table, sql_length=len(body.sql))
    if not table in TABLES.keys():
        logger.warning("sql_table_not_found", "SQL query requested for unknown table", table=table)
        raise HTTPException(status_code=404, detail="Table not found.")
    sql = _validate_read_only_sql(body.sql, table)
    try:
        df = db.execute(sql).fetch_df()
    except Exception as exc:
        rag_operation_error_handler.raise_bad_request(
            logger,
            exc,
            event="sql_query_failed",
            message="DuckDB SQL query failed",
            public_detail="The SQL query could not be completed. Please check the query and try again.",
            table=table,
        )

    logger.info("sql_query_completed", "DuckDB SQL query completed", table=table, row_count=len(df), column_count=len(df.columns))
    return {
        "row_count": len(df),
        "data": df.to_dict(orient="records"),
    }
