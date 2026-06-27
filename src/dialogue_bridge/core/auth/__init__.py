"""Authentication: session lifecycle, JWT issuance, identity providers, and the Vault backend.

Re-exports the public surface so callers can use ``from core.auth import ...``;
submodules (``session``, ``tokens``, ``providers``, ``vault``) remain importable
directly for the less common symbols.
"""
from core.auth.session import (
    AuthContext,
    AuthUser,
    authenticate_websocket_user,
    require_bound_user_id,
    require_csrf_protection,
    require_current_user,
)
from core.auth.tokens import IssuedTokens, TokenError, mint_tokens, verify
from core.auth.providers import AuthIdentity, AuthProvider, get_provider, register_provider
from core.auth.vault import (
    VaultAuthenticator,
    VaultAuthError,
    VaultServiceError,
    vault_service,
)
