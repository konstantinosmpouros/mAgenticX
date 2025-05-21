import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import chromadb
from chromadb.config import Settings
from langchain_chroma import Chroma

from langchain_openai import OpenAIEmbeddings
from langchain.schema import Document


app = FastAPI()

class Query(BaseModel):
    query: str
    k: int = 10

RAG_HOST = os.getenv("RAG_HOST")
RAG_PORT = os.getenv("RAG_PORT")
COLLECTION_NAME = os.getenv("COLLECTION_NAME")
embeddings_model = OpenAIEmbeddings(model='text-embedding-3-large', api_key=os.getenv("OPENAI_API_KEY"))

settings = Settings(
    chroma_api_impl="rest",
    chroma_server_host=RAG_HOST,
    chroma_server_http_port=RAG_PORT
)


@app.post("/retrieve")
async def retrieve(request: Query):
    client = chromadb.HttpClient(
        host=RAG_HOST,
        port=int(RAG_PORT),
        settings=settings
    )
    vectordb = Chroma(
        client=client,
        collection_name=COLLECTION_NAME,
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
            {"text": d.page_content, "metadata": d.metadata} for d in docs
        ],
    }
