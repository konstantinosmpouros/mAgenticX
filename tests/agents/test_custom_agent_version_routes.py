"""A custom agent's version history over HTTP (plan 37).

The ``/versions`` routes end to end on the in-memory definition store: what a
create and an edit leave behind, reading one version whole, restoring (which
adds no version — it makes that version current again; re-validated, so a
version that would no longer pass is a 422), the history going with the agent,
and the 404s. The recording rules themselves —
baseline, cap, no-op saves — are pinned against the real store in
``test_agent_definition_versions.py``.
"""
import importlib

import pytest

USER = "user-1"
BASE = f"/users/{USER}/custom-agents"


def _spec(**overrides):
    spec = {
        "id": "helper-v1",
        "slug": "helper",
        "name": "Helper",
        "version": "1.0.0",
        "type": "deep_agent",
        "description": "Helps.",
        "prompt": "./AGENT.md",
        "model": {"main": "openai:gpt-5"},
    }
    spec.update(overrides)
    return spec


def _files(prompt="You help."):
    return [{"path": "AGENT.md", "content": prompt}]


@pytest.fixture
def builder(agents_service, definition_store_memory, monkeypatch):
    """The routes with a skill pool of one (``notes``) and MCP off."""
    routes = importlib.import_module("router.user_agents")
    pool = {"names": ["notes"]}

    async def skills(_user_id):
        return list(pool["names"])

    monkeypatch.setattr(routes, "list_user_skill_names", skills)
    monkeypatch.setattr(agents_service.settings_module.settings.mcp, "mcp_gateway_url", "")
    monkeypatch.setattr(routes, "skill_pool", pool, raising=False)
    return routes


async def _create(client, headers, **spec):
    response = await client.post(BASE, json={"spec": _spec(**spec), "files": _files()}, headers=headers)
    assert response.status_code == 201, response.text


async def _update(client, headers, prompt="You help.", **spec):
    response = await client.put(
        f"{BASE}/helper", json={"spec": _spec(**spec), "files": _files(prompt)}, headers=headers
    )
    assert response.status_code == 200, response.text


async def _versions(client, headers):
    response = await client.get(f"{BASE}/helper/versions", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Listing and reading
# ---------------------------------------------------------------------------
async def test_a_new_agent_has_one_created_version(client, internal_headers, builder):
    await _create(client, internal_headers)
    [only] = await _versions(client, internal_headers)
    assert only["version_no"] == 1 and only["kind"] == "created"
    assert only["changes"] == [] and only["restored_from"] is None
    assert only["based_on"] is None and only["current"] is True
    assert "spec" not in only and "files" not in only      # the list carries no content


async def test_an_edit_adds_a_version_naming_what_changed_newest_first(client, internal_headers, builder):
    await _create(client, internal_headers)
    await _update(client, internal_headers, prompt="You help, briefly.", name="Helper 2")
    versions = await _versions(client, internal_headers)
    assert [(v["version_no"], v["kind"]) for v in versions] == [(2, "saved"), (1, "created")]
    assert versions[0]["changes"] == ["details", "instructions"]
    assert [(v["based_on"], v["current"]) for v in versions] == [(1, True), (None, False)]


async def test_saving_without_a_change_adds_nothing(client, internal_headers, builder):
    await _create(client, internal_headers)
    await _update(client, internal_headers)
    assert len(await _versions(client, internal_headers)) == 1


async def test_one_version_reads_back_whole(client, internal_headers, builder):
    await _create(client, internal_headers)
    await _update(client, internal_headers, prompt="Changed.")
    response = await client.get(f"{BASE}/helper/versions/1", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "created" and body["spec"]["name"] == "Helper"
    assert [(f["path"], f["content"]) for f in body["files"]] == [("AGENT.md", "You help.")]


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
async def test_a_restore_adds_no_version_and_makes_it_current(
    client, internal_headers, builder, definition_store_memory
):
    await _create(client, internal_headers)
    await _update(client, internal_headers, prompt="Changed.", name="Renamed")

    response = await client.post(f"{BASE}/helper/versions/1/restore", headers=internal_headers)
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Helper"

    versions = await _versions(client, internal_headers)
    assert [(v["version_no"], v["kind"], v["current"]) for v in versions] == [
        (2, "saved", False), (1, "created", True),
    ]
    assert definition_store_memory.files[(USER, "helper")]["AGENT.md"][0] == "You help."


async def test_restoring_the_previously_current_version_undoes_a_restore(
    client, internal_headers, builder, definition_store_memory
):
    await _create(client, internal_headers)
    await _update(client, internal_headers, prompt="Changed.", name="Renamed")
    before = await _versions(client, internal_headers)

    assert (await client.post(f"{BASE}/helper/versions/1/restore", headers=internal_headers)).status_code == 200
    undo = await client.post(f"{BASE}/helper/versions/2/restore", headers=internal_headers)
    assert undo.status_code == 200 and undo.json()["name"] == "Renamed"

    assert await _versions(client, internal_headers) == before
    assert definition_store_memory.files[(USER, "helper")]["AGENT.md"][0] == "Changed."


async def test_a_save_after_a_restore_builds_on_the_restored_version(client, internal_headers, builder):
    await _create(client, internal_headers)
    await _update(client, internal_headers, prompt="Changed.", name="Renamed")
    assert (await client.post(f"{BASE}/helper/versions/1/restore", headers=internal_headers)).status_code == 200

    # Against v1 only the prompt differs — the rename in v2 is not counted.
    await _update(client, internal_headers, prompt="Sharper.")

    latest, *rest = await _versions(client, internal_headers)
    assert (latest["version_no"], latest["kind"], latest["based_on"]) == (3, "saved", 1)
    assert latest["changes"] == ["instructions"] and latest["current"] is True
    assert not any(v["current"] for v in rest)


async def test_a_version_that_no_longer_validates_is_a_422_and_writes_nothing(
    client, internal_headers, builder
):
    await _create(client, internal_headers, skills=["notes"])
    await _update(client, internal_headers, skills=[])
    builder.skill_pool["names"] = []                     # the skill has since been removed

    response = await client.post(f"{BASE}/helper/versions/1/restore", headers=internal_headers)
    assert response.status_code == 422
    assert "skills.0" in {i["path"] for i in response.json()["detail"]["issues"]}
    assert len(await _versions(client, internal_headers)) == 2


# ---------------------------------------------------------------------------
# Delete, 404s, internal-only
# ---------------------------------------------------------------------------
async def test_deleting_the_agent_takes_its_history(client, internal_headers, builder, definition_store_memory):
    await _create(client, internal_headers)
    await _update(client, internal_headers, prompt="Changed.")
    assert (await client.delete(f"{BASE}/helper", headers=internal_headers)).status_code == 204
    assert (USER, "helper") not in definition_store_memory.versions
    assert (await client.get(f"{BASE}/helper/versions", headers=internal_headers)).status_code == 404


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/nope/versions"),
        ("get", "/nope/versions/1"),
        ("post", "/nope/versions/1/restore"),
        ("get", "/helper/versions/9"),
        ("post", "/helper/versions/9/restore"),
    ],
)
async def test_an_unknown_agent_or_version_is_404(client, internal_headers, builder, method, path):
    await _create(client, internal_headers)
    response = await getattr(client, method)(f"{BASE}{path}", headers=internal_headers)
    assert response.status_code == 404


async def test_version_zero_is_not_a_version(client, internal_headers, builder):
    await _create(client, internal_headers)
    assert (await client.get(f"{BASE}/helper/versions/0", headers=internal_headers)).status_code == 422


async def test_the_version_routes_need_an_internal_caller(client, builder):
    assert (await client.get(f"{BASE}/helper/versions")).status_code in (401, 403)
    assert (await client.get(f"{BASE}/helper/versions/1")).status_code in (401, 403)
    assert (await client.post(f"{BASE}/helper/versions/1/restore")).status_code in (401, 403)
