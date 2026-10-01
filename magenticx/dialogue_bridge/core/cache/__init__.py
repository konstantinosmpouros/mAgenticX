"""Redis + cache handling for the bridge.

- ``client``      — the shared async Redis client factory (raw consumers:
                    event-log streams, logout denylist, OIDC state).
- ``integration`` — fastapi-redis-sdk installation (pool lifespan, the global
                    per-identity rate-limit budget, DI caching).

This ``__init__`` re-exports only the client factory: ``integration`` imports
``core.security.rate_limit`` (which imports auth modules that themselves use
the client factory), so keeping the package init lean breaks any import cycle
by construction. Import the installer directly from
``core.cache.integration``.
"""
from core.cache.client import create_redis_client

__all__ = ["create_redis_client"]
