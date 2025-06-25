from fastapi import FastAPI, HTTPException

import chromadb
from langchain_chroma import Chroma
from langchain.schema import Document

from config import RAG_HOST, RAG_PORT, settings, embeddings_model
from config import TABLES, db
from schemas import Query, ExcelSQLQuery


# Initialize FastAPI server
app = FastAPI()


# --------------------------------------------------------------------------------------
# RAG APIs
# --------------------------------------------------------------------------------------
@app.post("/retrieve/{collection_name}")
async def retrieve(request: Query, collection_name: str):
    """Retrieve documents from the specified collection using the provided query and k value."""
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
@app.get("/excel/{table}/schema")
async def get_schema(table: str):
    """Return column names and DuckDB types so the agent can reason about them."""
    
    description = db.execute(f"DESCRIBE {table}").fetchall()
    return [
        {"column": col, "type": dtype}
        for col, dtype, *_ in description
    ]


@app.post("/excel/{table}/query/sql")
async def query_sql(body: ExcelSQLQuery, table: str):
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
    }



