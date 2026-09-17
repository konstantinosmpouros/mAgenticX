"""ChromaDB client configuration for the vector store connection.

The REST client settings point at the ``vectordb`` service; consumed by
``main.py`` when constructing the Chroma HTTP client at startup.
"""
from chromadb.config import Settings as ChromaSettings

from core.settings import settings

chroma_settings = ChromaSettings(
    chroma_api_impl="rest",
    chroma_server_host=settings.rag.host,
    chroma_server_http_port=settings.rag.port,
)
