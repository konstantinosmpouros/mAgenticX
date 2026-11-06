"""Workflow engine — compile and run, end to end, over an in-memory checkpointer.

Runs the hand-written example (manual → fetch → set → condition → loop back /
approval → set → end) with a mocked HTTP endpoint and pins what the bridge and
the replaying UI depend on:

* the per-node bracket order (STEP_STARTED → node_input → own events →
  node_output → STATE_DELTA → STEP_FINISHED) and the run-level frames;
* the ``workflow`` envelope on every frame, with ``executionId`` counting each
  node's executions (``poll#1``, ``poll#2``…) and ``parentExecutionId`` naming
  the loop iteration;
* the approval pause (``HITL_INTERRUPT`` ends the leg — no ``RUN_FINISHED``,
  no ``RUN_ERROR``) and the resume on the same thread;
* keep-alive comments while a node is busy, and a closed stream stopping the run;
* kept variables saved only on completion and loaded into the next run;
  failures closing their bracket.
"""
from __future__ import annotations

import asyncio
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from langgraph.checkpoint.memory import InMemorySaver

EXAMPLE = (
    Path(__file__).resolve().parent / "fixtures" / "workflows" / "fetch_loop_approval.json"
)
BRACKET = ["STEP_STARTED", "workflow.node_input", "workflow.node_output", "STATE_DELTA", "STEP_FINISHED"]


@pytest.fixture
def wf(agents_service):
    return SimpleNamespace(
        spec=importlib.import_module("harness.workflows.spec"),
        compiler=importlib.import_module("harness.workflows.compiler"),
        runner=importlib.import_module("harness.workflows.runner"),
        ssrf=importlib.import_module("harness.workflows.ssrf"),
        fetch=importlib.import_module("harness.workflows.nodes.fetch"),
        checkpointer_store=importlib.import_module("harness.checkpointer.store"),
        utils=importlib.import_module("utils.workflows"),
    )


class FakeStore:
    """The persisted-state half of ``WorkflowStore``, in memory."""

    def __init__(self, persisted=None):
        self.persisted = dict(persisted or {})
        self.saves: list[dict] = []

    async def load_persisted(self, owner_user_id, workflow_id):
        return dict(self.persisted)

    async def save_persisted(self, owner_user_id, workflow_id, values):
        self.saves.append(dict(values))
        self.persisted.update(values)


def _mock_job(wf, monkeypatch, statuses: list[str]):
    """Each poll answers the next status (the last one repeats)."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        index = min(calls["n"], len(statuses) - 1)
        calls["n"] += 1
        return httpx.Response(200, json={"status": statuses[index]})

    transport = httpx.MockTransport(handler)

    async def resolve(host, port):
        return ["93.184.216.34"]

    monkeypatch.setattr(wf.ssrf, "resolve_host", resolve)
    monkeypatch.setattr(
        wf.fetch, "make_client",
        lambda timeout: httpx.AsyncClient(transport=transport, follow_redirects=False, trust_env=False),
    )
    return calls


def _compiled(wf, raw=None, saver=None):
    raw = raw or json.loads(EXAMPLE.read_text(encoding="utf-8"))
    spec = wf.spec.WorkflowSpec.model_validate(raw)
    return wf.compiler.compile_workflow(spec, checkpointer=saver or InMemorySaver())


def _parse(frames: list[bytes]) -> list[dict]:
    events = []
    for frame in frames:
        for line in frame.decode("utf-8").splitlines():
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return events


def _label(event: dict) -> str:
    return event["name"] if event["type"] == "CUSTOM" else event["type"]


async def _run(wf, compiled, *, thread="t1", run_id="run-1", inputs=None, resume=None, store=None):
    prepared = await wf.runner.prepare_run(
        compiled,
        run_id=run_id,
        thread_id=thread,
        owner_user_id="u1",
        workflow_id="11111111-1111-1111-1111-111111111111",
        version_no=3,
        inputs=inputs if inputs is not None else {"job_url": "https://jobs.example/42"},
        resume=resume,
        store=store,
    )
    return _parse([frame async for frame in prepared.stream()])


def _executions(events: list[dict]) -> list[str]:
    return [e["workflow"]["executionId"] for e in events if e["type"] == "STEP_STARTED"]


def _by_execution(events: list[dict], execution_id: str) -> list[dict]:
    return [e for e in events if e["workflow"]["executionId"] == execution_id]


@pytest.mark.asyncio
async def test_example_runs_loops_pauses_and_resumes(wf, monkeypatch):
    calls = _mock_job(wf, monkeypatch, ["pending", "pending", "ready"])
    compiled = _compiled(wf)
    store = FakeStore()

    events = await _run(wf, compiled, store=store)

    # Run-level frames carry the envelope with null node fields.
    assert _label(events[0]) == "RUN_STARTED" and _label(events[1]) == "workflow.run"
    assert events[1]["value"] == {"workflowId": "11111111-1111-1111-1111-111111111111", "versionNo": 3, "resumed": False}
    for event in (events[0], events[1], events[-1]):
        assert event["workflow"] == {
            "runId": "run-1", "nodeId": None, "executionId": None, "parentExecutionId": None, "iteration": None,
        }

    # Every node execution, in order: executionId counts each node's runs.
    assert _executions(events) == [
        "start#1", "poll#1", "track#1", "is_ready#1", "retry#1",
        "poll#2", "track#2", "is_ready#2", "retry#2",
        "poll#3", "track#3", "is_ready#3", "approve#1",
    ]
    assert calls["n"] == 3

    # Each completed execution is exactly the bracket, in order.
    for execution in _executions(events)[:-1]:
        assert [_label(e) for e in _by_execution(events, execution)] == BRACKET, execution

    poll2 = _by_execution(events, "poll#2")
    assert all(e["workflow"]["nodeId"] == "poll" and e["workflow"]["iteration"] == 2 for e in poll2)
    assert poll2[0]["stepName"] == "poll"
    # Inside the loop: the iteration that started it is the parent.
    assert poll2[0]["workflow"]["parentExecutionId"] == "retry#1"
    assert _by_execution(events, "poll#3")[0]["workflow"]["parentExecutionId"] == "retry#2"
    assert _by_execution(events, "poll#1")[0]["workflow"]["parentExecutionId"] is None

    # node_input carries the resolved config; node_output the result.
    node_input = _by_execution(events, "poll#1")[1]["value"]
    assert node_input["iteration"] == 1 and node_input["config"]["url"] == "https://jobs.example/42"
    output = _by_execution(events, "poll#3")[2]["value"]
    assert output["output"]["body"] == {"status": "ready"} and output["error"] is None and output["branch"] is None
    assert isinstance(output["durationMs"], int)
    assert _by_execution(events, "is_ready#3")[2]["value"]["branch"] == "true"
    # STATE_DELTA carries the variable writes: only a Set step writes any.
    assert _by_execution(events, "poll#2")[3]["delta"] == []
    assert _by_execution(events, "track#2")[3]["delta"] == [
        {"op": "add", "path": "/last_status", "value": "pending"},
    ]

    # The approval pause: its step stays open and the leg ends on the interrupt.
    approve = _by_execution(events, "approve#1")
    assert [_label(e) for e in approve] == ["STEP_STARTED", "workflow.node_input", "HITL_INTERRUPT"]
    interrupt = approve[-1]["value"]
    assert interrupt["thread_id"] == "t1"
    assert interrupt["interrupt"]["value"]["type"] == "workflow.approval"
    assert interrupt["interrupt"]["value"]["payload"] == {"job": "https://jobs.example/42", "result": {"status": "ready"}}
    assert interrupt["metadata"]["source"] == "workflow.approval" and interrupt["metadata"]["nodeId"] == "approve"
    assert [_label(e) for e in events[-2:]] == ["HITL_INTERRUPT", "CHECKPOINT_COMMITTED"]
    assert not any(e["type"] in ("RUN_FINISHED", "RUN_ERROR") for e in events)
    assert store.saves == []  # nothing persisted while paused

    # Resume on the same thread: the approval re-runs as the same execution.
    resume = wf.runner.ResumeDecision("approve", "ship it")
    events = await _run(wf, compiled, run_id="run-1b", resume=resume, store=store)
    assert events[1]["value"]["resumed"] is True
    assert _executions(events) == ["approve#1", "decide#1", "finish#1"]
    assert [_label(e) for e in _by_execution(events, "approve#1")] == BRACKET
    approve_out = _by_execution(events, "approve#1")[2]["value"]
    assert approve_out["output"] == {"decision": "approve", "comment": "ship it"} and approve_out["branch"] == "approved"
    assert all(e["workflow"]["runId"] == "run-1b" for e in events)
    assert events[-1]["type"] == "RUN_FINISHED"
    assert events[-1]["result"] == {
        "status": "completed",
        "output": {
            "status": "ready",
            # A Set inside the loop keeps every pass in its outputs.
            "polls": [{"last_status": "pending"}, {"last_status": "pending"}, {"last_status": "ready"}],
            "decision": "approve",
        },
    }
    assert store.saves == [{"last_status": "ready"}]


@pytest.mark.asyncio
async def test_a_rejection_takes_the_rejected_branch(wf, monkeypatch):
    _mock_job(wf, monkeypatch, ["ready"])
    compiled = _compiled(wf)
    await _run(wf, compiled)
    events = await _run(wf, compiled, resume=wf.runner.ResumeDecision("reject"))
    assert _by_execution(events, "approve#1")[2]["value"]["branch"] == "rejected"
    assert events[-1]["result"]["output"]["decision"] == "reject"


@pytest.mark.asyncio
async def test_the_loop_is_bounded(wf, monkeypatch):
    calls = _mock_job(wf, monkeypatch, ["pending"])
    events = await _run(wf, _compiled(wf))
    retries = [x for x in _executions(events) if x.startswith("retry#")]
    assert retries == ["retry#1", "retry#2", "retry#3", "retry#4"]
    assert _by_execution(events, "retry#4")[2]["value"]["branch"] == "done"
    assert calls["n"] == 4  # max_iterations = 3 → the body runs 1 + 3 times
    assert _executions(events)[-1] == "finish#1"
    output = events[-1]["result"]["output"]
    assert len(output["polls"]) == 4
    # No Set wrote 'decision' on this path: it reads null.
    assert output["decision"] is None
    # 'done' popped the loop: the end node is outside any iteration.
    assert _by_execution(events, "finish#1")[0]["workflow"]["parentExecutionId"] is None


@pytest.mark.asyncio
async def test_the_while_rule_stops_the_loop_early(wf, monkeypatch):
    calls = _mock_job(wf, monkeypatch, ["pending", "failed"])
    events = await _run(wf, _compiled(wf))
    assert calls["n"] == 2
    assert _by_execution(events, "retry#2")[2]["value"]["output"] == {"iteration": 2, "continue": False}


@pytest.mark.asyncio
async def test_a_failing_node_closes_its_bracket_then_fails_the_run(wf, monkeypatch):
    async def private(host, port):
        return ["10.0.0.5"]

    monkeypatch.setattr(wf.ssrf, "resolve_host", private)
    store = FakeStore()
    events = await _run(wf, _compiled(wf), store=store)
    poll = _by_execution(events, "poll#1")
    assert [_label(e) for e in poll] == ["STEP_STARTED", "workflow.node_input", "workflow.node_output", "STEP_FINISHED"]
    error = poll[2]["value"]["error"]
    assert error["code"] == "ssrf_blocked" and poll[2]["value"]["output"] is None
    assert events[-1]["type"] == "RUN_ERROR" and events[-1]["code"] == "node_failed"
    assert "Node 'poll' failed" in events[-1]["message"]
    assert events[-1]["workflow"]["nodeId"] is None
    assert store.saves == []


@pytest.mark.asyncio
async def test_a_template_that_does_not_resolve_fails_the_node_by_name(wf, monkeypatch):
    raw = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    raw["inputs"][0]["required"] = False
    raw["nodes"][1]["config"]["url"] = "{{input.job_url.deeper}}"
    events = await _run(wf, _compiled(wf, raw), inputs={"job_url": "x"})
    poll = _by_execution(events, "poll#1")
    assert poll[1]["value"] == {"config": None, "iteration": 1}
    assert poll[2]["value"]["error"]["code"] == "template"
    assert "input.job_url.deeper" in poll[2]["value"]["error"]["message"]


def _peeking(raw: dict) -> dict:
    """The example with ``track`` also noting what the variables held before it wrote."""
    track = next(n for n in raw["nodes"] if n["id"] == "track")
    track["config"]["values"].update({"before": "{{state.last_status}}", "decision_before": "{{state.decision}}"})
    return raw


@pytest.mark.asyncio
async def test_kept_variables_are_loaded_into_the_next_run(wf, monkeypatch):
    _mock_job(wf, monkeypatch, ["failed"])
    raw = _peeking(json.loads(EXAMPLE.read_text(encoding="utf-8")))
    # 'ignored' is no variable of this workflow: it never reaches the run.
    store = FakeStore({"last_status": "from-before", "ignored": 1})
    events = await _run(wf, _compiled(wf, raw), store=store)
    track = _by_execution(events, "track#1")
    assert track[2]["value"]["output"] == {
        "last_status": "failed", "before": "from-before", "decision_before": None,
    }
    assert store.saves == [{"last_status": "failed"}]


@pytest.mark.asyncio
async def test_carry_over_across_two_runs_keeps_only_the_kept_names(wf, monkeypatch):
    _mock_job(wf, monkeypatch, ["ready"])
    compiled = _compiled(wf, _peeking(json.loads(EXAMPLE.read_text(encoding="utf-8"))))
    store = FakeStore()
    first = await _run(wf, compiled, thread="first", store=store)
    assert _by_execution(first, "track#1")[2]["value"]["output"]["before"] is None  # nothing kept yet
    first = await _run(wf, compiled, thread="first", resume=wf.runner.ResumeDecision("approve"), store=store)
    assert first[-1]["result"]["output"]["decision"] == "approve"
    assert store.saves == [{"last_status": "ready"}]  # 'decision' is not kept

    second = await _run(wf, compiled, thread="second", run_id="run-2", store=store)
    peek = _by_execution(second, "track#1")[2]["value"]["output"]
    assert peek["before"] == "ready"  # the kept value
    assert peek["decision_before"] is None  # unkept: starts unwritten


@pytest.mark.asyncio
async def test_a_failed_run_keeps_nothing(wf, monkeypatch):
    async def private(host, port):
        return ["10.0.0.5"]

    monkeypatch.setattr(wf.ssrf, "resolve_host", private)
    store = FakeStore({"last_status": "old"})
    events = await _run(wf, _compiled(wf), store=store)
    assert events[-1]["type"] == "RUN_ERROR"
    assert store.saves == [] and store.persisted == {"last_status": "old"}


def test_kept_values_are_those_of_the_end_steps_that_ran(wf):
    spec = wf.spec.WorkflowSpec.model_validate(json.loads(EXAMPLE.read_text(encoding="utf-8")))
    values = {"vars": {"last_status": "x", "decision": "y"}, "nodes": {"finish": {}}}
    assert wf.runner.kept_values(spec, values) == {"last_status": "x"}
    assert wf.runner.kept_values(spec, {"vars": {"last_status": "x"}, "nodes": {}}) == {}
    # Kept but never written: saved as null.
    assert wf.runner.kept_values(spec, {"vars": {}, "nodes": {"finish": {}}}) == {"last_status": None}


@pytest.mark.asyncio
async def test_inputs_are_validated_before_the_stream(wf):
    compiled = _compiled(wf)
    for inputs, message in (({}, "required"), ({"job_url": 5}, "type string"), ({"job_url": "x", "zzz": 1}, "Unknown")):
        with pytest.raises(wf.runner.RunRefused) as caught:
            await _run(wf, compiled, inputs=inputs)
        assert caught.value.status == 422 and any(message in e for e in caught.value.errors)


@pytest.mark.asyncio
async def test_resume_needs_a_pending_approval_and_a_fresh_run_a_fresh_thread(wf, monkeypatch):
    _mock_job(wf, monkeypatch, ["failed"])
    compiled = _compiled(wf)
    with pytest.raises(wf.runner.RunRefused) as caught:
        await _run(wf, compiled, thread="never-ran", resume=wf.runner.ResumeDecision("approve"))
    assert caught.value.status == 409
    await _run(wf, compiled, thread="used")
    with pytest.raises(wf.runner.RunRefused) as caught:
        await _run(wf, compiled, thread="used")
    assert caught.value.status == 409
    with pytest.raises(wf.runner.RunRefused):
        await _run(wf, compiled, thread="used", resume=wf.runner.ResumeDecision("approve"))


@pytest.mark.asyncio
async def test_keep_alive_comments_flow_while_a_node_is_busy(wf, monkeypatch):
    _mock_job(wf, monkeypatch, ["failed"])
    monkeypatch.setattr(wf.runner, "KEEPALIVE_SECONDS", 0.02)
    original = wf.fetch.FetchNode._exchange

    async def slow(self, cfg):
        await asyncio.sleep(0.15)
        return await original(self, cfg)

    monkeypatch.setattr(wf.fetch.FetchNode, "_exchange", slow)
    prepared = await wf.runner.prepare_run(
        _compiled(wf), run_id="r", thread_id="t-ka", owner_user_id="u1", workflow_id="w", version_no=1,
        inputs={"job_url": "https://jobs.example/1"}, resume=None, store=None,
    )
    frames = [frame async for frame in prepared.stream()]
    assert wf.runner.KEEPALIVE_FRAME in frames
    assert _parse(frames)[-1]["type"] == "RUN_FINISHED"


@pytest.mark.asyncio
async def test_closing_the_stream_stops_the_graph(wf, monkeypatch):
    _mock_job(wf, monkeypatch, ["failed"])
    started, finished = asyncio.Event(), asyncio.Event()

    async def hang(self, cfg):
        started.set()
        try:
            await asyncio.sleep(30)
        finally:
            finished.set()

    monkeypatch.setattr(wf.fetch.FetchNode, "_exchange", hang)
    prepared = await wf.runner.prepare_run(
        _compiled(wf), run_id="r", thread_id="t-cancel", owner_user_id="u1", workflow_id="w", version_no=1,
        inputs={"job_url": "https://jobs.example/1"}, resume=None, store=None,
    )
    stream = prepared.stream()
    async for _frame in stream:
        if started.is_set():
            break
    await stream.aclose()  # what Starlette does when the client disconnects
    assert finished.is_set()


def test_recursion_limit_is_bounded_by_the_loops(wf):
    compiled = _compiled(wf)
    assert compiled.recursion_limit == 8 * (1 + 3) + 10


def test_compiled_graphs_are_cached_per_version_and_checkpointer(wf):
    spec = wf.spec.WorkflowSpec.model_validate(json.loads(EXAMPLE.read_text(encoding="utf-8")))
    saver = InMemorySaver()
    first = wf.compiler.get_compiled("w-cache", 1, spec, checkpointer=saver)
    assert wf.compiler.get_compiled("w-cache", 1, spec, checkpointer=saver) is first
    assert wf.compiler.get_compiled("w-cache", 2, spec, checkpointer=saver) is not first
    assert wf.compiler.get_compiled("w-cache", 1, spec, checkpointer=InMemorySaver()) is not first
    wf.compiler.forget_compiled("w-cache")


# -- routes ----------------------------------------------------------------------


class FakeWorkflowStore(FakeStore):
    """``WorkflowStore`` in memory: enough for the routes."""

    def __init__(self):
        super().__init__()
        self.rows: dict[str, dict] = {}
        self.versions: dict[tuple[str, int], dict] = {}

    async def get_version(self, owner_user_id, workflow_id, version_no):
        row = self.rows.get(workflow_id)
        if row is None or row["owner_user_id"] != owner_user_id:
            return None
        number = version_no or row["latest_version_no"]
        spec = self.versions.get((workflow_id, number))
        return None if spec is None else (number, spec)


@pytest.mark.asyncio
async def test_routes_are_internal_only(client):
    assert (await client.get("/workflows/catalog")).status_code == 403
    assert (await client.post("/workflows/validate", json={"spec": {}})).status_code == 403


@pytest.mark.asyncio
async def test_catalog_and_validate_routes(client, internal_headers, wf, monkeypatch):
    async def no_catalogue():
        return None

    monkeypatch.setattr(wf.utils, "_known_mcp_tool_names", no_catalogue)
    response = await client.get("/workflows/catalog", headers=internal_headers)
    assert response.status_code == 200
    assert {k["kind"] for k in response.json()["kinds"]} >= {"fetch", "loop", "approval"}

    good = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    response = await client.post("/workflows/validate", json={"spec": good}, headers=internal_headers)
    assert response.json() == {"ok": True, "errors": []}

    good["nodes"][1]["config"]["url"] = "{{input.nope}}"
    response = await client.post("/workflows/validate", json={"spec": good}, headers=internal_headers)
    body = response.json()
    assert body["ok"] is False and body["errors"][0]["nodeId"] == "poll"
    assert set(body["errors"][0]) == {"nodeId", "path", "message"}


@pytest.mark.asyncio
async def test_stream_route_runs_the_owner_s_workflow_and_404s_anyone_else(client, internal_headers, wf, monkeypatch):
    _mock_job(wf, monkeypatch, ["failed"])
    store = FakeWorkflowStore()
    workflow_id = "22222222-2222-2222-2222-222222222222"
    store.rows[workflow_id] = {"owner_user_id": "u1", "latest_version_no": 1}
    store.versions[(workflow_id, 1)] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    monkeypatch.setattr(wf.utils, "workflow_store", lambda: store)
    wf.checkpointer_store.set_checkpointer(InMemorySaver())
    try:
        body = {
            "run_id": "r-1", "thread_id": "th-1", "owner_user_id": "u2", "workflow_id": workflow_id,
            "version_no": None, "inputs": {"job_url": "https://jobs.example/1"}, "resume": None,
        }
        response = await client.post("/workflows/runs/stream", json=body, headers=internal_headers)
        assert response.status_code == 404

        body["owner_user_id"] = "u1"
        response = await client.post("/workflows/runs/stream", json=body, headers=internal_headers)
        assert response.status_code == 200 and response.headers["content-type"].startswith("text/event-stream")
        events = _parse([response.content])
        assert events[1]["value"]["versionNo"] == 1
        assert events[-1]["type"] == "RUN_FINISHED" and events[-1]["result"]["status"] == "completed"

        response = await client.post("/workflows/runs/stream", json=body, headers=internal_headers)
        assert response.status_code == 409

        body.update(thread_id="th-2", inputs={})
        response = await client.post("/workflows/runs/stream", json=body, headers=internal_headers)
        assert response.status_code == 422 and "required" in response.json()["detail"]["errors"][0]
    finally:
        wf.checkpointer_store.set_checkpointer(None)
        wf.compiler.forget_compiled(workflow_id)
