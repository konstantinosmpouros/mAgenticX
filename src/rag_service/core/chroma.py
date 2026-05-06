from chromadb.config import Settings as ChromaSettings
from langchain_openai import OpenAIEmbeddings

from core.settings import settings

_openai_key = settings.api_keys.openai
embeddings_model = OpenAIEmbeddings(
    model="text-embedding-3-large",
    api_key=_openai_key.get_secret_value() if _openai_key else None,
)

chroma_settings = ChromaSettings(
    chroma_api_impl="rest",
    chroma_server_host=settings.rag.host,
    chroma_server_http_port=settings.rag.port,
)
