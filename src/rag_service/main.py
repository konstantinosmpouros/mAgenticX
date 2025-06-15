import os

from schemas import Query
from fastapi import FastAPI, HTTPException

import chromadb
from chromadb.config import Settings
from langchain_chroma import Chroma
from langchain_openai import OpenAIEmbeddings
from langchain.schema import Document

# import duckdb
# import pandas as pd


app = FastAPI()


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
            {"Content": d.page_content, "Metadata": d.metadata} for d in docs
        ],
    }





