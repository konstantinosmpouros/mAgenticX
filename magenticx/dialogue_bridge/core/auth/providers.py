"""The normalized identity every sign-in produces.

Microsoft Entra ID is the only identity provider (plan 29 Part A removed Vault
userpass). ``core.auth.oidc.complete_login`` returns an :class:`AuthIdentity`,
and everything downstream — resolving the user row, minting the session JWT,
every verifier — depends only on this shape, never on how the identity was
proven.

There used to be an ``AuthProvider`` ABC and a provider registry here. With one
provider left, called directly by the OIDC callback, the registry had nothing to
register and nothing looked it up, so it was removed. Re-introduce an interface
at the point where there are two of something.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class AuthIdentity:
    """Normalized identity returned by a completed sign-in.

    ``subject`` is the stable external id — the Entra ``oid``, which is what a
    user row is resolved by. ``email`` and ``username`` are profile data only:
    Entra lets them change, so they are never used to decide *which* account a
    sign-in belongs to.
    """

    subject: str
    username: str
    provider: str
    email: str | None = None
    groups: tuple[str, ...] = ()
    claims: dict | None = None
