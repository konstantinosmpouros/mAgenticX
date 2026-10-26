"""The agent builder's backend over HTTP (plan 44, P1).

The custom-agent routes end to end on the in-memory definition store: issues
pinned to paths, the structured 422, the atomic create, YAML import and export,
and the two catalogs the builder reads before an agent exists (models, built-in
tools). The tree and prompt rules themselves are covered at the model level in
``test_nested_subagent_build.py``.
"""
import base64
import importlib
import io
import zipfile

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


def _files(*extra):
    return [{"path": "AGENT.md", "content": "You help."}, *extra]


def _sub(name, *, prompt=None, subagents=None, **rest):
    node = {"name": name, "description": f"The {name}.", "prompt": prompt or f"./subagents/{name}.md", **rest}
    if subagents:
        node["subagents"] = subagents
    return node


@pytest.fixture
def builder(agents_service, definition_store_memory, monkeypatch):
    """The routes with an empty skill pool and MCP off, unless a test says otherwise."""
    routes = importlib.import_module("router.user_agents")

    async def no_skills(_user_id):
        return []

    monkeypatch.setattr(routes, "list_user_skill_names", no_skills)
    _mcp(agents_service, monkeypatch, on=False)
    return routes


def _mcp(agents_service, monkeypatch, *, on):
    """MCP is on exactly when a gateway URL is configured."""
    url = "http://mcp-gateway.test/sse" if on else ""
    monkeypatch.setattr(agents_service.settings_module.settings.mcp, "mcp_gateway_url", url)


def _paths(body):
    return {issue["path"]: issue for issue in body["issues"]}


# ---------------------------------------------------------------------------
# Catalogs
# ---------------------------------------------------------------------------
async def test_models_lists_the_allowlist_with_one_default(client, agents_service, internal_headers):
    response = await client.get("/models", headers=internal_headers)
    assert response.status_code == 200
    models = response.json()
    allowed = list(agents_service.settings_module.settings.registry.allowed_agent_models)
    assert [m["id"] for m in models] == allowed
    assert sum(m["default"] for m in models) == 1
    assert {m["id"]: m["label"] for m in models}["openai:gpt-4o-mini"] == "GPT-4o mini"


@pytest.mark.parametrize(
    ("model_id", "label"),
    [
        ("openai:gpt-5", "GPT-5"),
        ("openai:gpt-6-luna", "GPT-6 Luna"),
        ("openai:gpt-4o", "GPT-4o"),
        ("openai:gpt-4o-mini", "GPT-4o mini"),
        ("anthropic:claude-opus", "Claude Opus"),
    ],
)
def test_model_labels_read_as_people_say_them(agents_service, model_id, label):
    assert agents_service.user_agents.model_label(model_id) == label


async def test_builtin_tools_say_how_their_approval_behaves(client, internal_headers):
    response = await client.get("/builtin-tools", headers=internal_headers)
    assert response.status_code == 200
    tools = {t["name"]: t for t in response.json()}
    assert tools["execute"]["locked"] and tools["execute"]["hitlDefault"]
    assert not tools["ask_user"]["gateable"] and tools["ask_user"]["mainOnly"]
    assert tools["write_file"]["hitlDefault"] and not tools["write_file"]["locked"]
    assert not tools["read_file"]["hitlDefault"]
    assert tools["write_file"]["group"] == "Filesystem"


async def test_catalogs_need_an_internal_caller(client):
    assert (await client.get("/models")).status_code in (401, 403)
    assert (await client.get("/builtin-tools")).status_code in (401, 403)


# ---------------------------------------------------------------------------
# Create / update
# ---------------------------------------------------------------------------
async def test_create_returns_the_counts_the_gallery_shows(client, internal_headers, builder):
    spec = _spec(
        subagents=[_sub("researcher", subagents=[_sub("checker")]), _sub("writer")],
    )
    files = _files(
        {"path": "subagents/researcher.md", "content": "Research."},
        {"path": "subagents/checker.md", "content": "Check."},
        {"path": "subagents/writer.md", "content": "Write."},
    )
    response = await client.post(BASE, json={"spec": spec, "files": files}, headers=internal_headers)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["model"] == "openai:gpt-5"
    assert body["subagent_count"] == 3
    assert body["tool_count"] == 0 and body["skill_count"] == 0

    listed = (await client.get(BASE, headers=internal_headers)).json()
    assert listed[0]["subagent_count"] == 3


async def test_a_second_create_of_the_same_slug_is_409(client, internal_headers, builder):
    payload = {"spec": _spec(), "files": _files()}
    assert (await client.post(BASE, json=payload, headers=internal_headers)).status_code == 201
    second = await client.post(BASE, json=payload, headers=internal_headers)
    assert second.status_code == 409


async def test_a_create_that_loses_the_race_is_409_not_a_silent_replace(
    client, internal_headers, builder, definition_store_memory, monkeypatch
):
    # Another request created the slug after this one's list check.
    await definition_store_memory.save(USER, "helper", spec=_spec(name="First"), files={})

    async def stale_list(_user_id):
        return []

    monkeypatch.setattr(builder, "list_user_agents", stale_list)
    response = await client.post(BASE, json={"spec": _spec(name="Second"), "files": _files()}, headers=internal_headers)
    assert response.status_code == 409
    assert definition_store_memory.specs[(USER, "helper")]["name"] == "First"


async def test_the_cap_is_429(client, agents_service, internal_headers, builder, monkeypatch):
    monkeypatch.setattr(agents_service.settings_module.settings.registry, "max_agents_per_user", 1)
    assert (await client.post(BASE, json={"spec": _spec(), "files": _files()}, headers=internal_headers)).status_code == 201
    other = _spec(slug="other", id="other-v1", name="Other")
    response = await client.post(BASE, json={"spec": other, "files": _files()}, headers=internal_headers)
    assert response.status_code == 429


async def test_an_invalid_write_is_a_422_with_every_issue_pinned(client, internal_headers, builder):
    spec = _spec(
        name="",
        subagents=[
            _sub("Researcher!", subagents=[_sub("a", subagents=[_sub("b", subagents=[_sub("too-deep")])])]),
            _sub("writer", description=""),
        ],
        hitl={"execute": False, "ask_user": True, "nope": True},
    )
    response = await client.post(BASE, json={"spec": spec, "files": _files()}, headers=internal_headers)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["errors"] and detail["message"]
    paths = {issue["path"] for issue in detail["issues"]}
    assert "name" in paths
    assert "subagents.0.name" in paths                                   # not a slug
    assert "subagents.0.subagents.0.subagents.0.subagents.0" in paths    # a fourth level
    assert "subagents.1.description" in paths


async def test_gates_must_name_tools_the_agent_has_and_respect_locks(client, internal_headers, builder):
    spec = _spec(hitl={"execute": False, "ask_user": True, "nope": True, "write_file": False})
    body = (await client.post(f"{BASE}/validate", json={"spec": spec, "files": _files()}, headers=internal_headers)).json()
    issues = _paths(body)
    assert not body["valid"]
    assert "always asks" in issues["hitl.execute"]["message"]
    assert "hitl.ask_user" in issues
    assert "hitl.nope" in issues
    assert "hitl.write_file" not in issues      # turning a default gate off is the user's choice


async def test_missing_prompt_files_point_at_the_node(client, internal_headers, builder):
    spec = _spec(subagents=[_sub("researcher", subagents=[_sub("checker")])])
    files = _files({"path": "subagents/researcher.md", "content": "Research."})
    body = (await client.post(f"{BASE}/validate", json={"spec": spec, "files": files}, headers=internal_headers)).json()
    assert not body["valid"]
    assert "subagents.0.subagents.0.prompt" in _paths(body)


async def test_a_base64_file_that_is_not_text_is_an_issue_not_a_500(client, internal_headers, builder):
    binary = base64.b64encode(b"\xff\xfe\x00binary").decode()
    files = _files({"path": "notes.md", "content": binary, "encoding": "base64"})
    response = await client.post(BASE, json={"spec": _spec(), "files": files}, headers=internal_headers)
    assert response.status_code == 422
    assert "files[notes.md]" in {i["path"] for i in response.json()["detail"]["issues"]}


async def test_a_slug_cannot_change_on_update(client, internal_headers, builder):
    assert (await client.post(BASE, json={"spec": _spec(), "files": _files()}, headers=internal_headers)).status_code == 201
    renamed = _spec(slug="renamed", id="renamed-v1")
    response = await client.put(f"{BASE}/helper", json={"spec": renamed, "files": _files()}, headers=internal_headers)
    assert response.status_code == 422
    assert "slug" in {i["path"] for i in response.json()["detail"]["issues"]}


# ---------------------------------------------------------------------------
# MCP tools against the gateway
# ---------------------------------------------------------------------------
MCP_SPEC = _spec(tools=[{"server_id": "search", "tool_name": "web"}, {"server_id": "search", "tool_name": "gone"}])


async def test_mcp_off_is_a_warning_and_still_valid(client, internal_headers, builder):
    body = (await client.post(f"{BASE}/validate", json={"spec": MCP_SPEC, "files": _files()}, headers=internal_headers)).json()
    assert body["valid"]
    assert _paths(body)["tools"]["severity"] == "warning"


async def test_an_unknown_mcp_tool_is_an_error_on_its_row(client, agents_service, internal_headers, builder, monkeypatch):
    _mcp(agents_service, monkeypatch, on=True)

    async def catalog():
        return frozenset({"search/web"})

    monkeypatch.setattr(builder, "known_mcp_tool_keys", catalog)
    body = (await client.post(f"{BASE}/validate", json={"spec": MCP_SPEC, "files": _files()}, headers=internal_headers)).json()
    issues = _paths(body)
    assert not body["valid"]
    assert "tools.1" in issues and "tools.0" not in issues


async def test_a_gateway_outage_only_warns(client, agents_service, internal_headers, builder, monkeypatch):
    _mcp(agents_service, monkeypatch, on=True)

    async def down():
        return None

    monkeypatch.setattr(builder, "known_mcp_tool_keys", down)
    body = (await client.post(f"{BASE}/validate", json={"spec": MCP_SPEC, "files": _files()}, headers=internal_headers)).json()
    assert body["valid"]
    assert _paths(body)["tools"]["severity"] == "warning"


# ---------------------------------------------------------------------------
# Import / export
# ---------------------------------------------------------------------------
HAND_WRITTEN = """\
name: Vendor Research
description: Compares vendors.
prompt: |
  You compare vendors and report the differences.
model: openai:gpt-5
subagents:
  - name: researcher
    description: Looks up one vendor's pricing and terms.
    prompt: Find the pricing page and summarise it.
    subagents:
      - name: fact-checker
        description: Checks one claim against a second source.
        prompt: Verify the claim you are given.
"""


async def test_a_hand_written_yaml_imports_with_inline_prompts_moved_to_files(client, internal_headers, builder):
    response = await client.post(f"{BASE}/import", json={"yaml": HAND_WRITTEN}, headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["valid"], body["issues"]
    spec = body["spec"]
    assert spec["slug"] == "vendor-research" and spec["id"] == "vendor-research-v1"
    assert spec["type"] == "deep_agent" and spec["model"] == {"main": "openai:gpt-5"}
    assert spec["prompt"] == "./AGENT.md"
    checker = spec["subagents"][0]["subagents"][0]
    assert checker["prompt"] == "./subagents/researcher--fact-checker.md"
    paths = {f["path"] for f in body["files"]}
    assert paths == {"AGENT.md", "subagents/researcher.md", "subagents/researcher--fact-checker.md"}
    # Nothing was saved.
    assert (await client.get(BASE, headers=internal_headers)).json() == []


async def test_a_yaml_that_does_not_parse_says_where(client, internal_headers, builder):
    body = (await client.post(f"{BASE}/import", json={"yaml": "name: x\n  bad: [\n"}, headers=internal_headers)).json()
    assert not body["valid"] and body["spec"] is None
    assert "line" in body["issues"][0]["message"]


async def test_an_invalid_import_still_returns_the_spec_to_fix_in_the_form(client, internal_headers, builder):
    text = HAND_WRITTEN.replace("model: openai:gpt-5", "model: openai:not-allowed")
    body = (await client.post(f"{BASE}/import", json={"yaml": text}, headers=internal_headers)).json()
    assert not body["valid"]
    assert body["spec"]["name"] == "Vendor Research"
    assert "model.main" in _paths(body)


async def test_export_is_a_zip_that_imports_back_to_the_same_agent(client, internal_headers, builder):
    created = (await client.post(f"{BASE}/import", json={"yaml": HAND_WRITTEN}, headers=internal_headers)).json()
    write = {"spec": created["spec"], "files": created["files"]}
    assert (await client.post(BASE, json=write, headers=internal_headers)).status_code == 201

    response = await client.get(f"{BASE}/vendor-research/export", headers=internal_headers)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert 'filename="vendor-research.zip"' in response.headers["content-disposition"]

    archive = zipfile.ZipFile(io.BytesIO(response.content))
    names = set(archive.namelist())
    assert "agent.yaml" in names and "subagents/researcher--fact-checker.md" in names
    manifest = archive.read("agent.yaml").decode()
    assert manifest.startswith("id: vendor-research-v1\nslug: vendor-research\n")

    files = [{"path": n, "content": archive.read(n).decode()} for n in names if n != "agent.yaml"]
    again = (await client.post(f"{BASE}/import", json={"yaml": manifest, "files": files}, headers=internal_headers)).json()
    assert again["valid"], again["issues"]
    stored = (await client.get(f"{BASE}/vendor-research", headers=internal_headers)).json()["spec"]
    assert again["spec"]["subagents"][0]["subagents"][0]["name"] == stored["subagents"][0]["subagents"][0]["name"]
    assert again["spec"]["prompt"] == stored["prompt"]


async def test_export_of_an_unknown_agent_is_404(client, internal_headers, builder):
    assert (await client.get(f"{BASE}/nope/export", headers=internal_headers)).status_code == 404


# ---------------------------------------------------------------------------
# The runtime
# ---------------------------------------------------------------------------
def test_a_tool_listed_twice_reaches_the_model_once(agents_service):
    deep_agent = importlib.import_module("harness.abstractions.deep_agent")

    class Named:
        def __init__(self, name):
            self.name = name

    first, again, other = Named("render_chart"), Named("render_chart"), Named("ls")
    assert deep_agent._unique_by_name([first, other, again]) == [first, other]
