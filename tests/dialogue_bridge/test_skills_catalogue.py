"""The bridge's two plan-30 routes, at the HTTP edge.

The forwarding itself is pinned in ``test_skills.py``. These pin what must hold
before anything is forwarded: a session for search, a session *and* CSRF for an
Add, and that the removed catalogue endpoint is really gone rather than quietly
answering with an empty list.
"""
from __future__ import annotations

import pytest

from core.auth.session import require_csrf_protection
from utils.validators import validate_userId


@pytest.mark.asyncio
async def test_catalogue_search_requires_a_session(client):
    response = await client.get("/v1/skills/catalogue?q=postgres")
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_remote_add_requires_a_session(app, client):
    # The shared test app stubs auth out; put the real checks back for this one.
    app.dependency_overrides.pop(validate_userId, None)
    app.dependency_overrides.pop(require_csrf_protection, None)
    response = await client.post("/v1/skills/users/u1/remote/ecc/postgres-patterns")
    assert response.status_code in (401, 403)



@pytest.mark.asyncio
async def test_the_bundled_catalogue_endpoint_is_gone(client):
    # Plan 30 deleted the bundled catalogue; a client still calling the old
    # list endpoint must fail loudly, not receive a plausible empty answer.
    response = await client.get("/v1/skills")
    assert response.status_code in (404, 405)


def test_both_routes_are_registered_with_their_rate_limits(app):
    """Search keys its limit on the verified session (there is no user id in its
    path); the Add keys on the path's user id. Both must be wired, because the
    global budget alone is fail-open and the Add can trigger a download."""
    routes = {getattr(r, "path", ""): r for r in app.routes}
    search = routes["/v1/skills/catalogue"]
    add = routes["/v1/skills/users/{user_id}/remote/{source_id}/{skill_id}"]
    for route in (search, add):
        names = {getattr(dep.call, "__qualname__", "") for dep in route.dependant.dependencies}
        assert any("rate_limit" in name or "_dependency" in name for name in names), route.path
