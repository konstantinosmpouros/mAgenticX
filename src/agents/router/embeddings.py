"""Internal embedding endpoint.

The dialogue_bridge has no OpenAI key of its own — it proxies OpenAI work
through this service (the same way it proxies realtime voice). Conversation
message embeddings for the bridge's pgvector store are therefore generated here
and returned over the internal mTLS hop. The endpoint is batch-capable so the
bridge's embedding sweeper/backfill can embed many messages per round-trip.
"""
from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException, status
from langchain_openai import OpenAIEmbeddings

from core.error_handling import provider_error_handler
from core.proxy import require_internal_caller
from core.settings import settings
from observability import get_logger
from schemas import EmbedRequest, EmbedResponse

logger = get_logger(__name__)

router = APIRouter()


@lru_cache(maxsize=1)
def _get_embeddings() -> OpenAIEmbeddings:
    """Build the embeddings client once. Raises if no OpenAI key is configured.

    Cached so the (cheap) client object is reused across requests; the API key
    is read from settings (file-backed secret in prod, env in dev).
    """
    api_key = settings.api_keys.openai.get_secret_value() if settings.api_keys.openai else None
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")
    return OpenAIEmbeddings(
        model=settings.runtime_models.embedding,
        dimensions=settings.runtime_models.embedding_dimensions,
        api_key=api_key,
    )


@router.post(
    "/embed",
    response_model=EmbedResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def embed(req: EmbedRequest) -> EmbedResponse:
    """Embed a batch of texts; returns one vector per input, order preserved."""
    model = settings.runtime_models.embedding
    dimensions = settings.runtime_models.embedding_dimensions

    if not req.texts:
        return EmbedResponse(embeddings=[], model=model, dimensions=dimensions)

    try:
        client = _get_embeddings()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Embeddings are not configured.",
        ) from exc

    try:
        vectors = await client.aembed_documents(req.texts)
    except Exception as exc:  # noqa: BLE001 — re-raised below as a typed HTTP error
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="embed_provider_failed",
            message="OpenAI embedding request failed",
            public_detail="Embeddings are temporarily unavailable. Please try again.",
            provider="openai",
            operation="embed",
            model=model,
        )

    logger.info("embed_completed", "Embedded text batch", text_count=len(req.texts), model=model)
    return EmbedResponse(embeddings=vectors, model=model, dimensions=dimensions)
