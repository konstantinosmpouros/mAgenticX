"""Rate-limit policy for the whole public API, backed by fastapi-redis-sdk.

Two layers, one Redis-counted engine (installed by
``core.cache.integration.install_redis_sdk``):

1. **Global identity budget** — one aggregate fixed-window budget per caller
   across every endpoint (default 300/min). The identity is the authenticated
   user id taken from the *verified* session JWT, so the bucket cannot be
   forged onto someone else; requests with no valid session fall back to a
   per-resolved-client-IP bucket. ``/health`` (container probe) and
   ``/v1/internal/*`` (trust-gated service traffic that legitimately bursts)
   are exempt. This absorbs the old hand-rolled ``UserRateLimitMiddleware``
   with identical semantics.
2. **Strict per-route limits** — ``rate_limit`` dependencies on the
   expensive/abusable paths: auth (brute-force guard, per-IP), inference and
   speech (per-user). These emit ``X-RateLimit-*``/``Retry-After`` headers so
   clients can back off intelligently; the global budget stays header-silent
   so the two families never conflict on one response.

Counters live in Redis → limits survive deploys and hold across replicas.
Everything fails OPEN on a Redis outage (availability-first, same stance as
the logout denylist); the SDK logs and counts degraded decisions separately.
"""
from __future__ import annotations

from fastapi import Request, WebSocket
from redis_fastapi import rate_limit
from redis_fastapi.deps import get_rate_limit_backend

from core.auth.tokens import ACCESS_TYPE, verify
from core.security.internal_trust import resolve_client_ip
from core.settings import settings
from core.logging import get_logger

logger = get_logger(__name__)

# The global per-identity budget, consumed by the SDK middleware installer.
USER_BUDGET_RATE: tuple[int, int] = (
    settings.rate_limit.user_max_calls,
    settings.rate_limit.user_window_seconds,
)

_EXEMPT_PATHS = frozenset({"/health"})
_EXEMPT_PREFIXES = ("/v1/internal",)


def exempt_from_budget(request: Request) -> bool:
    """Skip predicate for the global budget: probes + internal service routes."""
    path = request.url.path
    return path in _EXEMPT_PATHS or path.startswith(_EXEMPT_PREFIXES)


async def verified_identity(request: Request) -> str:
    """Verified session sub → ``user:<id>``; anything else → ``ip:<resolved>``.

    This is the *same* verification the auth dependency runs (RS256 against
    the in-process-cached Vault key — no Vault round-trip on the hot path), so
    the bucket key can't be forged onto another user. Any failure (no cookie,
    expired, tampered) falls back to the IP bucket; the request then proceeds
    to normal auth, which rejects it there if it is actually invalid.
    """
    token = request.cookies.get(settings.session.access_cookie_name)
    if token:
        try:
            claims = await verify(token, ACCESS_TYPE)
            return f"user:{claims['sub']}"
        except Exception:
            # Any verification failure → treat as unauthenticated for keying.
            pass
    return f"ip:{resolve_client_ip(request) or 'unknown'}"


def ip_identity(request: Request) -> str:
    """Trusted-proxy-resolved client IP — the pre-auth identity (login paths)."""
    return resolve_client_ip(request) or "unknown"


def user_path_identity(request: Request) -> str:
    """The route's ``{user_id}`` path param (already session-validated by the
    endpoint's auth dependency), with an IP fallback for malformed calls."""
    return request.path_params.get("user_id") or ip_identity(request)


# --- Named per-route dependencies ------------------------------------------
# Routers declare policy by name; the numbers stay in core/settings.py so every
# limit is env-tunable per environment without a code change.

auth_rate_limit = rate_limit(
    (settings.rate_limit.auth_max_attempts, settings.rate_limit.auth_window_seconds),
    scope="auth",
    identifier=ip_identity,
    emit_headers=True,
)

inference_rate_limit = rate_limit(
    (settings.rate_limit.inference_max_attempts, settings.rate_limit.inference_window_seconds),
    scope="inference",
    identifier=user_path_identity,
    emit_headers=True,
)

speech_rate_limit = rate_limit(
    (settings.rate_limit.speech_max_attempts, settings.rate_limit.speech_window_seconds),
    scope="speech",
    identifier=user_path_identity,
    emit_headers=True,
)

# Paid-API / outward-artifact / storage-growth ceilings. Policy: anything that
# spends money per call (voice session, suggestions), produces an outward
# artifact (share link), or grows storage unboundedly (message attachments,
# skill uploads, PDF renders) gets its own per-user window on top of the
# aggregate budget.

voice_session_rate_limit = rate_limit(
    (settings.rate_limit.voice_session_max_attempts, settings.rate_limit.voice_session_window_seconds),
    scope="voice-session",
    identifier=user_path_identity,
    emit_headers=True,
)

export_pdf_rate_limit = rate_limit(
    (settings.rate_limit.export_pdf_max_attempts, settings.rate_limit.export_pdf_window_seconds),
    scope="export-pdf",
    identifier=user_path_identity,
    emit_headers=True,
)

share_create_rate_limit = rate_limit(
    (settings.rate_limit.share_create_max_attempts, settings.rate_limit.share_create_window_seconds),
    scope="share-create",
    identifier=user_path_identity,
    emit_headers=True,
)

skill_upload_rate_limit = rate_limit(
    (settings.rate_limit.skill_upload_max_attempts, settings.rate_limit.skill_upload_window_seconds),
    scope="skill-upload",
    identifier=user_path_identity,
    emit_headers=True,
)

message_post_rate_limit = rate_limit(
    (settings.rate_limit.message_post_max_attempts, settings.rate_limit.message_post_window_seconds),
    scope="message-post",
    identifier=user_path_identity,
    emit_headers=True,
)

suggestions_rate_limit = rate_limit(
    (settings.rate_limit.suggestions_max_attempts, settings.rate_limit.suggestions_window_seconds),
    scope="suggestions",
    identifier=user_path_identity,
    emit_headers=True,
)

refresh_rate_limit = rate_limit(
    (settings.rate_limit.refresh_max_attempts, settings.rate_limit.refresh_window_seconds),
    scope="auth-refresh",
    identifier=ip_identity,
    emit_headers=True,
)


async def allow_ws_connect(websocket: WebSocket, user_id: str) -> bool:
    """Connect-rate guard for the run-stream WebSocket handshake.

    The SDK's middleware and ``rate_limit`` dependencies are HTTP-only, so the
    socket route enforces its own fixed window against the same Redis-backed
    engine (shared pool + capability cache; ``get_rate_limit_backend`` only
    reads ``.app``, which WebSocket carries too). Keyed by the *verified* user
    id — the caller runs this after WebSocket authentication succeeds, so the
    bucket cannot be pinned on someone else. Fails OPEN like every limiter.
    """
    try:
        backend = await get_rate_limit_backend(websocket)  # type: ignore[arg-type]
        result = await backend.hit(
            f"user:{user_id}",
            limit=settings.rate_limit.ws_connect_max_attempts,
            window=settings.rate_limit.ws_connect_window_seconds,
            scope="ws-connect",
        )
        return result.allowed
    except Exception:
        logger.warning(
            "ws_connect_rate_limit_degraded",
            "WebSocket connect rate limit unavailable; failing open",
            exc_info=True,
        )
        return True
