"""Embedding-proxy DTOs: the bridge has no OpenAI key of its own, so it embeds
text batches through this service."""
from typing import List
from pydantic import BaseModel


class EmbedRequest(BaseModel):
    """Bridge → agents: a batch of texts to embed. The bridge has no OpenAI key
    of its own, so it proxies embedding through this service (same pattern as
    realtime voice). Order is preserved: response.embeddings[i] ↔ texts[i]."""
    texts: List[str]


class EmbedResponse(BaseModel):
    """One embedding vector per input text, plus the model + dimensions used."""
    embeddings: List[List[float]]
    model: str
    dimensions: int
