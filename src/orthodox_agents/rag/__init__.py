from pathlib import Path
import os
import sys

# Point at your repo’s root (or wherever your vectorstore dir lives)
PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

from pathlib import Path

from langchain_openai import OpenAIEmbeddings
from langchain_chroma import Chroma


# Build the embedding model
_embeddings = OpenAIEmbeddings(
    model="text-embedding-3-large",
)

# Re-instantiate the Chroma store you already persisted
_vectordb = Chroma(
    embedding_function=_embeddings,
    persist_directory=str(PACKAGE_ROOT / "vectorstores" / "chroma_db_openai"),
    collection_name="athanasios-muthlinaios",
)

def get_openai_retriever(k: int = 5):
    """
    Returns a LangChain Retriever over our OpenAI-backed Chroma DB.
    
    :param k: number of docs to return per query
    """
    return _vectordb.as_retriever(
        search_kwargs={"k": k}
    )



