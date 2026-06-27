from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from core.auth.vault import VaultAuthenticator


@dataclass(slots=True)
class AuthIdentity:
    """Normalized identity returned by any auth provider.

    ``subject`` is the stable external id (a Vault ``entity_id`` today; an Entra
    ``oid`` or Keycloak ``sub`` tomorrow). The platform issues its own session
    JWT from this, so token issuance/verification and every downstream service
    are independent of which provider authenticated the user.
    """

    subject: str
    username: str
    provider: str
    email: str | None = None
    groups: tuple[str, ...] = ()
    claims: dict | None = None


class AuthProvider(ABC):
    """A pluggable identity provider.

    Add a new login mechanism (Keycloak, Entra ID, …) by implementing this and
    calling :func:`register_provider` — nothing in token issuance, verification,
    the FastAPI deps, or the downstream services changes.
    """

    name: str

    @abstractmethod
    async def authenticate(self, payload: dict) -> AuthIdentity:
        ...


class VaultUserpassProvider(AuthProvider):
    """Verifies username/password against Vault's userpass backend."""

    name = "vault"

    def __init__(self) -> None:
        self._authenticator: VaultAuthenticator | None = None

    def _get_authenticator(self) -> VaultAuthenticator:
        # Built lazily so the module imports cleanly even when VAULT_URL is unset
        # (raises RuntimeError on first use, surfaced as a 500 by the login route).
        if self._authenticator is None:
            self._authenticator = VaultAuthenticator()
        return self._authenticator

    async def authenticate(self, payload: dict) -> AuthIdentity:
        username = (payload.get("username") or "").strip()
        password = payload.get("password") or ""
        result = await self._get_authenticator().authenticate(username, password)
        return AuthIdentity(subject=result.vault_user_id, username=result.username, provider=self.name)


_PROVIDERS: dict[str, AuthProvider] = {}


def register_provider(provider: AuthProvider) -> None:
    _PROVIDERS[provider.name] = provider


def get_provider(name: str) -> AuthProvider:
    try:
        return _PROVIDERS[name]
    except KeyError as exc:
        raise KeyError(f"Unknown auth provider: {name!r}") from exc


register_provider(VaultUserpassProvider())
