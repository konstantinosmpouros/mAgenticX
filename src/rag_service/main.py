from config import RAG_HOST, RAG_PORT, settings, embeddings_model
from config import TABLES, db
from schemas import Query, ExcelSQLQuery

from fastapi import FastAPI, HTTPException

import chromadb
from langchain_chroma import Chroma
from langchain.schema import Document
import duckdb


# Initialize FastAPI server
app = FastAPI()


# -----------------------------------------------------------------------------
# Convenience root endpoint
# -----------------------------------------------------------------------------
@app.get("/")
async def root():
    return {
        "message": "All APIs are up! See /docs for Swagger UI.",
        "endpoints": {
            "/excel": "",
            "/excel/{table}/schema": "",
            "/excel/{table}/unique/{column}": "",
            "/retrieve/{collection_name}": "",
        },
    }


# --------------------------------------------------------------------------------------
# RAG APIs
# --------------------------------------------------------------------------------------
@app.post("/retrieve/{collection_name}")
async def retrieve(request: Query, collection_name: str):
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
    docs: list[Document] = await retriever.ainvoke(request.query)
    if not docs:
        raise HTTPException(status_code=404, detail="No documents found")
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
@app.get("/excel")
async def list_tables():
    """List all loaded Excel workbooks and their columns."""

    return [
        {"table": t, **meta}
        for t, meta in TABLES.items()
    ]


@app.get("/excel/{table}/schema")
async def get_schema(table: str):
    """Return column names and DuckDB types so the agent can reason about them."""

    description = db.execute(f"DESCRIBE {table}").fetchall()
    return [
        {"column": col, "type": dtype}
        for col, dtype, *_ in description
    ]


@app.get("/excel/{table}/unique/{column}")
async def get_unique(table: str, column: str):
    """Return distinct values of *column* in *table* - handy for filters."""
    if not table in TABLES.keys():
        raise HTTPException(status_code=404, detail=f"Table '{table}' not found. Available tables: {list(TABLES)}")
    
    cols = [c[0] for c in db.execute(f"DESCRIBE {duckdb.escape_identifier(table)}").fetchall()]
    if column not in cols:
        raise HTTPException(status_code=400, detail="Invalid column name")
    
    rows = db.execute(
        f"SELECT DISTINCT {duckdb.escape_identifier(column)} FROM {duckdb.escape_identifier(table)}"
    ).fetchall()
    return [r[0] for r in rows]


@app.post("/excel/{table}/query/sql")
async def query_sql(table: str, body: ExcelSQLQuery):
    """Run arbitrary SQL and return result rows as JSON. The SQL *must* reference the table name provided in the path parameter."""

    if not table in TABLES.keys():
        raise HTTPException(status_code=404, detail=f"Table '{table}' not found. Available tables: {list(TABLES)}")
    try:
        df = db.execute(body.sql).fetch_df()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "row_count": len(df),
        "data": df.to_dict(orient="records"),
        "sql": body.sql,
    }



