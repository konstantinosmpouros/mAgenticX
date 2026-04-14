import os
from dataclasses import dataclass
from typing import Optional

import httpx


class VaultAuthError(Exception):
    """Raised when Vault authentication fails."""

    def __init__(self, message: str, *, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


@dataclass(slots=True)
class VaultAuthResult:
    vault_user_id: str
    username: str
    client_token_ttl: Optional[int]
    client_token_renewable: bool


@dataclass(slots=True)
class VaultSettings:
    addr: str
    userpass_mount: str = "userpass"
    oidc_role: str = "agenticx"
    oidc_path: str = "identity/oidc/token"
    namespace: Optional[str] = None
    timeout: float = 10.0

    @classmethod
    def from_env(cls) -> "VaultSettings":
        addr = os.getenv("VAULT_ADDR")
        if not addr:
            raise RuntimeError("VAULT_ADDR is not configured.")
        return cls(
            addr=addr.rstrip("/"),
            userpass_mount=os.getenv("VAULT_USERPASS_MOUNT", "userpass"),
            oidc_role=os.getenv("VAULT_OIDC_ROLE", "agenticx"),
            oidc_path=os.getenv("VAULT_OIDC_PATH", "identity/oidc/token"),
            namespace=os.getenv("VAULT_NAMESPACE"),
            timeout=float(os.getenv("VAULT_HTTP_TIMEOUT", "10")),
        )


class VaultAuthenticator:
    """Small client that authenticates users against Vault userpass."""

    def __init__(self, settings: VaultSettings | None = None):
        self._settings = settings or VaultSettings.from_env()

    async def authenticate(self, username: str, password: str) -> VaultAuthResult:
        async with httpx.AsyncClient(timeout=self._settings.timeout) as client:
            login_payload = {"password": password}
            login_headers = self._build_headers()
            login_url = self._build_login_url(username)

            try:
                login_resp = await client.post(login_url, json=login_payload, headers=login_headers)
            except httpx.HTTPError as exc:
                raise VaultAuthError(f"Failed to reach Vault login endpoint: {exc}") from exc

            login_data = self._parse_json(login_resp, "Vault login")
            auth_block = login_data.get("auth") or {}

            if login_resp.status_code >= 400:
                message = (login_data.get("errors") or [login_resp.text])[0]
                raise VaultAuthError(f"Vault login failed: {message}", status_code=login_resp.status_code)

            client_token = auth_block.get("client_token")
            vault_user_id = auth_block.get("entity_id")
            lease_duration = auth_block.get("lease_duration")
            renewable_flag = bool(auth_block.get("renewable"))

            if not client_token or not vault_user_id:
                raise VaultAuthError("Vault login response missing client_token or entity_id.")

            return VaultAuthResult(
                vault_user_id=vault_user_id,
                username=username,
                client_token_ttl=self._normalize_ttl(lease_duration),
                client_token_renewable=renewable_flag,
            )

    def _build_headers(self, token: Optional[str] = None) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if token:
            headers["X-Vault-Token"] = token
        if self._settings.namespace:
            headers["X-Vault-Namespace"] = self._settings.namespace
        return headers

    def _build_login_url(self, username: str) -> str:
        return f"{self._settings.addr}/v1/auth/{self._settings.userpass_mount}/login/{username}"

    def _build_oidc_url(self) -> str:
        return f"{self._settings.addr}/v1/{self._settings.oidc_path.rstrip('/')}/{self._settings.oidc_role}"

    @staticmethod
    def _parse_json(response: httpx.Response, context: str) -> dict:
        try:
            return response.json()
        except ValueError as exc:
            raise VaultAuthError(f"{context} returned non-JSON response: {response.text}") from exc

    @staticmethod
    def _normalize_ttl(raw_value: Optional[object]) -> Optional[int]:
        try:
            return int(float(raw_value)) if raw_value is not None else None
        except (TypeError, ValueError):
            return None
