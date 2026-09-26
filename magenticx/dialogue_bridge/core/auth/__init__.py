"""Authentication: session lifecycle, JWT issuance and signing, identity providers.

Re-exports the public surface so callers can use ``from core.auth import ...``;
submodules (``session``, ``tokens``, ``signing``, ``providers``, ``oidc``)
remain importable directly for the less common symbols. Microsoft Entra ID
(``oidc``) is the only way to sign in; ``signing`` owns the session-token keys
(OCI KMS in production). There is no Vault dependency left (plan 29).
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
from core.auth.providers import AuthIdentity
