from pathlib import Path

from langchain.embeddings import OpenAIEmbeddings
from langchain.vectorstores import Chroma


# Point at your repo’s root (or wherever your vectorstore dir lives)
ROOT = Path(__file__).parent.parent

# 1) Build the embedding model
_embeddings = OpenAIEmbeddings(
    model="text-embedding-3-large",   # or whichever OpenAI embedding model you prefer
)

# 2) Re-instantiate the Chroma store you already persisted
_vectordb = Chroma(
    embedding_function=_embeddings,
    persist_directory=str(ROOT / "vectorstore" / "chroma_db_openai"),
    collection_name="athanasios-muthlinaios",  # whatever name you used
)

def get_openai_retriever(k: int = 5):
    """
    Returns a LangChain Retriever over our OpenAI‐backed Chroma DB.
    
    :param k: number of docs to return per query
    """
    return _vectordb.as_retriever(
        search_kwargs={"k": k}
    )



