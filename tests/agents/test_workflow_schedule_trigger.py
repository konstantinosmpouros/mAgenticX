"""Workflow engine — the ``trigger.schedule`` start node.

Pins what the bridge and the builder rely on:

* the config mirrors the bridge's schedule model (``schedule_kind`` +
  ``schedule_spec`` + ``timezone``): one spec field per kind, the 300 s
  interval floor, a valid cron and IANA zone, unknown keys refused;
* static ``inputs`` are checked against the declared inputs (names, types,
  required-while-enabled) and are never templated;
* exactly one trigger of either kind;
* the node's output says how the run started (``schedule`` / ``manual``), when,
  and with which inputs — a manual run's inputs laid over the static ones;
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
            {"name": "topic", "type": "string", "required": True},
            {"name": "limit", "type": "number", "default": 5},
        ],
        "nodes": [
            {"id": "start", "kind": "trigger.schedule",
             "config": trigger_config if trigger_config is not None else _schedule(inputs={"topic": "news"})},
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
    _schedule(inputs={"topic": "x"}),
    _schedule(schedule_kind="one_off", schedule_spec={"run_at": "2027-01-01T08:00:00Z"}, inputs={"topic": "x"}),
    # A one-off in the past still validates: a stored version is re-validated
    # at every run start, and "Run now" must keep working after it fired.
    _schedule(schedule_kind="one_off", schedule_spec={"run_at": "2020-01-01T08:00:00"}, inputs={"topic": "x"}),
    _schedule(schedule_kind="cron", schedule_spec={"cron_expr": "0 8 * * 1-5"}, timezone="Europe/Athens",
              inputs={"topic": "x"}),
    _schedule(schedule_kind="cron", schedule_spec={"cron_expr": "*/30 * * * *"}, inputs={"topic": "x"}),
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
    config.setdefault("inputs", {"topic": "x"})
    issues = _issues(wf, _spec(config))
    assert issues and all(issue.node_id == "start" for issue in issues)
    assert any(fragment in issue.message for issue in issues), [i.message for i in issues]
    assert all(issue.path.startswith("nodes[0].config") for issue in issues)


def test_static_inputs_are_checked_against_the_declared_ones(wf):
    issues = _issues(wf, _spec(_schedule(inputs={"topic": 3, "nope": "x"})))
    assert _paths(issues) == {"nodes[0].config.inputs.topic", "nodes[0].config.inputs.nope"}

    # Required (no default) must be supplied while enabled…
    issues = _issues(wf, _spec(_schedule(inputs={})))
    assert _paths(issues) == {"nodes[0].config.inputs.topic"}
    assert "required input 'topic'" in issues[0].message
    # …but not when the schedule is switched off.
    assert _issues(wf, _spec(_schedule(inputs={}, enabled=False))) == []


def test_static_inputs_are_data_not_templates(wf):
    # A reference to an undeclared input would fail a templated node; here it is text.
    assert _issues(wf, _spec(_schedule(inputs={"topic": "{{input.nope}}"}))) == []


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
        "assign", "schedule_kind", "schedule_spec", "timezone", "inputs", "enabled",
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
async def test_a_scheduled_fire_reports_schedule_and_the_static_inputs(wf):
    trigger = wf.runner.RunTrigger(kind="schedule", fired_at="2026-11-04T08:00:00Z")
    events = await _run(wf, _spec(), inputs={"topic": "news"}, trigger=trigger)
    assert _trigger_output(events) == {
        "trigger": "schedule", "firedAt": "2026-11-04T08:00:00Z", "inputs": {"topic": "news", "limit": 5},
    }
    assert events[-1]["type"] == "RUN_FINISHED"
    assert events[-1]["result"]["output"] == {"how": "schedule"}
    # Not templated: node_input shows the config as written.
    node_input = next(e for e in events if e.get("name") == "workflow.node_input")
    assert node_input["value"]["config"]["inputs"] == {"topic": "news"}


@pytest.mark.asyncio
async def test_run_now_lays_the_request_inputs_over_the_static_ones(wf):
    events = await _run(wf, _spec(), inputs={"limit": 9, "topic": None})
    output = _trigger_output(events)
    assert output["trigger"] == "manual"
    assert output["firedAt"].endswith("Z")
    # A null does not blank the static value; a given one wins.
    assert output["inputs"] == {"topic": "news", "limit": 9}


@pytest.mark.asyncio
async def test_run_now_still_validates_the_merged_inputs(wf):
    raw = _spec(_schedule(inputs={}, enabled=False))
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
