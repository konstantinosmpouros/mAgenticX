"""Workflow engine — the ``trigger.schedule`` start node.

Pins what the bridge and the builder rely on:

* the config mirrors the bridge's schedule model (``schedule_kind`` +
  ``schedule_spec`` + ``timezone``): one spec field per kind, the 300 s
  interval floor, a valid cron and IANA zone, unknown keys refused;
* the node has no inputs of its own: a legacy ``inputs`` key is accepted and
  ignored, and while enabled every required input needs a default;
* exactly one trigger of either kind;
* the node's output says how the run started (``schedule`` / ``manual``), when,
  and with which inputs — a scheduled fire runs on the defaults;
* the catalogue exposes it as a trigger with its JSON Schema.
"""
from __future__ import annotations

import importlib
import json
from types import SimpleNamespace

import pytest
from langgraph.checkpoint.memory import InMemorySaver


@pytest.fixture
def wf(agents_service):
    return SimpleNamespace(
        spec=importlib.import_module("harness.workflows.spec"),
        validator=importlib.import_module("harness.workflows.validator"),
        catalog=importlib.import_module("harness.workflows.catalog"),
        compiler=importlib.import_module("harness.workflows.compiler"),
        runner=importlib.import_module("harness.workflows.runner"),
        utils=importlib.import_module("utils.workflows"),
        checkpointer_store=importlib.import_module("harness.checkpointer.store"),
    )


def _schedule(**config) -> dict:
    base = {"schedule_kind": "interval", "schedule_spec": {"interval_seconds": 3600}}
    base.update(config)
    return base


def _spec(trigger_config: dict | None = None, *, inputs: list | None = None) -> dict:
    return {
        "version": 1,
        "name": "scheduled",
        "inputs": inputs if inputs is not None else [
            {"name": "topic", "type": "string", "required": True, "default": "news"},
            {"name": "limit", "type": "number", "default": 5},
        ],
        "nodes": [
            {"id": "start", "kind": "trigger.schedule",
             "config": trigger_config if trigger_config is not None else _schedule()},
            {"id": "done", "kind": "end", "config": {"outputs": {"how": "{{nodes.start.output.trigger}}"}}},
        ],
        "edges": [{"id": "e1", "source": "start", "target": "done"}],
    }


def _issues(wf, raw) -> list:
    spec, issues = wf.validator.validate_spec(raw)
    assert (spec is None) == bool(issues)
    return issues


def _paths(issues) -> set[str]:
    return {issue.path for issue in issues}


# -- config ------------------------------------------------------------------


@pytest.mark.parametrize("config", [
    _schedule(),
    _schedule(schedule_kind="one_off", schedule_spec={"run_at": "2027-01-01T08:00:00Z"}),
    # A one-off in the past still validates: a stored version is re-validated
    # at every run start, and "Run now" must keep working after it fired.
    _schedule(schedule_kind="one_off", schedule_spec={"run_at": "2020-01-01T08:00:00"}),
    _schedule(schedule_kind="cron", schedule_spec={"cron_expr": "0 8 * * 1-5"}, timezone="Europe/Athens"),
    _schedule(schedule_kind="cron", schedule_spec={"cron_expr": "*/30 * * * *"}),
])
def test_valid_schedules(wf, config):
    assert _issues(wf, _spec(config)) == []


@pytest.mark.parametrize(("config", "fragment"), [
    (_schedule(schedule_spec={"interval_seconds": 299}), "greater than or equal to 300"),
    (_schedule(schedule_spec={}), "interval_seconds is required"),
    (_schedule(schedule_spec={"interval_seconds": 600, "cron_expr": "* * * * *"}), "takes only"),
    (_schedule(schedule_kind="cron", schedule_spec={"cron_expr": "not a cron"}), "Invalid cron"),
    (_schedule(schedule_kind="cron", schedule_spec={"cron_expr": "0 8 * * *"}, timezone="Mars/Olympus"),
     "Unknown timezone"),
    (_schedule(schedule_kind="weekly"), "Input should be"),
    (_schedule(schedule_spec={"interval_seconds": 600, "every": 1}), "Extra inputs"),
    ({"schedule_spec": {"interval_seconds": 600}}, "Field required"),
])
def test_invalid_schedules_are_pinned_to_the_trigger(wf, config, fragment):
    issues = _issues(wf, _spec(config))
    assert issues and all(issue.node_id == "start" for issue in issues)
    assert any(fragment in issue.message for issue in issues), [i.message for i in issues]
    assert all(issue.path.startswith("nodes[0].config") for issue in issues)


def test_a_legacy_inputs_key_is_accepted_and_ignored(wf):
    # Older specs carry literal inputs on the trigger; they no longer mean anything.
    raw = _spec(_schedule(inputs={"topic": 3, "nope": "x"}))
    assert _issues(wf, raw) == []
    # The stored spec is left as it was; only the node's config drops the key.
    assert wf.spec.WorkflowSpec.model_validate(raw).nodes[0].config["inputs"] == {"topic": 3, "nope": "x"}


_REQUIRED_NO_DEFAULT = [{"name": "topic", "type": "string", "required": True}]


def test_a_required_input_without_a_default_blocks_an_enabled_schedule(wf):
    issues = _issues(wf, _spec(_schedule(), inputs=_REQUIRED_NO_DEFAULT))
    assert [(i.node_id, i.path, i.message) for i in issues] == [(
        "start",
        "nodes[0].config.enabled",
        "A scheduled run can't fill the required input 'topic': "
        "give it a default in Settings › Inputs, or turn the schedule off.",
    )]


def test_a_disabled_schedule_needs_no_defaults(wf):
    assert _issues(wf, _spec(_schedule(enabled=False), inputs=_REQUIRED_NO_DEFAULT)) == []


def test_a_required_input_with_a_default_is_fine(wf):
    inputs = [{"name": "topic", "type": "string", "required": True, "default": "news"}]
    assert _issues(wf, _spec(_schedule(), inputs=inputs)) == []


def test_exactly_one_trigger_of_either_kind(wf):
    raw = _spec()
    raw["nodes"].append({"id": "manual", "kind": "trigger.manual", "config": {}})
    raw["edges"].append({"id": "e2", "source": "manual", "target": "done"})
    issues = _issues(wf, raw)
    assert any("exactly one trigger" in i.message and "found 2" in i.message for i in issues)
    assert "trigger.schedule" in next(i.message for i in issues if "exactly one trigger" in i.message)


def test_catalog_exposes_the_schedule_trigger(wf):
    entry = {e["kind"]: e for e in wf.catalog.node_catalog()}["trigger.schedule"]
    assert entry["isTrigger"] is True and entry["group"] == "trigger" and entry["branches"] == []
    schema = entry["configSchema"]
    assert set(schema["properties"]) == {
        "assign", "schedule_kind", "schedule_spec", "timezone", "enabled",
    }
    assert schema["properties"]["schedule_kind"]["enum"] == ["one_off", "interval", "cron"]
    assert set(schema["required"]) == {"schedule_kind", "schedule_spec"}
    spec_schema = schema["$defs"]["ScheduleSpec"]
    assert spec_schema["additionalProperties"] is False
    assert set(spec_schema["properties"]) == {"run_at", "interval_seconds", "cron_expr"}
    interval = next(s for s in spec_schema["properties"]["interval_seconds"]["anyOf"] if s.get("type") == "integer")
    assert interval["minimum"] == 300


# -- running -----------------------------------------------------------------


def _parse(frames: list[bytes]) -> list[dict]:
    events = []
    for frame in frames:
        for line in frame.decode("utf-8").splitlines():
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return events


async def _run(wf, raw, *, inputs, trigger=None) -> list[dict]:
    spec = wf.spec.WorkflowSpec.model_validate(raw)
    compiled = wf.compiler.compile_workflow(spec, checkpointer=InMemorySaver())
    prepared = await wf.runner.prepare_run(
        compiled, run_id="run-1", thread_id="t1", owner_user_id="u1", workflow_id="wf-1", version_no=1,
        inputs=inputs, resume=None, store=None, trigger=trigger,
    )
    return _parse([frame async for frame in prepared.stream()])


def _trigger_output(events: list[dict]) -> dict:
    return next(
        e["value"]["output"] for e in events
        if e.get("name") == "workflow.node_output" and e["workflow"]["nodeId"] == "start"
    )


@pytest.mark.asyncio
async def test_a_scheduled_fire_with_no_inputs_runs_on_the_defaults(wf):
    trigger = wf.runner.RunTrigger(kind="schedule", fired_at="2026-11-04T08:00:00Z")
    events = await _run(wf, _spec(), inputs=None, trigger=trigger)
    assert _trigger_output(events) == {
        "trigger": "schedule", "firedAt": "2026-11-04T08:00:00Z", "inputs": {"topic": "news", "limit": 5},
    }
    assert events[-1]["type"] == "RUN_FINISHED"
    assert events[-1]["result"]["output"] == {"how": "schedule"}


@pytest.mark.asyncio
async def test_a_legacy_inputs_key_does_not_reach_a_run(wf):
    trigger = wf.runner.RunTrigger(kind="schedule", fired_at="2026-11-04T08:00:00Z")
    events = await _run(wf, _spec(_schedule(inputs={"topic": "old"})), inputs={}, trigger=trigger)
    assert _trigger_output(events)["inputs"] == {"topic": "news", "limit": 5}


@pytest.mark.asyncio
async def test_run_now_uses_the_request_inputs_over_the_defaults(wf):
    events = await _run(wf, _spec(), inputs={"limit": 9, "topic": None})
    output = _trigger_output(events)
    assert output["trigger"] == "manual"
    assert output["firedAt"].endswith("Z")
    # A null means "not given": the default fills it; a given value wins.
    assert output["inputs"] == {"topic": "news", "limit": 9}


@pytest.mark.asyncio
async def test_run_now_still_validates_the_inputs(wf):
    raw = _spec(_schedule(enabled=False), inputs=_REQUIRED_NO_DEFAULT)
    spec = wf.spec.WorkflowSpec.model_validate(raw)
    compiled = wf.compiler.compile_workflow(spec, checkpointer=InMemorySaver())
    with pytest.raises(wf.runner.RunRefused) as refused:
        await wf.runner.prepare_run(
            compiled, run_id="r", thread_id="t", owner_user_id="u1", workflow_id="wf-1", version_no=1,
            inputs={}, resume=None, store=None,
        )
    assert refused.value.status == 422 and "required" in refused.value.errors[0]


class _Store:
    """The workflow-version half of ``WorkflowStore``."""

    def __init__(self, workflow_id: str, spec: dict) -> None:
        self.workflow_id, self.spec = workflow_id, spec

    async def get_version(self, owner_user_id, workflow_id, version_no):
        return (1, self.spec) if (owner_user_id, workflow_id) == ("u1", self.workflow_id) else None

    async def load_persisted(self, owner_user_id, workflow_id):
        return {}

    async def save_persisted(self, owner_user_id, workflow_id, values):
        return None


@pytest.mark.asyncio
async def test_stream_route_passes_the_trigger_through(client, internal_headers, wf, monkeypatch):
    workflow_id = "33333333-3333-3333-3333-333333333333"
    monkeypatch.setattr(wf.utils, "workflow_store", lambda: _Store(workflow_id, _spec()))
    wf.checkpointer_store.set_checkpointer(InMemorySaver())
    try:
        body = {
            "run_id": "r-1", "thread_id": "th-1", "owner_user_id": "u1", "workflow_id": workflow_id,
            "version_no": None, "inputs": {"topic": "news"}, "resume": None,
            "trigger_kind": "schedule", "fired_at": "2026-11-04T10:00:00",
        }
        response = await client.post("/workflows/runs/stream", json=body, headers=internal_headers)
        assert response.status_code == 200
        output = _trigger_output(_parse([response.content]))
        assert output["trigger"] == "schedule" and output["firedAt"] == "2026-11-04T10:00:00Z"

        body.update(thread_id="th-2", trigger_kind="cron")
        response = await client.post("/workflows/runs/stream", json=body, headers=internal_headers)
        assert response.status_code == 422
    finally:
        wf.checkpointer_store.set_checkpointer(None)
        wf.compiler.forget_compiled(workflow_id)
