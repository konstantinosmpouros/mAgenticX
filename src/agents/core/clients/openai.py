from functools import lru_cache

from openai import OpenAI

from core.settings import settings


@lru_cache(maxsize=1)
def get_openai_client() -> OpenAI:
    """Return the process-wide OpenAI client, built from the configured API key."""
    if settings.api_keys.openai:
        return OpenAI(api_key=settings.api_keys.openai.get_secret_value())
    return OpenAI()
