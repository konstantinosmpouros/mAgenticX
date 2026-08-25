"""Parked sessions — the other accounts a browser is signed in to.

Multi-account cannot be done with cookies here: the session cookies carry the
``__Host-`` prefix, which forces ``Path=/``, so every parked JWT would ride on
every request (~1 KB each) and the 4 KB per-cookie ceiling caps a token map at
about three accounts. So the *active* account keeps using the normal cookies
unchanged, and the dormant ones live here — indexed by a small opaque device id
that is the only thing added to the browser.

    auth:parked:<device_id>  ->  hash { user_id: <encrypted refresh token> }

Two properties make that safe enough to store server-side:

* **Encrypted at rest.** Redis today holds only non-credential auth state
  (logout markers, the current refresh ``jti``). Refresh tokens are credentials,
  so a Redis-only compromise must not yield usable ones: values are AES-GCM
  sealed with a key the app holds, and the device id + user id are bound in as
  additional authenticated data so a blob cannot be replayed under a different
  device or user even by someone who can write to Redis.
* **Nothing identifying is stored.** Only the token. Display names and emails
  for the account menu are read from Postgres at request time, so a Redis dump
  does not also leak a roster of who is signed in on which browser.

Failure stance differs per operation, deliberately. ``park``/``take`` **fail
closed** (raise): they change which identity a browser holds, and there is no
safe way to guess. ``list_user_ids``/``drop`` degrade quietly — a switcher that
cannot be populated is a missing feature, not a security decision.
"""
from __future__ import annotations

import base64
import binascii
import os
import secrets
from typing import Iterable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from redis import asyncio as aioredis

from core.cache.client import create_redis_client
from core.settings import settings
from core.logging import get_logger

logger = get_logger(__name__)

_PARKED_KEY_PREFIX = "auth:parked:"
_NONCE_BYTES = 12
_DEVICE_ID_BYTES = 32


class ParkedSessionError(Exception):
    """A parked-session operation could not be completed safely."""


class ParkedAccountLimit(ParkedSessionError):
    """The browser already holds the maximum number of parked accounts."""


def new_device_id() -> str:
    """A fresh opaque device id. Never derived from a user id — it must not be
    possible to guess another browser's index key from a known account."""
    return secrets.token_urlsafe(_DEVICE_ID_BYTES)


def _redis_key(device_id: str) -> str:
    return f"{_PARKED_KEY_PREFIX}{device_id}"


_DERIVED_KEY_INFO = b"magenticx/parked-token-key/v1"


def _load_key() -> bytes:
    """The AES-GCM key for parked tokens: 32 bytes, explicit or derived.

    ``PARKED_TOKEN_KEY`` (or ``PARKED_TOKEN_KEY_FILE``) wins — production should
    supply a dedicated secret so this key rotates independently of anything else.
    When it is absent the key is **derived** from ``SESSION_TOKEN_SECRET`` with
    HKDF and a fixed info label, so a deployment that has not provisioned a
    dedicated secret still encrypts rather than storing credentials in plaintext.

    Never falls through to "no encryption" — that is the one outcome this module
    exists to prevent. Two consequences worth knowing about the derived path:
    rotating ``SESSION_TOKEN_SECRET`` invalidates every parked session (users
    re-add their accounts), and the two secrets share a root, which is exactly why
    production sets the dedicated one.
    """
    raw = settings.session.parked_token_key.get_secret_value()
    if raw:
        for decode in (base64.b64decode, bytes.fromhex):
            try:
                material = decode(raw)
            except (binascii.Error, ValueError):
                continue
            if len(material) == 32:
                return material
            if len(material) > 32:
                # AES-256 needs exactly 32 bytes, but an operator generating
                # *more* entropy (e.g. `openssl rand -base64 64`) should not hit a
                # runtime failure — condense it instead. Shorter material is
                # refused rather than stretched: stretching weak key material only
                # hides that it is weak.
                return _hkdf32(material)
            break
        raise ParkedSessionError(
            "PARKED_TOKEN_KEY must decode to at least 32 bytes (base64 or hex)."
        )

    root = settings.session.token_secret.get_secret_value()
    if not root:
        raise ParkedSessionError(
            "Neither PARKED_TOKEN_KEY nor SESSION_TOKEN_SECRET is configured; refusing "
            "to store parked sessions unencrypted."
        )
    return _hkdf32(root.encode("utf-8"))


def _hkdf32(material: bytes) -> bytes:
    """Condense key material to exactly 32 bytes for AES-256-GCM."""
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=_DERIVED_KEY_INFO,
    ).derive(material)


def _aad(device_id: str, user_id: str) -> bytes:
    """Bind a sealed token to exactly one (device, user) pair."""
    return f"{device_id}:{user_id}".encode("utf-8")


def _seal(device_id: str, user_id: str, token: str) -> str:
    nonce = os.urandom(_NONCE_BYTES)
    sealed = AESGCM(_load_key()).encrypt(nonce, token.encode("utf-8"), _aad(device_id, user_id))
    return base64.b64encode(nonce + sealed).decode("ascii")


def _open(device_id: str, user_id: str, blob: str) -> str | None:
    """Unseal a token, or ``None`` when it does not authenticate.

    A failure here means the value was tampered with, moved between accounts, or
    encrypted under a rotated key — none of which are recoverable, so the caller
    treats the entry as gone rather than trying to use it.
    """
    try:
        raw = base64.b64decode(blob)
        nonce, payload = raw[:_NONCE_BYTES], raw[_NONCE_BYTES:]
        return AESGCM(_load_key()).decrypt(nonce, payload, _aad(device_id, user_id)).decode("utf-8")
    except (InvalidTag, binascii.Error, ValueError, IndexError):
        logger.warning(
            "parked_token_unsealable",
            "A parked session could not be decrypted and was discarded",
            user_id=user_id,
        )
        return None


class ParkedSessionStore:
    """Redis-backed index of a browser's dormant sessions."""

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None

    async def _get_client(self) -> aioredis.Redis:
        if self._client is None:
            self._client = create_redis_client()
        return self._client

    async def park(self, device_id: str, user_id: str, refresh_token: str, ttl_seconds: int) -> None:
        """Store (or replace) a user's dormant refresh token for this browser.

        Re-parking the same user is an update, not a new slot, so the cap counts
        distinct accounts. The TTL is reset on every write, so an actively-used
        switcher stays alive while a forgotten one expires with its tokens.
        """
        if not device_id or not user_id or not refresh_token or ttl_seconds <= 0:
            raise ParkedSessionError("Cannot park a session without a device, user and token.")
        try:
            client = await self._get_client()
            key = _redis_key(device_id)
            if not await client.hexists(key, user_id):
                # `max_parked_accounts` is the ceiling on accounts signed in *in
                # total*, and one of them is always the active session — so at
                # most max-1 may be parked. Without the -1 this backstop would
                # permit one more account than the router's add-account guard,
                # and the effective limit would depend on which path you took.
                if await client.hlen(key) >= max(1, settings.session.max_parked_accounts - 1):
                    raise ParkedAccountLimit(
                        f"At most {settings.session.max_parked_accounts} accounts can be signed in."
                    )
            await client.hset(key, user_id, _seal(device_id, user_id, refresh_token))
            await client.expire(key, ttl_seconds)
        except (ParkedAccountLimit, ParkedSessionError):
            raise
        except Exception as exc:  # Redis unreachable, encryption misconfigured
            logger.error("parked_park_failed", "Could not park a session", exc_info=True)
            raise ParkedSessionError("Parked sessions are unavailable.") from exc

    async def take(self, device_id: str, user_id: str) -> str:
        """Remove and return a parked refresh token — single use.

        Deleted as it is read: a switch immediately rotates the token, so leaving
        the old one behind would only widen the window in which a copy is usable.
        """
        if not device_id or not user_id:
            raise ParkedSessionError("Missing device or user.")
        try:
            client = await self._get_client()
            key = _redis_key(device_id)
            blob = await client.hget(key, user_id)
            if blob is None:
                raise ParkedSessionError("That account is not signed in on this device.")
            await client.hdel(key, user_id)
        except ParkedSessionError:
            raise
        except Exception as exc:
            logger.error("parked_take_failed", "Could not read a parked session", exc_info=True)
            raise ParkedSessionError("Parked sessions are unavailable.") from exc

        token = _open(device_id, user_id, blob if isinstance(blob, str) else blob.decode("utf-8"))
        if token is None:
            raise ParkedSessionError("That session could not be restored. Please sign in again.")
        return token

    async def list_user_ids(self, device_id: str) -> list[str]:
        """Which accounts this browser can switch to. Degrades to empty."""
        if not device_id:
            return []
        try:
            client = await self._get_client()
            fields = await client.hkeys(_redis_key(device_id))
            return [f if isinstance(f, str) else f.decode("utf-8") for f in fields]
        except Exception:
            logger.warning(
                "parked_list_unavailable",
                "Could not list parked sessions; offering none",
            )
            return []

    async def drop(self, device_id: str, user_id: str) -> None:
        """Forget one account on this browser (best-effort)."""
        if not device_id or not user_id:
            return
        try:
            client = await self._get_client()
            await client.hdel(_redis_key(device_id), user_id)
        except Exception:
            logger.warning("parked_drop_failed", "Could not drop a parked session")

    async def clear(self, device_id: str) -> list[str]:
        """Forget every account on this browser, returning the ids removed so the
        caller can revoke their sessions too — used by "log out of all accounts",
        which exists so a shared machine is not left holding dormant logins."""
        if not device_id:
            return []
        user_ids = await self.list_user_ids(device_id)
        try:
            client = await self._get_client()
            await client.delete(_redis_key(device_id))
        except Exception:
            logger.warning("parked_clear_failed", "Could not clear parked sessions")
        return user_ids

    async def count(self, device_id: str) -> int:
        return len(await self.list_user_ids(device_id))


parked_sessions = ParkedSessionStore()


__all__ = [
    "ParkedAccountLimit",
    "ParkedSessionError",
    "ParkedSessionStore",
    "new_device_id",
    "parked_sessions",
]
