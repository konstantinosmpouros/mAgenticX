from __future__ import annotations

import asyncio
import base64
import time
from dataclasses import dataclass
from urllib.parse import quote

import httpx

from core.settings import settings
from core.security.tls import get_httpx_verify
from observability import get_logger

logger = get_logger(__name__)


class VaultAuthError(Exception):
    """Raised when a user's Vault credential check fails."""

    def __init__(self, message: str, *, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


class VaultServiceError(Exception):
    """Raised when a Vault service-identity or Transit operation fails."""


def _vault_client() -> httpx.AsyncClient:
    # One-way TLS to Vault (token auth, not mTLS): verify the server cert against
    # the internal CA; never present a client cert on this hop.
    return httpx.AsyncClient(timeout=settings.vault.timeout, verify=get_httpx_verify())


def _vault_headers(token: str | None = None) -> dict[str, str]:
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if token:
        headers["X-Vault-Token"] = token
    if settings.vault.namespace:
        headers["X-Vault-Namespace"] = settings.vault.namespace
    return headers


# ---------------------------------------------------------------------------
# userpass — verify a human's credentials (the default identity provider)
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class VaultAuthResult:
    vault_user_id: str
    username: str


class VaultAuthenticator:
    """Verifies a username/password against Vault's userpass backend."""

    def __init__(self, vault_settings=None) -> None:
        self._settings = vault_settings or settings.vault
        if not self._settings.addr:
            raise RuntimeError("VAULT_URL is not configured.")

    async def authenticate(self, username: str, password: str) -> VaultAuthResult:
        url = (
            f"{self._settings.addr.rstrip('/')}/v1/auth/"
            f"{self._settings.userpass_mount}/login/{quote(username, safe='')}"
        )
        async with _vault_client() as client:
            try:
                resp = await client.post(url, json={"password": password}, headers=_vault_headers())
            except httpx.HTTPError as exc:
                raise VaultAuthError(f"Failed to reach Vault login endpoint: {exc}") from exc

        data = self._parse_json(resp, "Vault login")
        if resp.status_code >= 400:
            message = (data.get("errors") or [resp.text])[0]
            raise VaultAuthError(f"Vault login failed: {message}", status_code=resp.status_code)

        auth_block = data.get("auth") or {}
        vault_user_id = auth_block.get("entity_id")
        if not auth_block.get("client_token") or not vault_user_id:
            raise VaultAuthError("Vault login response missing client_token or entity_id.")
        return VaultAuthResult(vault_user_id=vault_user_id, username=username)

    @staticmethod
    def _parse_json(response: httpx.Response, context: str) -> dict:
        try:
            return response.json()
        except ValueError as exc:
            raise VaultAuthError(f"{context} returned non-JSON response: {response.text}") from exc


# ---------------------------------------------------------------------------
# AppRole machine identity + Transit signing (the session-JWT signer backend)
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class _Token:
    value: str
    expires_at: float


class VaultServiceClient:
    """The bridge's own Vault identity (AppRole), used to sign session JWTs via
    the Transit engine and to read the Transit public keys for verification.

    The RSA private key never leaves Vault: the bridge sends the JWT signing
    input to ``transit/sign`` and receives only the signature back. Public keys
    are cached in-process so per-request token verification never calls Vault —
    a cache miss (e.g. just after a key rotation) is the only time verification
    reaches out. Minting (login/refresh) always calls Vault to sign.
    """

    # Re-auth this many seconds before the AppRole token actually expires.
    _TOKEN_RENEW_SKEW = 60.0

    def __init__(self) -> None:
        self._vault = settings.vault
        self._jwt = settings.jwt
        self._token: _Token | None = None
        self._token_lock = asyncio.Lock()
        self._public_keys: dict[int, str] = {}
        self._pubkey_lock = asyncio.Lock()
        self._sign_version: int | None = None
        self._sign_version_fetched_at: float = 0.0
        self._sign_version_lock = asyncio.Lock()

    def _addr(self) -> str:
        if not self._vault.addr:
            raise VaultServiceError("VAULT_URL is not configured.")
        return self._vault.addr.rstrip("/")

    async def _login(self) -> _Token:
        role_id = self._vault.role_id.get_secret_value()
        secret_id = self._vault.secret_id.get_secret_value()
        if not role_id or not secret_id:
            raise VaultServiceError("VAULT_ROLE_ID / VAULT_SECRET_ID are not configured.")
        url = f"{self._addr()}/v1/auth/{self._vault.approle_mount}/login"
        async with _vault_client() as client:
            try:
                resp = await client.post(
                    url,
                    json={"role_id": role_id, "secret_id": secret_id},
                    headers=_vault_headers(),
                )
            except httpx.HTTPError as exc:
                raise VaultServiceError(f"AppRole login request failed: {exc}") from exc
        if resp.status_code >= 400:
            raise VaultServiceError(f"AppRole login failed with status {resp.status_code}.")
        auth = (resp.json() or {}).get("auth") or {}
        token = auth.get("client_token")
        if not token:
            raise VaultServiceError("AppRole login response missing client_token.")
        lease = auth.get("lease_duration") or 0
        ttl = float(lease) if lease else 3600.0
        logger.info("vault_approle_login", "Bridge authenticated to Vault via AppRole", lease_seconds=int(ttl))
        return _Token(value=token, expires_at=time.monotonic() + ttl)

    async def _get_token(self, *, force: bool = False) -> str:
        token = self._token
        if not force and token is not None and token.expires_at - self._TOKEN_RENEW_SKEW > time.monotonic():
            return token.value
        async with self._token_lock:
            token = self._token
            if not force and token is not None and token.expires_at - self._TOKEN_RENEW_SKEW > time.monotonic():
                return token.value
            self._token = await self._login()
            return self._token.value

    async def _request(self, method: str, path: str, json_body: dict | None = None) -> dict:
        url = f"{self._addr()}/v1/{path}"
        for attempt in (1, 2):
            token = await self._get_token(force=(attempt == 2))
            async with _vault_client() as client:
                try:
                    resp = await client.request(method, url, json=json_body, headers=_vault_headers(token))
                except httpx.HTTPError as exc:
                    raise VaultServiceError(f"Vault request to {path} failed: {exc}") from exc
            if resp.status_code in (401, 403) and attempt == 1:
                # Token likely expired/revoked — re-authenticate once and retry.
                continue
            if resp.status_code >= 400:
                raise VaultServiceError(f"Vault request to {path} failed with status {resp.status_code}.")
            return resp.json() or {}
        raise VaultServiceError(f"Vault request to {path} failed after re-authentication.")

    def _cache_public_key(self, data: dict) -> None:
        for version_str, entry in (data.get("keys") or {}).items():
            pem = entry.get("public_key") if isinstance(entry, dict) else None
            if pem and version_str.isdigit():
                self._public_keys[int(version_str)] = pem

    async def current_sign_version(self) -> int:
        if (
            self._sign_version is not None
            and (time.monotonic() - self._sign_version_fetched_at) < self._jwt.sign_version_cache_seconds
        ):
            return self._sign_version
        async with self._sign_version_lock:
            if (
                self._sign_version is not None
                and (time.monotonic() - self._sign_version_fetched_at) < self._jwt.sign_version_cache_seconds
            ):
                return self._sign_version
            data = (await self._request("GET", f"{self._vault.transit_mount}/keys/{self._vault.transit_jwt_key}")).get("data") or {}
            latest = data.get("latest_version")
            if not isinstance(latest, int) or latest < 1:
                raise VaultServiceError("Transit signing key has no usable latest_version.")
            self._sign_version = latest
            self._sign_version_fetched_at = time.monotonic()
            return latest

    async def public_key_pem(self, version: int) -> str:
        cached = self._public_keys.get(version)
        if cached:
            return cached
        async with self._pubkey_lock:
            cached = self._public_keys.get(version)
            if cached:
                return cached
            data = (await self._request("GET", f"{self._vault.transit_mount}/keys/{self._vault.transit_jwt_key}")).get("data") or {}
            self._cache_public_key(data)
            pem = self._public_keys.get(version)
            if not pem:
                raise VaultServiceError(f"Transit key version {version} has no public key.")
            return pem

    async def sign(self, signing_input: str, version: int) -> str:
        body = {
            "input": base64.b64encode(signing_input.encode("ascii")).decode("ascii"),
            # RS256 == RSASSA-PKCS1-v1_5 + SHA-256. Vault defaults to PSS (=PS256),
            # which would fail verification under algorithms=["RS256"] — pin pkcs1v15.
            "signature_algorithm": "pkcs1v15",
            "hash_algorithm": "sha2-256",
            "prehashed": False,
            # jws marshaling emits base64url-no-pad — already the JWT 3rd segment.
            "marshaling_algorithm": "jws",
            "key_version": version,
        }
        data = (await self._request("POST", f"{self._vault.transit_mount}/sign/{self._vault.transit_jwt_key}", body)).get("data") or {}
        signature = data.get("signature")
        if not signature or not signature.startswith("vault:v") or signature.count(":") < 2:
            raise VaultServiceError("Transit sign response has an unexpected signature format.")
        # "vault:v<N>:<base64url-nopad>" — strip the prefix; the rest is the segment.
        return signature.split(":", 2)[2]


vault_service = VaultServiceClient()
