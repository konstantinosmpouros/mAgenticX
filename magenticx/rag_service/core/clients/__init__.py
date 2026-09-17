"""Outbound API client factories (OpenAI embeddings, ChromaDB).

One module per external provider so credentials/config wiring lives in one
place per client. Re-exported so callers keep the stable
``from core.clients import ...`` import surface regardless of how the package
is split internally.
"""
from core.clients.chroma import chroma_settings
from core.clients.openai import embeddings_model

__all__ = ["chroma_settings", "embeddings_model"]
