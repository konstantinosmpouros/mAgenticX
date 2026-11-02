"""Version history of a user-authored agent, through the bridge routes.

The agents service keeps a copy of the definition on every save; the bridge
proxies the list, one version and a restore behind the catalog row's ownership
check. These pin that seam: someone else's id is a 404 before anything is asked
upstream, the wire shape is camelCase (the UI reads ``versionNo``, not
``version_no``), a restore refreshes the catalog row like an update, and the
agents service's 404 and 422 details reach the browser intact.

The agents service is played by ``agents_service`` (a MockTransport), so the
real proxy, error forwarding and row writes all run.
"""

import httpx
import pytest

from core.auth.session import require_csrf_protection
from core.database import AgentTable
from router import user_agents as routes
from utils import validate_userId

_CREATED = "2026-11-01T09:30:00Z"

# v3 was saved on top of v1 after v1 was restored, so it is based on v1, not v2.
_VERSIONS = [
    {
        "version_no": 3,
        "kind": "saved",
        "changes": ["instructions"],
        "restored_from": None,
        "based_on": 1,
        "current": True,
        "created_at": "2026-11-02T10:00:00",
    },
    {"version_no": 2, "kind": "saved", "changes": ["tools", "model"], "restored_from": None,
     "based_on": 1, "current": False, "created_at": _CREATED},
    {"version_no": 1, "kind": "created", "changes": [], "restored_from": None,
     "based_on": None, "current": False, "created_at": _CREATED},
]

_DETAIL = {
    **_VERSIONS[1],
    "spec": {"slug": "research-bot", "name": "Research Bot", "prompt": "./AGENT.md"},
    "files": [{"path": "AGENT.md", "content": "You are Research Bot.", "encoding": "utf-8", "size": 21}],
}


def _versions_path(user_id: str, suffix: str = "") -> str:
    return f"/users/{user_id}/custom-agents/research-bot/versions{suffix}"


def _summary(**extra) -> dict:
    return {
        "slug": "research-bot",
        "name": "Research Bot",
        "description": "Finds papers",
        "icon": "Search",
        "version": "1",
        "model": "openai:gpt-5",
        "tool_count": 3,
        "skill_count": 1,
        "subagent_count": 2,
        **extra,
    }


@pytest.fixture
def owned_agent(session_factory, seeded_user):
    """A custom agent row owned by the seeded user; returns its catalog id."""

    async def _make() -> str:
        async with session_factory() as session:
            row = AgentTable(
                owner_user_id=seeded_user.id, slug="research-bot", name="Research Bot",
                description="", icon="Bot", type="deep agent", is_active=True,
            )
            session.add(row)
            await session.commit()
            return row.id

    return _make


async def _row(session_factory, agent_id: str) -> AgentTable:
    async with session_factory() as session:
        return await session.get(AgentTable, agent_id)


# ---------------------------------------------------------------------------
# List + detail
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_list_is_camel_case_newest_first(client, agents_service, seeded_user, owned_agent):
    agent_id = await owned_agent()
    agents_service.on("GET", _versions_path(seeded_user.id), httpx.Response(200, json=_VERSIONS))

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/versions")

    assert response.status_code == 200
    body = response.json()
    assert [v["versionNo"] for v in body] == [3, 2, 1]
    assert body[0] == {
        "versionNo": 3,
        "kind": "saved",
        "changes": ["instructions"],
        "restoredFrom": None,
        "basedOn": 1,
        "current": True,
        # A naive upstream timestamp is sent as explicit UTC.
        "createdAt": "2026-11-02T10:00:00Z",
    }
    assert [(v["basedOn"], v["current"]) for v in body] == [(1, True), (1, False), (None, False)]


@pytest.mark.asyncio
async def test_a_legacy_restored_row_without_the_new_fields_still_lists(
    client, agents_service, seeded_user, owned_agent
):
    """Rows kept from before a restore stopped adding a version: ``restored``
    with ``restoredFrom`` set; ``basedOn``/``current`` default when absent."""
    agent_id = await owned_agent()
    legacy = {"version_no": 2, "kind": "restored", "changes": ["instructions"],
              "restored_from": 1, "created_at": _CREATED}
    agents_service.on("GET", _versions_path(seeded_user.id), httpx.Response(200, json=[legacy]))

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/versions")

    assert response.status_code == 200
    [row] = response.json()
    assert (row["kind"], row["restoredFrom"], row["basedOn"], row["current"]) == ("restored", 1, None, False)


@pytest.mark.asyncio
async def test_detail_is_camel_case_with_spec_and_files(client, agents_service, seeded_user, owned_agent):
    agent_id = await owned_agent()
    agents_service.on("GET", _versions_path(seeded_user.id, "/2"), httpx.Response(200, json=_DETAIL))

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/versions/2")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "versionNo", "kind", "changes", "restoredFrom", "basedOn", "current", "createdAt", "spec", "files",
    }
    assert (body["basedOn"], body["current"]) == (1, False)
    assert body["versionNo"] == 2 and body["changes"] == ["tools", "model"]
    assert body["spec"] == _DETAIL["spec"]
    assert body["files"] == _DETAIL["files"]


@pytest.mark.asyncio
async def test_version_zero_is_refused_before_upstream(client, agents_service, seeded_user, owned_agent):
    agent_id = await owned_agent()

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/versions/0")

    assert response.status_code == 422
    assert agents_service.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("suffix", "detail"), [("", "Unknown agent."), ("/9", "Unknown version.")]
)
async def test_an_upstream_404_is_forwarded(client, agents_service, seeded_user, owned_agent, suffix, detail):
    agent_id = await owned_agent()
    agents_service.on("GET", _versions_path(seeded_user.id, suffix), httpx.Response(404, json={"detail": detail}))

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/versions{suffix}")

    assert response.status_code == 404
    assert response.json() == {"detail": detail}


@pytest.mark.asyncio
async def test_a_malformed_upstream_list_is_a_502(client, agents_service, seeded_user, owned_agent):
    """Output validation: a body off the contract never reaches the browser."""
    agent_id = await owned_agent()
    agents_service.on(
        "GET", _versions_path(seeded_user.id),
        httpx.Response(200, json=[{"version_no": 1, "kind": "deleted", "created_at": _CREATED}]),
    )

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/versions")

    assert response.status_code == 502
    assert response.json() == {"detail": "The agent's history could not be loaded. Please try again."}


# ---------------------------------------------------------------------------
# Ownership
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_another_users_agent_is_404_on_every_route_without_calling_upstream(
    client, agents_service, owned_agent
):
    agent_id = await owned_agent()
    base = f"/v1/agents/someone-else/custom/{agent_id}/versions"

    listed = await client.get(base)
    detail = await client.get(f"{base}/1")
    restored = await client.post(f"{base}/1/restore")

    assert (listed.status_code, detail.status_code, restored.status_code) == (404, 404, 404)
    assert agents_service.calls == []


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_restore_refreshes_the_catalog_row(
    client, agents_service, seeded_user, owned_agent, session_factory
):
    agent_id = await owned_agent()
    agents_service.on(
        "POST", _versions_path(seeded_user.id, "/1/restore"),
        httpx.Response(200, json=_summary(name="Old Name", icon="Book", description="Earlier", tool_count=1)),
    )

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/versions/1/restore")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == agent_id and body["kind"] == "custom" and body["isActive"] is True
    assert (body["name"], body["icon"], body["toolCount"]) == ("Old Name", "Book", 1)
    row = await _row(session_factory, agent_id)
    assert (row.name, row.icon, row.description) == ("Old Name", "Book", "Earlier")
    assert agents_service.called("POST", _versions_path(seeded_user.id, "/1/restore"))


@pytest.mark.asyncio
async def test_a_refused_restore_forwards_the_issues_and_leaves_the_row(
    client, agents_service, seeded_user, owned_agent, session_factory
):
    """A version naming a since-removed skill is refused like a save; the
    builder needs the object detail whole to show which field."""
    agent_id = await owned_agent()
    detail = {
        "message": "The agent definition is invalid.",
        "errors": ["skills.0: unknown skill"],
        "issues": [{"path": "skills.0", "message": "unknown skill", "severity": "error"}],
    }
    agents_service.on(
        "POST", _versions_path(seeded_user.id, "/1/restore"), httpx.Response(422, json={"detail": detail})
    )

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/versions/1/restore")

    assert response.status_code == 422
    assert response.json() == {"detail": detail}
    assert (await _row(session_factory, agent_id)).name == "Research Bot"


@pytest.mark.asyncio
async def test_restoring_an_unknown_version_is_404(client, agents_service, seeded_user, owned_agent):
    agent_id = await owned_agent()
    agents_service.on(
        "POST", _versions_path(seeded_user.id, "/9/restore"),
        httpx.Response(404, json={"detail": "Unknown version."}),
    )

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/versions/9/restore")

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown version."}


def test_version_routes_are_session_scoped_and_restore_is_csrf_protected():
    """Every route binds the path user to the session; restore mutates the
    agent, so it carries the CSRF dependency like update."""
    by_path = {(r.path, tuple(sorted(r.methods))): r for r in routes.router.routes}
    base = "/{user_id}/custom/{agent_id}/versions"
    listed = by_path[(base, ("GET",))]
    detail = by_path[(f"{base}/{{version_no}}", ("GET",))]
    restore = by_path[(f"{base}/{{version_no}}/restore", ("POST",))]
    for route in (listed, detail, restore):
        assert validate_userId in {dep.call for dep in route.dependant.dependencies}
    assert require_csrf_protection in {dep.call for dep in restore.dependant.dependencies}
