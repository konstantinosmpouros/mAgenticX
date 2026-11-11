"""The task-launch token: who is calling the Agent Protocol router (plan 41 §3.3).

deepagents' ``AsyncSubAgentMiddleware`` talks to ``/ap`` over HTTP and forwards
no run context when the sub-agent has a ``url`` — so the router must learn the
caller's identity some other way, and must never take it from the request body
(the body is shaped by a model's tool call). Every agent build that gets async
sub-agents mints one token, signed here, and the middleware sends it as a
header on every call. The router verifies it and reads the caller from it:

* the identity: user, conversation, the bridge's root run, the branch thread;
* who the caller is in the tree: the orchestrator (no caller task) or a task;
* the context a child task inherits: tool choices, memory, interactivity.

Format: ``base64url(zlib(json claims)) "." base64url(HMAC-SHA256)``. Signed,
not encrypted: it travels only inside this process (the in-process transport,
``harness.async_tasks.client``) and is never logged. The key is
``ASYNC_TASKS_LAUNCH_SECRET`` or, unset, derived from ``INTERNAL_SERVICE_SECRET``
under a domain label, so the raw service secret is never the HMAC key.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import zlib
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from core.settings import EffortLevel, settings

#: The header the middleware sends the token in.
LAUNCH_TOKEN_HEADER = "X-Task-Launch-Token"

#: Bumped when the claims change shape; an old token is then refused.
_TOKEN_VERSION = 1
_DOMAIN = b"magenticx/async-task-launch/v1"
#: A token larger than this (compressed) is refused before any decoding work.
_MAX_TOKEN_CHARS = 16384
#: Decompressed claims larger than this are refused (zip-bomb guard).
_MAX_CLAIMS_BYTES = 65536


class LaunchTokenError(Exception):
    """The token is missing, malformed, forged or expired. Always a 401."""


class InheritedContext(BaseModel):
    """What a child task inherits from the run that launched it.

    Only fields that change what the child may do. ``tool_config`` and
    ``command`` can only narrow it (the gates and the read-only policy are
    re-resolved from them), so a child never gets more than its launcher.
    """
    model_config = ConfigDict(extra="forbid")

    interactive: bool = True
    use_memory: bool | None = None
    search_past_convs: bool = False
    tool_config: dict[str, Any] | None = None
    agent_owner_id: str | None = None
    command: str | None = None
    # The reasoning effort the user picked; a child thinks as hard as its launcher.
    effort: EffortLevel | None = None


class LaunchClaims(BaseModel):
    """The verified caller of an ``/ap`` request."""
    model_config = ConfigDict(extra="forbid")

    v: int
    exp: int
    user_id: str = Field(min_length=1, max_length=128)
    conversation_id: str = Field(min_length=1, max_length=128)
    root_run_id: str = Field(min_length=1, max_length=128)
    branch_thread_id: str = Field(min_length=1, max_length=256)
    # The task the caller is; None for the orchestrator.
    caller_task_id: str | None = Field(default=None, max_length=128)
    # The caller's place in the tree: its depth (0 = orchestrator) and path.
    caller_depth: int = Field(ge=0, le=10)
    caller_path: list[str] = Field(default_factory=list)
    agent_slug: str = Field(min_length=1, max_length=200)
    definition_version: str = Field(min_length=1, max_length=200)
    context: InheritedContext = Field(default_factory=InheritedContext)


def _key() -> bytes:
    explicit = settings.async_tasks.launch_secret.get_secret_value()
    if explicit:
        return explicit.encode("utf-8")
    base = settings.proxy.internal_service_secret.get_secret_value().encode("utf-8")
    return hmac.new(base, _DOMAIN, hashlib.sha256).digest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def mint_launch_token(
    *,
    user_id: str,
    conversation_id: str,
    root_run_id: str,
    branch_thread_id: str,
    caller_task_id: str | None,
    caller_depth: int,
    caller_path: list[str],
    agent_slug: str,
    definition_version: str,
    context: InheritedContext,
    ttl_seconds: int | None = None,
) -> str:
    """Sign the claims of one agent build. ``ttl_seconds`` defaults to the setting."""
    ttl = ttl_seconds if ttl_seconds is not None else settings.async_tasks.launch_token_ttl_seconds
    claims = LaunchClaims(
        v=_TOKEN_VERSION,
        exp=int(time.time()) + int(ttl),
        user_id=user_id,
        conversation_id=conversation_id,
        root_run_id=root_run_id,
        branch_thread_id=branch_thread_id,
        caller_task_id=caller_task_id,
        caller_depth=caller_depth,
        caller_path=list(caller_path),
        agent_slug=agent_slug,
        definition_version=definition_version,
        context=context,
    )
    raw = json.dumps(claims.model_dump(mode="json"), separators=(",", ":"), sort_keys=True).encode("utf-8")
    body = _b64(zlib.compress(raw, 6))
    signature = _b64(hmac.new(_key(), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}"


def verify_launch_token(token: str | None) -> LaunchClaims:
    """The claims of a valid token; :class:`LaunchTokenError` otherwise.

    The signature is checked (constant time) before anything is decompressed or
    parsed, so a forged token costs one HMAC.
    """
    if not token or len(token) > _MAX_TOKEN_CHARS or token.count(".") != 1:
        raise LaunchTokenError("missing or malformed")
    body, signature = token.split(".", 1)
    expected = _b64(hmac.new(_key(), body.encode("ascii", errors="replace"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        raise LaunchTokenError("bad signature")
    try:
        decompressor = zlib.decompressobj()
        raw = decompressor.decompress(_unb64(body), _MAX_CLAIMS_BYTES)
        if decompressor.unconsumed_tail:
            raise LaunchTokenError("claims too large")
        claims = LaunchClaims.model_validate(json.loads(raw))
    except (ValueError, zlib.error, ValidationError) as exc:
        raise LaunchTokenError("unreadable claims") from exc
    if claims.v != _TOKEN_VERSION:
        raise LaunchTokenError("unsupported version")
    if claims.exp < int(time.time()):
        raise LaunchTokenError("expired")
    return claims


__all__ = [
    "LAUNCH_TOKEN_HEADER",
    "InheritedContext",
    "LaunchClaims",
    "LaunchTokenError",
    "mint_launch_token",
    "verify_launch_token",
]
