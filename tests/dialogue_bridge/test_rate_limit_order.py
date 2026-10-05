"""A rate limit keyed on the path's ``{user_id}`` must run after auth and CSRF.

FastAPI solves route- and router-level ``dependencies=[...]`` *before* the
endpoint's own parameters. A limit keyed on ``user_path_identity`` declared
there counted requests before anyone checked who sent them, so an anonymous
caller — or a cross-site page riding a victim's cookies and failing CSRF —
could drain any user's budget just by naming them in the URL.

Every such limit now sits in the endpoint's parameters after the auth and CSRF
dependencies. This walks **every** route, so a new endpoint that reintroduces
the old shape fails here instead of in production.
"""
from __future__ import annotations

from core.auth.session import require_csrf_protection
from core.security.rate_limit import user_path_identity
from utils.validators import validate_userId, validate_userId_even_if_pending

# Either user-scope check counts as auth: the second is the same check, open to
# an account awaiting deletion (plan 32 — its status, cancel and the export).
_AUTH = (validate_userId, validate_userId_even_if_pending)


def _keys_on_path_user(call) -> bool:
    """Whether a dependency is a rate limit whose bucket is the path's user id."""
    for cell in getattr(call, "__closure__", None) or ():
        try:
            if cell.cell_contents is user_path_identity:
                return True
        except ValueError:  # an empty cell
            continue
    return False


def test_every_path_keyed_rate_limit_runs_after_auth_and_csrf(app):
    checked = 0
    for route in app.routes:
        dependant = getattr(route, "dependant", None)
        if dependant is None:
            continue
        calls = [dep.call for dep in dependant.dependencies]
        for limit_at, call in enumerate(calls):
            if not _keys_on_path_user(call):
                continue
            checked += 1
            assert any(auth in calls[:limit_at] for auth in _AUTH), f"{route.path}: rate limit runs before auth"
            if require_csrf_protection in calls:
                assert require_csrf_protection in calls[:limit_at], f"{route.path}: rate limit runs before CSRF"
    # Inference, messages, share, PDF export, suggestions, voice session, the
    # three speech routes, custom-skill upload, remote-skill add, the export
    # token, and requesting / cancelling an account deletion.
    assert checked >= 14
