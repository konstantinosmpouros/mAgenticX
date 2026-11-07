"""Trial runs of an uncommitted draft (plan 40, "Try it"), P1: the agents service.

The bridge sends the builder's draft inline as ``definition`` on ``/stream`` and
on every ``/resume`` leg. These pin what the service does with it: validate it
like a save, build it uncached for the owner, serve ``/reference/`` from the
draft's own files, and never let it stand in for the saved agent of the same
slug on a normal run.
"""
from __future__ import annotations

import importlib
from types import SimpleNamespace

import pytest

USER = "user-1"
SLUG = "helper"
MODEL = "openai:gpt-5"


def _sub(name, *children):
    node = {"name": name, "description": f"The {name}.", "prompt": f"./subagents/{name}.md"}
    if children:
        node["subagents"] = list(children)
    return node


def _spec(**overrides):
    spec = {
        "id": "helper-v1",
        "slug": SLUG,
        "name": "Helper",
        "version": "1.0.0",
        "type": "deep_agent",
        "description": "Helps.",
        "prompt": "./AGENT.md",
        "model": {"main": MODEL},
        # Three levels below the agent: the deepest tree a definition may have.
        "subagents": [_sub("researcher", _sub("checker", _sub("verifier"))), _sub("writer")],
    }
    spec.update(overrides)
    return spec


def _files(prompt="You are the draft."):
    return [
        {"path": "AGENT.md", "content": prompt},
        {"path": "notes.md", "content": "draft notes"},
        *({"path": f"subagents/{name}.md", "content": f"You are the {name}."}
          for name in ("researcher", "checker", "verifier", "writer")),
    ]


def _draft(**overrides):
    return {"spec": _spec(**overrides), "files": _files()}


def _context(owner=USER):
    context = {"user_id": USER, "conversation_id": "conv-1", "run_id": "run-1"}
    if owner is not None:
        context["agent_owner_id"] = owner
    return {"context": context, "run_config": {"configurable": {"thread_id": "thread-1"}}}


class _NoSession:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def trial(agents_service, definition_store_memory, monkeypatch):
    """The real build path with the run itself stubbed out.

    Validation runs for real (empty skill pool, MCP off, the default model
    allowlist); the agent is a real ``YamlDeepAgent``. Only the model call and
    the checkpoint bookkeeping are replaced, and the built agent is captured.
    """
    routes = importlib.import_module("router.user_agents")
    yaml_agent = importlib.import_module("harness.abstractions.yaml_agent")
    inference = agents_service.router_inference
    built = []

    async def no_skills(_user_id):
        return []

    async def fake_astream(self, payload):
        built.append(self)
        yield b"data: draft\n\n"

    async def no_commit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(routes, "list_user_skill_names", no_skills)
    monkeypatch.setattr(agents_service.settings_module.settings.mcp, "mcp_gateway_url", "")
    monkeypatch.setattr(yaml_agent.YamlDeepAgent, "astream", fake_astream)
    monkeypatch.setattr(inference, "optional_mcp_session", lambda: _NoSession())
    monkeypatch.setattr(inference, "emit_checkpoint_committed", no_commit)
    monkeypatch.setattr(inference, "release_checkpoint_unless_paused", no_commit)
    return SimpleNamespace(built=built, store=definition_store_memory, yaml_agent=yaml_agent)


async def _save_agent(store):
    """A saved agent under the same slug, with prompt and notes of its own."""
    await store.save(
        USER, SLUG,
        spec=_spec(subagents=[]),
        files={"AGENT.md": ("You are the saved agent.", "utf-8"), "notes.md": ("saved notes", "utf-8")},
    )


def _stream(client, headers, *, slug=SLUG, definition=None, owner=USER):
    body = {"messages": [{"role": "user", "content": "Hi"}], "config": _context(owner)}
    if definition is not None:
        body["definition"] = definition
    return client.post(f"/agents/{slug}/stream", headers=headers, json=body)


# ---------------------------------------------------------------------------
# Stream
# ---------------------------------------------------------------------------
async def test_a_trial_builds_from_a_three_level_draft(client, internal_headers, trial):
    response = await _stream(client, internal_headers, definition=_draft())

    assert response.status_code == 200, response.text
    assert response.text == "data: draft\n\n"
    [agent] = trial.built
    assert isinstance(agent, trial.yaml_agent.YamlDeepAgent)
    assert agent.instructions == "You are the draft."
    assert agent.is_user_authored
    [researcher, _writer] = agent._spec.subagents
    assert researcher.subagents[0].subagents[0].name == "verifier"


async def test_a_trial_is_never_cached_and_never_shadows_the_saved_agent(
    client, agents_service, internal_headers, trial
):
    await _save_agent(trial.store)
    utils = agents_service.agents_utils

    response = await _stream(client, internal_headers, definition=_draft())
    assert response.status_code == 200, response.text
    assert trial.built[-1].instructions == "You are the draft."
    assert (USER, SLUG) not in utils._USER_AGENT_CACHE

    # A normal run of the same slug resolves the saved definition…
    response = await _stream(client, internal_headers)
    assert response.status_code == 200, response.text
    assert trial.built[-1].instructions == "You are the saved agent."

    # …and once it is cached, a trial still builds its own draft.
    response = await _stream(client, internal_headers, definition=_draft())
    assert trial.built[-1].instructions == "You are the draft."
    saved = await utils.resolve_agent_definition(SLUG, USER)
    assert saved.build(config=_context()).instructions == "You are the saved agent."


async def test_an_invalid_draft_is_a_422_with_its_issues(client, internal_headers, trial):
    draft = _draft()
    draft["files"] = [f for f in draft["files"] if f["path"] != "subagents/verifier.md"]

    response = await _stream(client, internal_headers, definition=draft)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert set(detail) == {"message", "errors", "issues"}
    paths = [issue["path"] for issue in detail["issues"]]
    assert "subagents.0.subagents.0.subagents.0.prompt" in paths
    assert trial.built == []


async def test_a_reserved_slug_is_refused_like_a_save(client, agents_service, internal_headers, trial):
    reserved = next(iter(agents_service.agents_utils.AGENT_REGISTRY))

    response = await _stream(client, internal_headers, slug=reserved, definition=_draft(slug=reserved))

    assert response.status_code == 422
    assert any(issue["path"] == "slug" for issue in response.json()["detail"]["issues"])


async def test_the_url_slug_must_be_the_drafts(client, internal_headers, trial):
    response = await _stream(client, internal_headers, slug="other", definition=_draft())

    assert response.status_code == 400
    assert trial.built == []


async def test_a_trial_needs_an_owner(client, internal_headers, trial):
    response = await _stream(client, internal_headers, definition=_draft(), owner=None)

    assert response.status_code == 400
    assert trial.built == []


# ---------------------------------------------------------------------------
# /reference/
# ---------------------------------------------------------------------------
def _reference(agent):
    return agent._build_composite_backend().routes["/reference/"]


async def test_a_trials_reference_reads_the_drafts_files_not_the_saved_ones(agents_service, trial):
    await _save_agent(trial.store)
    utils = agents_service.agents_utils
    schema = agents_service.schemas
    files = [schema.AgentFile(**f) for f in _files()]
    spec = importlib.import_module("harness.abstractions.agent_spec").AgentSpec.model_validate(_spec())
    texts = agents_service.user_agents.definition_texts(files)

    agent = utils.build_trial_definition(USER, spec, texts).build(config=_context())

    assert agent.reference_namespace is None
    assert agent._has_reference
    route = _reference(agent)
    assert isinstance(route._store, agents_service.definition_store.DraftDefinitionStore)
    result = agent._build_composite_backend().read("/reference/notes.md")
    assert result.error is None
    assert result.file_data["content"] == "draft notes"

    # The saved agent keeps reading its own rows.
    saved = (await utils.resolve_agent_definition(SLUG, USER)).build(config=_context())
    assert saved.reference_files is None
    assert saved.reference_namespace == (USER, SLUG)


def test_the_draft_reference_store_lists_and_refuses_writes(agents_service):
    store_module = agents_service.definition_store
    base = importlib.import_module("langgraph.store.base")
    store = store_module.DraftDefinitionStore({"AGENT.md": "a", "subagents/w.md": "w"})

    [items] = store.batch([base.SearchOp(namespace_prefix=("draft",))])
    assert [item.key for item in items] == ["/AGENT.md", "/subagents/w.md"]
    [missing] = store.batch([base.GetOp(namespace=("draft",), key="/nope.md")])
    assert missing is None
    [written] = store.batch([base.PutOp(namespace=("draft",), key="/AGENT.md", value={"content": "x"})])
    assert written is None
    [item] = store.batch([base.GetOp(namespace=("draft",), key="/AGENT.md")])
    assert item.value["content"] == "a"


# ---------------------------------------------------------------------------
# Resume
# ---------------------------------------------------------------------------
@pytest.fixture
def paused_nowhere(agents_service, trial, monkeypatch):
    """Resume up to the checkpoint read, which finds nothing pending (409).

    Enough to prove the definition was resolved and the agent built from it.
    """
    yaml_agent = trial.yaml_agent

    async def ensure_built(self):
        trial.built.append(self)

    class _Graph:
        async def aget_state(self, _config):
            return SimpleNamespace(interrupts=[])

    monkeypatch.setattr(agents_service.router_inference, "has_checkpointer_initialized", lambda: True)
    monkeypatch.setattr(yaml_agent.YamlDeepAgent, "ensure_built", ensure_built)
    monkeypatch.setattr(yaml_agent.YamlDeepAgent, "compiled", property(lambda self: _Graph()))
    return trial


def _resume(client, headers, *, definition):
    body = {"config": _context(), "thread_id": "thread-1", "decision": "approve"}
    if definition is not None:
        body["definition"] = definition
    return client.post(f"/agents/{SLUG}/resume", headers=headers, json=body)


async def test_resume_rebuilds_the_trial_from_its_definition(client, internal_headers, paused_nowhere):
    await _save_agent(paused_nowhere.store)

    response = await _resume(client, internal_headers, definition=_draft())

    assert response.status_code == 409, response.text
    [agent] = paused_nowhere.built
    assert agent.instructions == "You are the draft."
    assert agent.reference_namespace is None


async def test_resume_refuses_an_invalid_draft(client, internal_headers, paused_nowhere):
    response = await _resume(client, internal_headers, definition=_draft(prompt="/etc/passwd"))

    assert response.status_code == 422
    assert paused_nowhere.built == []
