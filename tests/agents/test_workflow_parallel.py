"""Workflow engine — parallel paths and "Wait for all" (``join``).

Pins:

* a step with two or more plain connections starts every target at once (both
  paths' steps start before either finishes); paths advance in lockstep, one
  LangGraph superstep per step; the ``join`` runs once, after the last path
  arrives, with ``{<path's last step>: <its answer>}``;
* steps on parallel paths may write state in the same superstep (``append``
  collects from both; ``overwrite`` no longer crashes on two writes);
* inside a loop the join's barrier resets every pass;
* the validator's structure rules (straight paths, one join per fork, nothing
  else into the join, no nesting, no branching on a path, no duplicate edge);
* ``previous`` context on a parallel path is the step that led there, not the
  newest step of the other path.
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
        context=importlib.import_module("harness.workflows.context"),
        validator=importlib.import_module("harness.workflows.validator"),
        compiler=importlib.import_module("harness.workflows.compiler"),
        runner=importlib.import_module("harness.workflows.runner"),
        nodes=importlib.import_module("harness.workflows.nodes"),
        wait=importlib.import_module("harness.workflows.nodes.wait"),
    )


@pytest.fixture
def quick_wait(wf, monkeypatch):
    """``wait`` sleeps a few ms instead of seconds, still yielding to the loop."""
    real_sleep = wf.wait.asyncio.sleep

    async def short(seconds):
        await real_sleep(seconds / 100)

    monkeypatch.setattr(wf.wait.asyncio, "sleep", short)


STATE = [
    {"name": "seen", "type": "array", "reducer": "append"},
    {"name": "winner", "type": "string", "reducer": "overwrite", "default": ""},
]


def _node(node_id: str, kind: str, **config) -> dict:
    return {"id": node_id, "kind": kind, "config": config}


def _edge(source: str, target: str, branch: str | None = None) -> dict:
    edge = {"id": f"{source}-{target}-{branch or ''}", "source": source, "target": target}
    if branch:
        edge["branch"] = branch
    return edge


def _spec(nodes: list[dict], edges: list[dict], state: list[dict] | None = None) -> dict:
    return {"version": 1, "name": "parallel", "state": state if state is not None else STATE, "nodes": nodes, "edges": edges}


def _fork_join() -> dict:
    """start → (slow → a_set | quick → b_set) → all → done."""
    return _spec(
        [
            _node("start", "trigger.manual"),
            _node("slow", "wait", seconds=3),
            _node("quick", "wait", seconds=1),
            _node("a_set", "set", values={"seen": "a", "winner": "a"}),
            _node("b_set", "set", values={"seen": "b", "winner": "b"}),
            _node("all", "join"),
            _node("done", "end"),
        ],
        [
            _edge("start", "slow"),
            _edge("start", "quick"),
            _edge("quick", "b_set"),
            _edge("slow", "a_set"),
            _edge("a_set", "all"),
            _edge("b_set", "all"),
            _edge("all", "done"),
        ],
    )


def _parse(frames: list[bytes]) -> list[dict]:
    events = []
    for frame in frames:
        for line in frame.decode("utf-8").splitlines():
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return events


async def _run(wf, raw: dict) -> tuple[list[dict], dict]:
    spec, issues = wf.validator.validate_spec(raw)
    assert issues == [], [i.as_dict() for i in issues]
    compiled = wf.compiler.compile_workflow(spec, checkpointer=InMemorySaver())
    prepared = await wf.runner.prepare_run(
        compiled, run_id="run-1", thread_id="t1", owner_user_id="u1", workflow_id="w1",
        version_no=1, inputs={}, resume=None, store=None,
    )
    events = _parse([frame async for frame in prepared.stream()])
    snapshot = await compiled.graph.aget_state({"configurable": {"thread_id": "t1"}})
    return events, snapshot.values


def _steps(events: list[dict], kind: str) -> list[str]:
    return [e["workflow"]["executionId"] for e in events if e["type"] == kind]


def _messages(wf, raw: dict) -> list[str]:
    spec, issues = wf.validator.validate_spec(raw)
    assert spec is None
    return [issue.message for issue in issues]


# -- running ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parallel_paths_run_at_once_and_join_waits_for_all(wf, quick_wait):
    events, state = await _run(wf, _fork_join())

    started = _steps(events, "STEP_STARTED")

    def at(kind: str, execution_id: str) -> int:
        """Position of a step's frame in the whole stream."""
        return next(
            i for i, e in enumerate(events) if e["type"] == kind and e["workflow"]["executionId"] == execution_id
        )

    # Both paths' first steps run at the same time: both start before either finishes.
    assert max(at("STEP_STARTED", "slow#1"), at("STEP_STARTED", "quick#1")) < min(
        at("STEP_FINISHED", "slow#1"), at("STEP_FINISHED", "quick#1")
    )
    # Paths advance in lockstep (LangGraph supersteps): each path's second step
    # starts once every path's first step is done.
    assert at("STEP_FINISHED", "slow#1") < at("STEP_STARTED", "b_set#1")
    # The join runs once, after the slow path's last step.
    assert [s for s in started if s.startswith("all#")] == ["all#1"]
    assert at("STEP_FINISHED", "a_set#1") < at("STEP_STARTED", "all#1")
    assert events[-1]["type"] == "RUN_FINISHED"

    assert state["nodes"]["all"]["output"] == {"a_set": {"seen": "a", "winner": "a"}, "b_set": {"seen": "b", "winner": "b"}}
    # Both paths wrote state in their own supersteps / together without a clash.
    assert sorted(state["seen"]) == ["a", "b"]
    assert state["winner"] in {"a", "b"}


@pytest.mark.asyncio
async def test_same_superstep_writes_to_one_field_do_not_crash(wf):
    raw = _spec(
        [
            _node("start", "trigger.manual"),
            _node("a", "set", values={"seen": "a", "winner": "a"}),
            _node("b", "set", values={"seen": "b", "winner": "b"}),
            _node("all", "join"),
        ],
        [_edge("start", "a"), _edge("start", "b"), _edge("a", "all"), _edge("b", "all")],
    )
    events, state = await _run(wf, raw)
    assert events[-1]["type"] == "RUN_FINISHED"
    assert sorted(state["seen"]) == ["a", "b"] and state["winner"] in {"a", "b"}


@pytest.mark.asyncio
async def test_the_join_resets_on_every_loop_pass(wf):
    raw = _spec(
        [
            _node("start", "trigger.manual"),
            _node("again", "loop", max_iterations=3),
            _node("a", "set", values={"seen": "a"}),
            _node("b1", "set", values={"seen": "b1"}),
            _node("b2", "set", values={"seen": "b2"}),
            _node("all", "join"),
            _node("done", "end"),
        ],
        [
            _edge("start", "again"),
            _edge("again", "a", "continue"),
            _edge("again", "b1", "continue"),
            _edge("a", "all"),
            _edge("b1", "b2"),
            _edge("b2", "all"),
            _edge("all", "again"),
            _edge("again", "done", "done"),
        ],
    )
    # A branch leads to one step: the loop's "continue" cannot fork by itself.
    assert any("a branch leads to one step" in m for m in _messages(wf, raw))

    raw["nodes"].insert(2, _node("split", "set", values={"winner": "split"}))
    raw["edges"] = [e for e in raw["edges"] if e["source"] != "again" or e["branch"] != "continue"]
    raw["edges"] += [_edge("again", "split", "continue"), _edge("split", "a"), _edge("split", "b1")]
    events, state = await _run(wf, raw)

    started = _steps(events, "STEP_STARTED")
    assert [s for s in started if s.startswith("all#")] == ["all#1", "all#2", "all#3"]
    assert sorted(state["seen"]) == sorted(["a", "b1", "b2"] * 3)
    # The join's executions sit inside the loop's passes.
    joins = [e for e in events if e["type"] == "STEP_STARTED" and e["workflow"]["nodeId"] == "all"]
    assert [j["workflow"]["parentExecutionId"] for j in joins] == ["again#1", "again#2", "again#3"]


# -- validation ------------------------------------------------------------------


def test_a_valid_fork_and_join_passes(wf):
    spec, issues = wf.validator.validate_spec(_fork_join())
    assert issues == [] and spec is not None


def test_a_branching_step_on_a_path_is_refused(wf):
    raw = _fork_join()
    raw["nodes"][1] = _node("slow", "condition", rules=[{"path": "input.x", "op": "exists"}])
    raw["edges"] = [e for e in raw["edges"] if e["source"] != "slow"] + [_edge("slow", "a_set", "true")]
    assert any("can't branch" in m for m in _messages(wf, raw))


def test_paths_must_meet_at_one_join(wf):
    raw = _fork_join()
    raw["nodes"].append(_node("other", "join"))
    raw["edges"] = [e for e in raw["edges"] if e["source"] != "b_set"] + [_edge("b_set", "other"), _edge("other", "done")]
    assert any("must all end at the same 'Wait for all'" in m for m in _messages(wf, raw))


def test_a_path_that_stops_is_refused(wf):
    raw = _fork_join()
    raw["edges"] = [e for e in raw["edges"] if e["source"] != "b_set"]
    assert any("stops here" in m for m in _messages(wf, raw))


def test_nothing_else_may_lead_into_the_join(wf):
    raw = _fork_join()
    raw["nodes"].append(_node("side", "set", values={"winner": "side"}))
    raw["edges"] += [_edge("start", "side")]  # a third path that skips the join…
    raw["edges"] += [_edge("side", "done")]
    messages = _messages(wf, raw)
    assert any("Parallel paths must meet at a 'Wait for all' step before the end." in m for m in messages) or any(
        "can only be reached from that path" in m for m in messages
    )


def test_nested_forks_are_refused(wf):
    raw = _fork_join()
    raw["nodes"].append(_node("extra", "set", values={"winner": "extra"}))
    raw["edges"] += [_edge("slow", "extra"), _edge("extra", "all")]
    assert any("can't split again" in m for m in _messages(wf, raw))


def test_a_join_that_closes_no_fork_is_refused(wf):
    raw = _spec(
        [_node("start", "trigger.manual"), _node("a", "set", values={"winner": "a"}), _node("all", "join")],
        [_edge("start", "a"), _edge("a", "all")],
    )
    assert any("'Wait for all' joins parallel paths" in m for m in _messages(wf, raw))


def test_the_same_connection_twice_is_refused(wf):
    raw = _fork_join()
    raw["edges"].append({**_edge("start", "quick"), "id": "dup"})
    assert any("is already connected to 'quick'" in m for m in _messages(wf, raw))


def test_an_empty_path_is_refused(wf):
    raw = _fork_join()
    raw["edges"].append(_edge("start", "all"))
    assert any("at least one step" in m for m in _messages(wf, raw))


# -- context ----------------------------------------------------------------------


def test_previous_context_on_a_parallel_path_is_its_own_predecessor(wf):
    spec = wf.spec.WorkflowSpec.model_validate(_fork_join())
    state = {
        "nodes": {
            "start": {"output": {}},
            "slow": {"output": {"waitedSeconds": 2}},
            "quick": {"output": {"waitedSeconds": 1}},
            "b_set": {"output": {"seen": "b"}},
        },
        # The other path's steps ran after slow, but a_set's step is slow.
        "history": [
            {"node": "start", "executionId": "start#1"},
            {"node": "slow", "executionId": "slow#1"},
            {"node": "quick", "executionId": "quick#1"},
            {"node": "b_set", "executionId": "b_set#1"},
        ],
    }
    entries = wf.context.gather_context(
        wf.context.StepContext(), state, spec, "a_set", kinds=wf.nodes.NODE_KINDS
    )
    assert [e["step"] for e in entries] == ["slow"]
