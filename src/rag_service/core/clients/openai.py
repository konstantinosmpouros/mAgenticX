"""OpenAI embeddings client used for Chroma vector retrieval.

Built once at import time from the configured API key so every retrieval path
shares the same embeddings client (and the key is read from settings in
exactly one place).
"""
from langchain_openai import OpenAIEmbeddings

from core.settings import settings

_openai_key = settings.api_keys.openai
embeddings_model = OpenAIEmbeddings(
    model="text-embedding-3-large",
    **({"api_key": _openai_key.get_secret_value()} if _openai_key else {}),
)
