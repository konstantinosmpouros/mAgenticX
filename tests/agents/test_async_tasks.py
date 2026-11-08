"""Async sub-agents on the agents side (plan 41): ``/ap``, the launch token, the runner.

Pinned here:

* **contract** — the real ``langgraph_sdk`` client round-trips every ``/ap``
  call deepagents makes (in-process ASGI, the same transport production uses);
* **authorisation** — no token, a forged or expired one, another user, another
  conversation, another branch, a sibling task: all refused, and the internal
  gate still applies;
* **runner rules** — caps fail closed, the pending guard folds a follow-up into
  a run that has not started, a settled task reopens, a task waiting on its
  children reports ``busy`` and hides a failed run until its subtree settles;
* **end to end** with scripted models, through the real middleware → ``/ap`` →
  runner → our ``build_deep_agent``: start, chat while a task runs, update
  (interrupt), cancel with its subtree, a depth-3 tree settling bottom-up, a
  result pulled into a busy parent, a restart that errors a task and an update
  that reopens it, an approval that pauses a task and a resume;
* the notification adapter against the real middleware's dedupe, and the
  bridge's replayed notice row.

The task store is an in-memory twin of ``AsyncTaskStore`` (the SQL is pinned
against Postgres in ``test_async_task_store.py``); Redis is fakeredis; the
checkpointer is LangGraph's in-memory saver.
"""
from __future__ import annotations

import asyncio
import copy
import importlib
import itertools
import json
import re
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, ClassVar

import fakeredis.aioredis
import httpx
import pytest
import pytest_asyncio
from deepagents.middleware import async_subagents
from deepagents.middleware.async_subagents import AsyncSubAgentMiddleware, _notification_event
from fastapi import HTTPException
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph_sdk.client import LangGraphClient

pytestmark = pytest.mark.asyncio

USER = "u-1"
CONVERSATION = "c-1"
BRANCH = "branch-1"
SLUG = "async-tree-test"
SETTLED = {"success", "error", "cancelled"}


# ---------------------------------------------------------------------------
# The in-memory twin of AsyncTaskStore
# ---------------------------------------------------------------------------
class FakeTaskStore:
    """``AsyncTaskStore`` with dicts — same methods, same semantics."""

    ACTIVE = ("pending", "running", "waiting_children")

    def __init__(self) -> None:
        self.tasks: dict[str, dict[str, Any]] = {}
        self.runs: dict[str, dict[str, Any]] = {}
        self._seq = itertools.count()

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    async def setup(self) -> None:
        return None

    async def insert_task(self, task):
        row = copy.deepcopy(dict(task))
        row.setdefault("parent_task_id", None)
        for key in ("result", "description", "model", "result_preview", "error", "cancel_reason",
                    "files_snapshot_hash", "settled_at", "parent_notified_at"):
            row.setdefault(key, None)
        row["created_at"] = row["updated_at"] = self._now()
        row["_seq"] = next(self._seq)
        self.tasks[row["task_id"]] = row

    def _out(self, row):
        return None if row is None else {k: v for k, v in copy.deepcopy(row).items() if k != "_seq"}

    async def get_task(self, task_id):
        return self._out(self.tasks.get(task_id))

    async def update_task(self, task_id, fields):
        if task_id in self.tasks:
            self.tasks[task_id].update(copy.deepcopy(dict(fields)))
            self.tasks[task_id]["updated_at"] = self._now()

    async def mark_notified(self, task_id, when=None):
        row = self.tasks.get(task_id)
        if row is None or row["parent_notified_at"] is not None or row["settled_at"] is None:
            return False
        row["parent_notified_at"] = when or self._now()
        return True

    async def clear_notified(self, task_id):
        row = self.tasks.get(task_id)
        if row is not None:
            row["parent_notified_at"] = None

    def _sorted(self, rows):
        return sorted(rows, key=lambda r: r["_seq"])

    async def list_tasks(self, user_id, conversation_id, limit):
        rows = [r for r in self.tasks.values() if r["user_id"] == user_id and r["conversation_id"] == conversation_id]
        return [self._out(r) for r in self._sorted(rows)[:limit]]

    async def children(self, task_id):
        return [self._out(r) for r in self._sorted(r for r in self.tasks.values() if r["parent_task_id"] == task_id)]

    async def subtree_ids(self, task_id):
        if task_id not in self.tasks:
            return []
        out, frontier = [task_id], [task_id]
        while frontier:
            frontier = [r["task_id"] for r in self._sorted(self.tasks.values()) if r["parent_task_id"] in frontier]
            out.extend(frontier)
        return out

    async def count_active_for_user(self, user_id):
        return sum(1 for r in self.tasks.values() if r["user_id"] == user_id and r["status"] in self.ACTIVE)

    async def count_active_children(self, *, parent_task_id, conversation_id, branch_thread_id):
        open_ = (*self.ACTIVE, "waiting")
        if parent_task_id is not None:
            return sum(1 for r in self.tasks.values() if r["parent_task_id"] == parent_task_id and r["status"] in open_)
        return sum(
            1 for r in self.tasks.values()
            if r["parent_task_id"] is None and r["conversation_id"] == conversation_id
            and r["branch_thread_id"] == branch_thread_id and r["status"] in open_
        )

    async def unnotified(self, limit, *, user_id=None, conversation_id=None):
        rows = [
            r for r in self.tasks.values()
            if r["parent_task_id"] is None and r["settled_at"] is not None and r["parent_notified_at"] is None
            and (not user_id or r["user_id"] == user_id) and (not conversation_id or r["conversation_id"] == conversation_id)
        ]
        return [self._out(r) for r in self._sorted(rows)[:limit]]

    async def scope_task_ids(self, user_id, *, conversation_id=None, root_run_id=None):
        return [
            r["task_id"] for r in self._sorted(self.tasks.values())
            if r["user_id"] == user_id and r["parent_task_id"] is None
            and (not conversation_id or r["conversation_id"] == conversation_id)
            and (not root_run_id or r["root_run_id"] == root_run_id)
        ]

    async def unsettled_task_ids(self):
        rows = [r for r in self.tasks.values() if r["status"] in self.ACTIVE]
        return [r["task_id"] for r in sorted(rows, key=lambda r: (-r["depth"], r["_seq"]))]

    async def delete_conversation(self, user_id, conversation_id):
        gone = [t for t, r in self.tasks.items() if r["user_id"] == user_id and r["conversation_id"] == conversation_id]
        for task_id in gone:
            del self.tasks[task_id]
        return gone

    async def delete_user(self, user_id):
        gone = [t for t, r in self.tasks.items() if r["user_id"] == user_id]
        for task_id in gone:
            del self.tasks[task_id]
        return gone

    async def insert_run(self, run):
        row = {"error": None, "usage": {}, "waiting": False, "started_at": None, "ended_at": None,
               "multitask_strategy": None, **copy.deepcopy(dict(run))}
        row["created_at"] = self._now()
        row["_seq"] = next(self._seq)
        self.runs[row["run_id"]] = row

    async def get_run(self, run_id):
        return self._out(self.runs.get(run_id))

    async def update_run(self, run_id, fields):
        if run_id in self.runs:
            self.runs[run_id].update(copy.deepcopy(dict(fields)))

    async def list_runs(self, task_id, *, limit, offset=0):
        rows = sorted((r for r in self.runs.values() if r["task_id"] == task_id), key=lambda r: -r["_seq"])
        return [self._out(r) for r in rows[offset:offset + limit]]

    async def count_runs(self, task_id):
        return sum(1 for r in self.runs.values() if r["task_id"] == task_id)

    async def usage_totals(self, task_ids):
        totals: dict[str, dict[str, int]] = {}
        for r in self.runs.values():
            if r["task_id"] in task_ids:
                bucket = totals.setdefault(r["task_id"], {})
                for key, value in (r.get("usage") or {}).items():
                    bucket[key] = bucket.get(key, 0) + value
        return totals

    async def fail_unfinished_runs(self, error):
        cut = set()
        for r in self.runs.values():
            if r["status"] in ("pending", "running"):
                r.update(status="error", error=error, ended_at=self._now())
                cut.add(r["task_id"])
        return sorted(cut)


# ---------------------------------------------------------------------------
# Scripted models and tools
# ---------------------------------------------------------------------------
GATES: dict[str, asyncio.Event] = {}
#: The gates a run is waiting at right now.
WAITING: set[str] = set()


@tool
async def wait_gate(key: str) -> str:
    """Wait until the test opens the gate ``key``."""
    WAITING.add(key)
    try:
        await GATES.setdefault(key, asyncio.Event()).wait()
    finally:
        WAITING.discard(key)
    return f"gate {key} opened"


@tool
def danger(target: str) -> str:
    """A tool that needs approval."""
    return f"danger done on {target}"


def _text(message: BaseMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    return "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)


def _notification(message: BaseMessage) -> dict | None:
    if not isinstance(message, HumanMessage):
        return None
    event = message.additional_kwargs.get("deepagents_notification")
    return event if isinstance(event, dict) else None


def _call(name: str, args: dict) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"call_{uuid.uuid4().hex[:8]}"}])


def _humans(messages: list[BaseMessage]) -> list[str]:
    return [_text(m) for m in messages if isinstance(m, HumanMessage) and _notification(m) is None]


def _last_task_id(messages: list[BaseMessage]) -> str:
    for message in reversed(messages):
        if isinstance(message, ToolMessage):
            hit = re.search(r"task_id: ([0-9a-f-]{36})", _text(message))
            if hit:
                return hit.group(1)
    return "none"


class RuleModel(BaseChatModel):
    """A model that decides from the conversation, like the experiment's fakes."""

    who: str
    child: str | None = None
    seen: ClassVar[dict[str, list[list[BaseMessage]]]] = {}

    @property
    def _llm_type(self) -> str:
        return "rule"

    def bind_tools(self, tools: Any, **kwargs: Any) -> RuleModel:
        return self

    def _generate(self, messages, stop=None, run_manager: CallbackManagerForLLMRun | None = None, **kw):
        visible = [m for m in messages if m.type != "system"]
        type(self).seen.setdefault(self.who, []).append(visible)
        reply = self.decide(visible)
        reply.usage_metadata = {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}
        return ChatResult(generations=[ChatGeneration(message=reply)])

    def decide(self, messages: list[BaseMessage]) -> AIMessage:
        last = messages[-1]
        event = _notification(last)
        if event is not None:
            return AIMessage(content=f"{self.who} saw {event['agent_name']} {event['status']}: {_text(last)[-400:]}")
        first = (_humans(messages) or [""])[0]
        if isinstance(last, ToolMessage):
            if last.name == "start_async_task":
                if "wait" in first:
                    return _call("wait_gate", {"key": self.who})
                return AIMessage(content=f"{self.who} delegated")
            if last.name == "danger":
                return AIMessage(content=f"{self.who} after danger: {_text(last)}")
            return AIMessage(content=f"{self.who} done; humans={_humans(messages)}")
        text = _text(last)
        if self.who == "main":
            if text.startswith("research"):
                return _call("start_async_task", {"description": text, "subagent_type": "researcher"})
            if text.startswith("update:"):
                return _call("update_async_task", {"task_id": _last_task_id(messages), "message": text})
            if text.startswith("status"):
                return _call("check_async_task", {"task_id": _last_task_id(messages)})
            if text.startswith("cancel"):
                return _call("cancel_async_task", {"task_id": _last_task_id(messages)})
            return AIMessage(content=f"main chat: {text}")
        if "delegate" in text and self.child:
            # The child gets one "delegate" fewer and no "wait" (this node's own).
            child_text = text.replace("delegate", "", 1).replace("wait", "").strip()
            return _call("start_async_task", {"description": child_text, "subagent_type": self.child})
        if "danger" in text:
            return _call("danger", {"target": "x"})
        if "wait" in text or "hold" in text:
            return _call("wait_gate", {"key": self.who})
        return AIMessage(content=f"{self.who} result; humans={_humans(messages)}")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
def _tree_agent_class(agents_service):
    """A deep agent: main → researcher → helper → sub-helper (depth 3)."""
    deep_agent = importlib.import_module("harness.abstractions.deep_agent")
    tree = importlib.import_module("harness.abstractions.subagent_tree")

    class TreeAgent(deep_agent.DeepAgent):
        name = SLUG
        version = "1.0.0"
        hitl_gates: ClassVar[dict] = {}

        def load_skills(self):
            return []

        def register_subagents(self):
            return [
                tree.subagent(
                    "researcher", "Researches.", "Research.",
                    model=RuleModel(who="researcher", child="helper"),
                    tools=[wait_gate, danger],
                    interrupt_on={"danger": True},
                    subagents=[
                        tree.subagent(
                            "helper", "Helps.", "Help.",
                            model=RuleModel(who="helper", child="sub-helper"),
                            tools=[wait_gate],
                            subagents=[tree.subagent("sub-helper", "Sub-helps.", "Sub-help.",
                                                     model=RuleModel(who="sub-helper"), tools=[wait_gate])],
                        )
                    ],
                )
            ]

        def register_agent(self):
            return self.build_deep_agent(
                model=RuleModel(who="main"), system_prompt="Orchestrate.", subagents=self.sub_agents
            )

    return TreeAgent


@pytest_asyncio.fixture
async def env(agents_service, monkeypatch):
    """The service with async sub-agents on, a runner over the fake store, fakeredis."""
    settings = agents_service.settings_module.settings
    settings.async_tasks.enabled = True
    settings.mcp.mcp_gateway_url = ""
    GATES.clear()
    WAITING.clear()
    RuleModel.seen = {}
    checkpointer_store = importlib.import_module("harness.checkpointer.store")
    saver = MemorySaver()
    checkpointer_store.set_checkpointer(saver)
    runner_mod = importlib.import_module("harness.async_tasks.runner")
    events_mod = importlib.import_module("harness.async_tasks.events")
    token_mod = importlib.import_module("harness.async_tasks.token")
    specs_mod = importlib.import_module("harness.async_tasks.specs")
    client_mod = importlib.import_module("harness.async_tasks.client")
    catalog = importlib.import_module("schema.catalog")
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    store = FakeTaskStore()
    runner = runner_mod.TaskRunner(store, events_mod.TaskStreamPublisher(client=redis))
    runner_mod.set_task_runner(runner)
    client_mod.set_protocol_app(agents_service.main.app)
    agent_cls = _tree_agent_class(agents_service)
    definition = catalog.AgentDefinition(slug=SLUG, manifest=agent_cls.manifest(), cls=agent_cls)
    monkeypatch.setitem(agents_service.agents_utils.AGENT_REGISTRY, SLUG, definition)
    ns = SimpleNamespace(
        service=agents_service, settings=settings, store=store, runner=runner, redis=redis, saver=saver,
        runner_mod=runner_mod, token=token_mod, specs=specs_mod, client=client_mod, definition=definition,
        turns=itertools.count(1),
    )
    try:
        yield ns
    finally:
        for event in GATES.values():
            event.set()
        await runner.shutdown()
        runner_mod.set_task_runner(None)
        checkpointer_store.set_checkpointer(None)


def _root_config(env, *, branch: str = BRANCH, user: str = USER, conversation: str = CONVERSATION) -> dict:
    return {
        "context": {
            "user_id": user, "conversation_id": conversation, "run_id": f"msg-{next(env.turns)}",
            "use_memory": False, "interactive": True,
            # start_async_task is gated by default; these turns run unattended.
            "tool_config": {"approvals": {"start_async_task": False}},
        },
        "run_config": {"configurable": {"thread_id": branch}},
    }


async def turn(env, text: str, **identity) -> list[BaseMessage]:
    """One orchestrator turn, built per request like the stream route does."""
    agent = env.definition.build(config=_root_config(env, **identity))
    async for _ in agent.astream({"messages": [{"role": "user", "content": text}]}):
        pass
    state = await agent.compiled.aget_state(agent.run_config)
    return list(state.values["messages"])


async def settle(env, timeout: float = 20.0) -> None:
    """Wait until no task run is in flight."""
    await asyncio.wait_for(env.runner.idle(), timeout)


async def until(predicate, timeout: float = 20.0) -> None:
    async def poll():
        while not await predicate():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(poll(), timeout)


def open_gate(key: str) -> None:
    GATES.setdefault(key, asyncio.Event()).set()


def tasks_by_name(env) -> dict[str, dict]:
    return {row["name"]: row for row in env.store.tasks.values()}


async def stream_entries(env, key: str) -> list[dict]:
    return [json.loads(fields["data"]) for _id, fields in await env.redis.xrange(key)]


def mint(env, **overrides) -> str:
    claims = dict(
        user_id=USER, conversation_id=CONVERSATION, root_run_id="msg-0", branch_thread_id=BRANCH,
        caller_task_id=None, caller_depth=0, caller_path=[], agent_slug=SLUG,
        definition_version=env.definition.build(config=_root_config(env)).definition_fingerprint(),
        context=env.token.InheritedContext(),
    )
    claims.update(overrides)
    return env.token.mint_launch_token(**claims)


def sdk(env, token: str | None, *, internal: bool = True) -> LangGraphClient:
    headers = {}
    if internal:
        headers.update(env.service.proxy.internal_service_headers())
    if token is not None:
        headers[env.token.LAUNCH_TOKEN_HEADER] = token
    return env.client.protocol_client(env.specs.protocol_url(), headers)


def graph_id(env, *path: str) -> str:
    version = env.definition.build(config=_root_config(env)).definition_fingerprint()
    return env.specs.graph_id_for(SLUG, version, list(path))


# ---------------------------------------------------------------------------
# Contract: the real langgraph_sdk client against /ap
# ---------------------------------------------------------------------------
async def test_sdk_round_trip_of_every_call_deepagents_makes(env):
    GATES["researcher"] = asyncio.Event()
    client = sdk(env, mint(env))
    thread = await client.threads.create(metadata={"subagent_name": "researcher", "parent_thread_id": BRANCH})
    assert set(thread) >= {"thread_id", "status", "metadata", "created_at", "updated_at", "values", "interrupts"}
    assert thread["status"] == "busy"  # created, not settled
    run = await client.runs.create(
        thread_id=thread["thread_id"], assistant_id=graph_id(env, "researcher"),
        input={"messages": [{"role": "user", "content": "please wait here"}]},
    )
    assert run["thread_id"] == thread["thread_id"] and run["status"] in ("pending", "running")
    got = await client.runs.get(thread_id=thread["thread_id"], run_id=run["run_id"])
    assert got["run_id"] == run["run_id"]
    listed = await client.runs.list(thread_id=thread["thread_id"], limit=1)
    assert [r["run_id"] for r in listed] == [run["run_id"]]
    await until(lambda: _status(env, thread["thread_id"], "running"))
    open_gate("researcher")
    await settle(env)
    done = await client.threads.get(thread_id=thread["thread_id"])
    assert done["status"] == "idle"
    assert "researcher done" in done["values"]["messages"][-1]["content"]
    assert (await client.runs.get(thread_id=thread["thread_id"], run_id=run["run_id"]))["status"] == "success"
    # Reading the settled task as its parent is a delivery.
    assert env.store.tasks[thread["thread_id"]]["parent_notified_at"] is not None
    cancelled = await client.runs.cancel(thread_id=thread["thread_id"], run_id=run["run_id"])
    assert cancelled["status"] == "success"  # an ended run is left alone


async def _status(env, task_id: str, status: str) -> bool:
    return env.store.tasks.get(task_id, {}).get("status") == status


async def test_command_and_webhook_and_client_thread_ids_are_refused(env):
    client = sdk(env, mint(env))
    thread = await client.threads.create(metadata={"subagent_name": "researcher"})
    for extra in ({"command": {"resume": "yes"}}, {"webhook": "https://evil.example/hook"}):
        with pytest.raises(httpx.HTTPStatusError) as exc:
            await client.runs.create(
                thread_id=thread["thread_id"], assistant_id=graph_id(env, "researcher"),
                input={"messages": [{"role": "user", "content": "x"}]}, **extra,
            )
        assert exc.value.response.status_code == 400
    with pytest.raises(httpx.HTTPStatusError) as exc:
        await client.threads.create(thread_id=str(uuid.uuid4()), metadata={"subagent_name": "researcher"})
    assert exc.value.response.status_code == 422
    with pytest.raises(httpx.HTTPStatusError) as exc:
        await client.runs.create(
            thread_id=thread["thread_id"], assistant_id=graph_id(env, "helper"),
            input={"messages": [{"role": "user", "content": "x"}]},
        )
    assert exc.value.response.status_code == 400


# ---------------------------------------------------------------------------
# Authorisation matrix
# ---------------------------------------------------------------------------
async def test_authorisation_matrix(env):
    owner = sdk(env, mint(env))
    thread = await owner.threads.create(metadata={"subagent_name": "researcher"})
    task_id = thread["thread_id"]
    assert (await owner.threads.get(thread_id=task_id))["thread_id"] == task_id

    refusals = {
        "no token": (sdk(env, None), 401),
        "forged": (sdk(env, mint(env)[:-4] + "AAAA"), 401),
        "expired": (sdk(env, mint(env, ttl_seconds=-10)), 401),
        "other user": (sdk(env, mint(env, user_id="u-2")), 404),
        "other conversation": (sdk(env, mint(env, conversation_id="c-2")), 404),
        "other branch": (sdk(env, mint(env, branch_thread_id="branch-2")), 404),
        "a sibling task": (sdk(env, mint(env, caller_task_id=str(uuid.uuid4()), caller_depth=1,
                                         caller_path=["researcher"])), 404),
        "no internal secret": (sdk(env, mint(env), internal=False), 403),
    }
    for label, (client, code) in refusals.items():
        with pytest.raises(httpx.HTTPStatusError) as exc:
            await client.threads.get(thread_id=task_id)
        assert exc.value.response.status_code == code, label


async def test_a_child_task_answers_only_to_its_parent_task(env):
    owner = sdk(env, mint(env))
    parent = await owner.threads.create(metadata={"subagent_name": "researcher"})
    as_parent = sdk(env, mint(env, caller_task_id=parent["thread_id"], caller_depth=1, caller_path=["researcher"]))
    child = await as_parent.threads.create(metadata={"subagent_name": "helper"})
    row = env.store.tasks[child["thread_id"]]
    assert row["parent_task_id"] == parent["thread_id"] and row["depth"] == 2
    assert row["subagent_path"] == "researcher/helper"
    # The orchestrator is not the child's parent.
    with pytest.raises(httpx.HTTPStatusError) as exc:
        await owner.threads.get(thread_id=child["thread_id"])
    assert exc.value.response.status_code == 404
    assert (await as_parent.threads.get(thread_id=child["thread_id"]))["thread_id"] == child["thread_id"]


# ---------------------------------------------------------------------------
# Runner rules
# ---------------------------------------------------------------------------
async def test_caps_fail_closed(env):
    caps = env.settings.async_tasks
    client = sdk(env, mint(env))
    caps.max_children_per_task = 1
    await client.threads.create(metadata={"subagent_name": "researcher"})
    with pytest.raises(httpx.HTTPStatusError) as exc:
        await client.threads.create(metadata={"subagent_name": "researcher"})
    assert exc.value.response.status_code == 429
    caps.max_children_per_task = 8
    caps.max_active_per_user = 1
    with pytest.raises(httpx.HTTPStatusError) as exc:
        await client.threads.create(metadata={"subagent_name": "researcher"})
    assert exc.value.response.status_code == 429
    caps.max_active_per_user = 16
    too_deep = sdk(env, mint(env, caller_task_id=None, caller_depth=3, caller_path=["a", "b", "c"]))
    with pytest.raises(httpx.HTTPStatusError) as exc:
        await too_deep.threads.create(metadata={"subagent_name": "x"})
    assert exc.value.response.status_code == 400


async def test_runs_per_task_cap(env):
    env.settings.async_tasks.max_runs_per_task = 1
    client = sdk(env, mint(env))
    thread = await client.threads.create(metadata={"subagent_name": "researcher"})
    body = dict(thread_id=thread["thread_id"], assistant_id=graph_id(env, "researcher"),
                input={"messages": [{"role": "user", "content": "hi"}]})
    await client.runs.create(**body)
    await settle(env)
    with pytest.raises(httpx.HTTPStatusError) as exc:
        await client.runs.create(**body)
    assert exc.value.response.status_code == 429


async def test_pending_guard_folds_a_follow_up_into_a_run_that_has_not_started(env):
    claims = env.token.verify_launch_token(mint(env))
    task = await env.runner.create_task(claims, "researcher")
    first = await env.runner.create_run(task, assistant_id=graph_id(env, "researcher"),
                                        messages=[{"content": "find apples"}], strategy="interrupt")
    second = await env.runner.create_run(task, assistant_id=graph_id(env, "researcher"),
                                         messages=[{"content": "also pears"}], strategy="interrupt")
    assert second["run_id"] == first["run_id"]
    await settle(env)
    assert await env.store.count_runs(task["task_id"]) == 1
    final = env.store.tasks[task["task_id"]]["result"]["content"]
    assert "find apples" in final and "also pears" in final


async def test_waiting_children_reads_busy_and_hides_a_failed_run(env):
    utils = importlib.import_module("utils.async_tasks")
    task = {"task_id": "t", "status": "waiting_children", "agent_slug": SLUG, "definition_version": "v",
            "subagent_path": "researcher"}
    run = {"run_id": "r", "status": "error", "error": "boom", "created_at": datetime.now(UTC)}
    assert utils.thread_status(task) == "busy"
    view = utils.run_view(task, run, "r")
    assert view.status == "success" and view.error is None
    task["status"] = "error"
    assert utils.run_view(task, run, "r").status == "error"
    assert utils.thread_status(task) == "error"
    assert utils.thread_status({**task, "status": "waiting"}) == "interrupted"
    assert utils.thread_status({**task, "status": "cancelled"}) == "idle"


async def test_the_launch_token_is_tamper_proof_and_expires(env):
    token = mint(env)
    claims = env.token.verify_launch_token(token)
    assert claims.user_id == USER and claims.caller_task_id is None
    body, sig = token.split(".")
    for bad in (f"{body}x.{sig}", f"{body}.{sig[:-2]}xx", "", "a.b.c"):
        with pytest.raises(env.token.LaunchTokenError):
            env.token.verify_launch_token(bad)
    with pytest.raises(env.token.LaunchTokenError):
        env.token.verify_launch_token(mint(env, ttl_seconds=-1))


# ---------------------------------------------------------------------------
# The notification adapter and the bridge's replayed notice row
# ---------------------------------------------------------------------------
async def test_notification_matches_what_the_middleware_records(env):
    notification = importlib.import_module("harness.async_tasks.notification")
    message = notification.build_notification(
        task_id="t-1", agent_name="researcher", status="success", run_id="r-1",
        result=[{"type": "text", "text": "the answer"}],
    )
    human = notification.to_human_message(message)
    assert _notification_event(human) == {"task_id": "t-1", "agent_name": "researcher", "status": "success", "run_id": "r-1"}
    tracked = {"t-1": {"task_id": "t-1", "agent_name": "researcher", "thread_id": "t-1", "run_id": "r-0",
                       "status": "running", "created_at": "", "last_checked_at": "", "last_updated_at": ""}}
    recorded = AsyncSubAgentMiddleware._record_notification({"messages": [human], "async_tasks": tracked})
    assert recorded["async_tasks"]["t-1"]["status"] == "success"
    assert "the answer" in "".join(b["text"] for b in human.content)
    payload = notification.notification_payload(message)
    replayed = notification.normalize_payload_messages(
        [{"role": "user", "content": "hi"},
         {"sender": "user", "kind": "task_notification", "content": payload["content"],
          "additional_kwargs": {**payload["additional_kwargs"], "evil": 1}}]
    )
    assert replayed[0] == {"role": "user", "content": "hi"}
    assert isinstance(replayed[1], HumanMessage) and _notification_event(replayed[1])["task_id"] == "t-1"
    assert "evil" not in replayed[1].additional_kwargs


async def test_flag_off_keeps_the_blocking_task_tool(env):
    env.settings.async_tasks.enabled = False
    agent = env.definition.build(config=_root_config(env))
    await agent.ensure_built()
    names = set(agent.compiled.get_graph().nodes)
    tools = _tool_names(agent)
    assert "task" in tools and "start_async_task" not in tools, names


async def test_flag_on_gives_the_five_task_tools(env):
    agent = env.definition.build(config=_root_config(env))
    await agent.ensure_built()
    tools = _tool_names(agent)
    assert {"start_async_task", "check_async_task", "update_async_task", "cancel_async_task",
            "list_async_tasks"} <= tools


def _tool_names(agent) -> set[str]:
    node = agent.compiled.nodes["tools"].bound
    return set(node.tools_by_name)


# ---------------------------------------------------------------------------
# End to end: scripted models through the real middleware, /ap and the runner
# ---------------------------------------------------------------------------
async def test_start_settles_and_rings_the_outbox(env):
    messages = await turn(env, "research apples and wait")
    assert "Launched async subagent" in _text(next(m for m in messages if isinstance(m, ToolMessage)))
    # The orchestrator's turn is over before the task finishes: no pull, an outbox row.
    open_gate("researcher")
    await settle(env)
    researcher = tasks_by_name(env)["researcher"]
    assert researcher["status"] == "success" and researcher["depth"] == 1
    assert researcher["parent_notified_at"] is None
    assert "researcher done" in researcher["result_preview"]
    outbox = await stream_entries(env, "tasks:outbox")
    assert [item["task_id"] for item in outbox] == [researcher["task_id"]]
    assert outbox[0]["status"] == "success" and outbox[0]["cancelled_by_user"] is False
    assert outbox[0]["notification"]["additional_kwargs"]["lc_source"] == "async_subagent"
    statuses = [e["event"] for e in await stream_entries(env, "tasks:status")]
    assert statuses[0] == "TASK_STARTED" and statuses[-1] == "TASK_SETTLED"
    events = await stream_entries(env, f"task:{researcher['task_id']}:events")
    assert any(e.get("type") == "TEXT_MESSAGE_CONTENT" or e.get("type") == "TEXT_MESSAGE_CHUNK" for e in events)
    # The bridge's reconcile path sees the same item.
    utils = importlib.import_module("utils.async_tasks")
    unnotified = await utils.tasks_unnotified(10, USER, None)
    assert [item.task_id for item in unnotified] == [researcher["task_id"]]


async def test_chat_while_a_task_runs_then_check(env):
    await turn(env, "research and wait")
    await until(lambda: _status(env, tasks_by_name(env)["researcher"]["task_id"], "running"))
    reply = await turn(env, "hello there")
    assert _text(reply[-1]) == "main chat: hello there"
    assert tasks_by_name(env)["researcher"]["status"] == "running"
    checked = await turn(env, "status please")
    assert '"status": "running"' in _text([m for m in checked if isinstance(m, ToolMessage)][-1])
    open_gate("researcher")
    await settle(env)
    assert tasks_by_name(env)["researcher"]["status"] == "success"


async def test_update_interrupts_the_run_and_the_new_run_sees_both(env):
    await turn(env, "research and wait")
    task_id = tasks_by_name(env)["researcher"]["task_id"]
    await until(lambda: _status(env, task_id, "running"))
    await until(lambda: _waiting_at("researcher"))
    await turn(env, "update: also pears")
    await settle(env)
    runs = sorted((r for r in env.store.runs.values() if r["task_id"] == task_id), key=lambda r: r["_seq"])
    assert [r["status"] for r in runs] == ["interrupted", "success"]
    assert [r["kind"] for r in runs] == ["start", "update"]
    final = env.store.tasks[task_id]["result"]["content"]
    assert "research and wait" in final and "update: also pears" in final
    # The follow-up is in the task's own stream, so its drill-down shows what
    # it was asked where the new run begins; the first input is not (it is the
    # task's description).
    events = await stream_entries(env, f"task:{task_id}:events")
    inputs = [e["value"]["text"] for e in events if e.get("type") == "CUSTOM" and e.get("name") == "TASK_INPUT"]
    assert len(inputs) == 1 and "update: also pears" in inputs[0]


async def _waiting_at(key: str) -> bool:
    return key in WAITING


async def test_cancel_stops_the_whole_subtree(env):
    await turn(env, "research delegate delegate hold")
    await until(lambda: _named_status(env, "sub-helper", "running"))
    await turn(env, "cancel it")
    await settle(env)
    rows = tasks_by_name(env)
    assert {name: rows[name]["status"] for name in rows} == {
        "researcher": "cancelled", "helper": "cancelled", "sub-helper": "cancelled"}
    assert rows["researcher"]["cancel_reason"] == "parent"
    assert rows["helper"]["cancel_reason"] == "cascade"
    # The parent asked for it: nobody is woken, nothing waits in the outbox.
    assert all(row["parent_notified_at"] is not None for row in rows.values())
    assert await stream_entries(env, "tasks:outbox") == []
    assert not env.runner._active
    # The stop settles each task before its interrupted run records what it
    # spent; the last announcement still carries that spend, so the bridge
    # books it.
    last: dict[str, dict] = {}
    for entry in await stream_entries(env, "tasks:status"):
        last[entry["task"]["task_id"]] = entry
    for name in ("researcher", "helper", "sub-helper"):
        final = last[rows[name]["task_id"]]
        assert final["event"] == "TASK_SETTLED" and final["task"]["status"] == "cancelled"
        assert final["task"]["usage"]["calls"] >= 1


async def _named_status(env, name: str, status: str) -> bool:
    row = tasks_by_name(env).get(name)
    return row is not None and row["status"] == status


async def test_a_user_stop_rings_the_outbox_marked_as_the_users(env):
    await turn(env, "research and wait")
    task_id = tasks_by_name(env)["researcher"]["task_id"]
    await until(lambda: _status(env, task_id, "running"))
    utils = importlib.import_module("utils.async_tasks")
    schema = importlib.import_module("schema.async_tasks")
    out = await utils.tasks_cancel(task_id, schema.TaskCancelIn(user_id=USER))
    assert out.status == "cancelled"
    await settle(env)
    outbox = await stream_entries(env, "tasks:outbox")
    assert outbox[-1]["task_id"] == task_id and outbox[-1]["cancelled_by_user"] is True
    with pytest.raises(HTTPException) as refused:
        await utils.tasks_cancel(task_id, schema.TaskCancelIn(user_id="u-2"))
    assert refused.value.status_code == 404


async def test_a_user_stop_of_a_nested_task_wakes_no_one(env):
    # The regression: stopping a nested task woke its parent, which carried on
    # (and could start the task again), finished and woke the orchestrator.
    # Now the parent is not woken: with nothing else working, it settles.
    await turn(env, "research delegate hold")
    await until(lambda: _named_status(env, "helper", "running"))
    rows = tasks_by_name(env)
    researcher, helper = rows["researcher"], rows["helper"]
    await until(lambda: _status(env, researcher["task_id"], "waiting_children"))
    utils = importlib.import_module("utils.async_tasks")
    schema = importlib.import_module("schema.async_tasks")
    out = await utils.tasks_cancel(helper["task_id"], schema.TaskCancelIn(user_id=USER))
    assert out.status == "cancelled"
    await settle(env)

    researcher = env.store.tasks[researcher["task_id"]]
    assert researcher["status"] == "success"
    kinds = [r["kind"] for r in env.store.runs.values() if r["task_id"] == researcher["task_id"]]
    assert kinds == ["start"]  # never woken for the stop
    assert env.store.tasks[helper["task_id"]]["parent_notified_at"] is not None
    # The researcher finished: that, as any finished task, tells the orchestrator.
    outbox = await stream_entries(env, "tasks:outbox")
    assert outbox[-1]["task_id"] == researcher["task_id"] and outbox[-1]["cancelled_by_user"] is False


async def test_a_task_node_is_built_with_its_own_platform_sections(env, monkeypatch):
    # The regression: a task's prompt was its spec's instructions alone, so the
    # narration (and file-work) rules never reached a background sub-agent.
    deep_agent_module = importlib.import_module("harness.abstractions.deep_agent")
    prompts: dict[str, str] = {}
    real = deep_agent_module.create_deep_agent

    def capture(*args, **kwargs):
        prompts[kwargs.get("name") or "?"] = kwargs.get("system_prompt") or ""
        prompts["last"] = kwargs.get("system_prompt") or ""
        return real(*args, **kwargs)

    monkeypatch.setattr(deep_agent_module, "create_deep_agent", capture)
    await turn(env, "research and wait")
    task_id = tasks_by_name(env)["researcher"]["task_id"]
    await until(lambda: _status(env, task_id, "running"))
    await until(lambda: _waiting_at("researcher"))
    task_prompt = prompts["last"]
    assert "## Narrate Your Work as You Go" in task_prompt
    assert "## Work Efficiently With Files" in task_prompt
    assert "Keep the User in the Loop" not in task_prompt
    open_gate("researcher")
    await settle(env)


async def test_a_depth_three_tree_settles_bottom_up(env):
    await turn(env, "research delegate delegate")
    await settle(env)
    rows = tasks_by_name(env)
    assert [rows[n]["depth"] for n in ("researcher", "helper", "sub-helper")] == [1, 2, 3]
    assert all(row["status"] == "success" for row in rows.values())
    # Each parent settled only after its child, and was woken by it.
    assert rows["sub-helper"]["settled_at"] <= rows["helper"]["settled_at"] <= rows["researcher"]["settled_at"]
    # Each parent heard its child's result — woken by it, or (the fakes are
    # quick) pulling it before its own run ended — and reported it.
    assert all(rows[n]["parent_notified_at"] is not None for n in ("helper", "sub-helper"))
    assert "helper saw sub-helper success" in rows["helper"]["result_preview"]
    assert "researcher saw helper success" in rows["researcher"]["result_preview"]
    outbox = await stream_entries(env, "tasks:outbox")
    assert [item["task_id"] for item in outbox] == [rows["researcher"]["task_id"]]
    # The orchestrator heard once, at the end: no TASK_SETTLED for the root before the end.
    settled = [e for e in await stream_entries(env, "tasks:status") if e["event"] == "TASK_SETTLED"]
    assert [e["task"]["name"] for e in settled] == ["sub-helper", "helper", "researcher"]


async def test_a_busy_parent_pulls_its_childs_result(env):
    await turn(env, "research delegate then wait")
    await until(lambda: _named_status(env, "helper", "success"))
    rows = tasks_by_name(env)
    assert rows["researcher"]["status"] == "running"
    assert rows["helper"]["parent_notified_at"] is None  # not delivered yet: the parent is busy
    open_gate("researcher")
    await settle(env)
    rows = tasks_by_name(env)
    assert rows["researcher"]["status"] == "success"
    assert rows["helper"]["parent_notified_at"] is not None  # delivered by the pull
    kinds = [r["kind"] for r in env.store.runs.values() if r["task_id"] == rows["researcher"]["task_id"]]
    assert kinds == ["start"]  # no wake-up run
    assert "researcher saw helper success" in rows["researcher"]["result_preview"]


async def test_an_abandoned_pull_is_taken_back_and_the_parent_woken(env, monkeypatch):
    # The parent's pull reads the settled child (``runs.get`` marks it
    # delivered), then gives up, as on its 5 s timeout: the result never
    # reaches the parent's state. The run's end must take the delivery back
    # and wake the parent with it, not settle the parent without it.
    await turn(env, "research delegate then wait")
    await until(lambda: _named_status(env, "helper", "success"))
    original = async_subagents._aobserve

    async def read_then_give_up(client, task):
        await original(client, task)
        raise TimeoutError

    monkeypatch.setattr(async_subagents, "_aobserve", read_then_give_up)
    open_gate("researcher")
    await settle(env)
    rows = tasks_by_name(env)
    assert rows["researcher"]["status"] == "success"
    kinds = [r["kind"] for r in env.store.runs.values() if r["task_id"] == rows["researcher"]["task_id"]]
    assert kinds == ["start", "wake"]
    assert rows["helper"]["parent_notified_at"] is not None
    assert "researcher saw helper success" in rows["researcher"]["result_preview"]


async def test_a_wake_up_announces_a_second_result_it_pulls_in(env):
    # Two tasks settle together: the wake-up for one pulls the other in at
    # before_agent, and its stream marks it with the inline "finished".
    await turn(env, "research one hold")
    await turn(env, "research two hold")
    open_gate("researcher")
    await settle(env)
    rows = sorted(env.store.tasks.values(), key=lambda r: r["_seq"])
    first, second = rows
    agent = env.definition.build(config=_root_config(env))
    events = []
    async for frame in agent.astream({"messages": [await env.runner.notification_for(first)]}):
        events.extend(env.runner_mod.parse_sse_frames(frame))
    inline = [e["value"] for e in events if e.get("type") == "CUSTOM" and e.get("name") == "TASK_SETTLED_INLINE"]
    assert inline == [{"task_id": second["task_id"], "name": "researcher", "status": "success"}]


async def test_restart_errors_the_task_and_an_update_reopens_it(env):
    await turn(env, "research and wait")
    task_id = tasks_by_name(env)["researcher"]["task_id"]
    await until(lambda: _status(env, task_id, "running"))
    # The process dies: its jobs vanish, the rows still say running.
    for job in list(env.runner._jobs):
        job.cancel()
    await asyncio.gather(*list(env.runner._jobs), return_exceptions=True)
    events_mod = importlib.import_module("harness.async_tasks.events")
    fresh = env.runner_mod.TaskRunner(env.store, events_mod.TaskStreamPublisher(client=env.redis))
    env.runner_mod.set_task_runner(fresh)
    env.runner = fresh
    for row in env.store.runs.values():
        if row["task_id"] == task_id:
            row["status"] = "running"
    env.store.tasks[task_id]["status"] = "running"
    await fresh.recover()
    row = env.store.tasks[task_id]
    assert row["status"] == "error" and row["error"] == "interrupted by restart"
    outbox = await stream_entries(env, "tasks:outbox")
    assert outbox[-1]["task_id"] == task_id and outbox[-1]["status"] == "error"
    # The orchestrator's next turn learns it (the pull), and it decides to
    # continue: the same thread, reopened.
    learned = await turn(env, "any news?")
    assert "researcher error" in _text(learned[-1])
    await turn(env, "update: continue where you stopped")
    await settle(env)
    row = env.store.tasks[task_id]
    assert row["status"] == "success" and row["settled_at"] is not None and row["error"] is None
    assert "continue where you stopped" in env.store.tasks[task_id]["result"]["content"]
    # The reopen is announced (the bridge clears the old settle and its
    # "handled" mark), then the new settle, then a fresh outbox entry.
    task_events = [(e["event"], e["task"]["status"]) for e in await stream_entries(env, "tasks:status")
                   if e["task"]["task_id"] == task_id]
    reopened = task_events.index(("TASK_STATUS", "running"), task_events.index(("TASK_SETTLED", "error")))
    assert ("TASK_SETTLED", "success") in task_events[reopened:]
    outbox = await stream_entries(env, "tasks:outbox")
    assert outbox[-1]["task_id"] == task_id and outbox[-1]["status"] == "success"


async def test_an_approval_pauses_the_task_and_a_resume_finishes_it(env):
    await turn(env, "research danger zone")
    await settle(env)
    task = tasks_by_name(env)["researcher"]
    assert task["status"] == "waiting"
    # The parent reads it as interrupted, with what it asks.
    view = await sdk(env, mint(env)).threads.get(thread_id=task["task_id"])
    assert view["status"] == "interrupted"
    (interrupt,) = view["interrupts"][task["task_id"]]
    assert interrupt["value"]["action_requests"][0]["name"] == "danger"
    # The parent cannot answer it through /ap.
    with pytest.raises(httpx.HTTPStatusError):
        await sdk(env, mint(env)).runs.create(
            thread_id=task["task_id"], assistant_id=graph_id(env, "researcher"), command={"resume": "ok"})
    # Nor talk it out of the approval: a follow-up to a waiting task is refused
    # (it would drop the user's pending decision), and the task keeps waiting.
    runs_before = sum(1 for r in env.store.runs.values() if r["task_id"] == task["task_id"])
    with pytest.raises(httpx.HTTPStatusError) as refused:
        await sdk(env, mint(env)).runs.create(
            thread_id=task["task_id"], assistant_id=graph_id(env, "researcher"),
            input={"messages": [{"role": "user", "content": "just continue"}]})
    assert refused.value.response.status_code == 409
    assert "waiting for the user's approval" in refused.value.response.text
    assert env.store.tasks[task["task_id"]]["status"] == "waiting"
    assert sum(1 for r in env.store.runs.values() if r["task_id"] == task["task_id"]) == runs_before
    utils = importlib.import_module("utils.async_tasks")
    schema = importlib.import_module("schema.async_tasks")
    out = await utils.tasks_resume(task["task_id"], schema.TaskResumeIn(
        user_id=USER, decisions={interrupt["id"]: {"decision": "approve"}}))
    assert out.status == "running"
    await settle(env)
    row = env.store.tasks[task["task_id"]]
    assert row["status"] == "success"
    assert "after danger: danger done on x" in row["result_preview"]


async def test_the_watchdog_errors_a_run_that_runs_too_long(env):
    env.settings.async_tasks.run_timeout_seconds = 0.5
    await turn(env, "research and wait")
    await settle(env)
    task = tasks_by_name(env)["researcher"]
    assert task["status"] == "error"
    run = next(r for r in env.store.runs.values() if r["task_id"] == task["task_id"])
    assert run["status"] == "timeout"


async def test_cancel_scope_stops_a_conversations_tasks(env):
    await turn(env, "research and wait")
    await until(lambda: _named_status(env, "researcher", "running"))
    utils = importlib.import_module("utils.async_tasks")
    schema = importlib.import_module("schema.async_tasks")
    out = await utils.tasks_cancel_scope(schema.TaskCancelScopeIn(user_id=USER, conversation_id=CONVERSATION))
    assert out.cancelled == 1
    await settle(env)
    assert tasks_by_name(env)["researcher"]["status"] == "cancelled"
    assert await stream_entries(env, "tasks:outbox") == []


async def test_the_internal_api_routes(env, client, internal_headers):
    await turn(env, "research apples and wait")
    open_gate("researcher")
    await settle(env)
    task_id = tasks_by_name(env)["researcher"]["task_id"]
    got = await client.get(f"/tasks/{task_id}", params={"user_id": USER}, headers=internal_headers)
    assert got.status_code == 200 and got.json()["status"] == "success"
    assert got.json()["spawned_by_message_id"] == got.json()["root_run_id"]
    assert (await client.get(f"/tasks/{task_id}", params={"user_id": "u-2"}, headers=internal_headers)).status_code == 404
    assert (await client.get(f"/tasks/{task_id}", params={"user_id": USER})).status_code == 403
    listed = await client.get("/tasks", params={"user_id": USER, "conversation_id": CONVERSATION}, headers=internal_headers)
    assert [t["task_id"] for t in listed.json()] == [task_id]
    unnotified = await client.get("/tasks/unnotified", params={"limit": 10}, headers=internal_headers)
    assert [t["task_id"] for t in unnotified.json()] == [task_id]
    marked = await client.post(f"/tasks/{task_id}/notified", json={"user_id": USER}, headers=internal_headers)
    assert marked.status_code == 204
    assert (await client.get("/tasks/unnotified", headers=internal_headers)).json() == []


async def test_the_in_process_middleware_keeps_upstreams_tools(env):
    from_upstream = AsyncSubAgentMiddleware(async_subagents=[{"name": "r", "description": "d", "graph_id": "g", "url": "http://x"}])
    ours = env.client.AsyncTaskMiddleware(async_subagents=[{"name": "r", "description": "d", "graph_id": "g", "url": "http://x"}])
    assert [t.name for t in ours.tools] == [t.name for t in from_upstream.tools]
    assert [t.description for t in ours.tools] == [t.description for t in from_upstream.tools]
    # Its clients never leave the process.
    client = ours._clients.get_async("r")
    assert isinstance(client.http.client._transport, httpx.ASGITransport)
    with pytest.raises(ValueError):
        ours._clients.get_sync("r")


def test_a_task_records_the_model_its_calls_went_to(agents_service):
    # The task's model (its record, and the price of its usage in the bridge)
    # comes from the calls' own usage events, not from the built model object.
    runner_mod = importlib.import_module("harness.async_tasks.runner")
    usage = runner_mod._Usage()
    usage.observe({"type": "CUSTOM", "name": "TOKEN_USAGE",
                   "value": {"model": "gpt-6-luna", "input_tokens": 10, "output_tokens": 2}})
    usage.observe({"type": "CUSTOM", "name": "TOKEN_USAGE",
                   "value": {"model": "other", "input_tokens": 5, "output_tokens": 1}})
    assert usage.model == "gpt-6-luna"
    assert usage.totals["input_tokens"] == 15 and usage.totals["calls"] == 2

    # The task's own automatic compaction is its spend too (a blocking
    # sub-agent's was booked the same way).
    compaction = runner_mod._Usage()
    compaction.observe({"type": "CUSTOM", "name": "TOKEN_USAGE",
                        "value": {"model": "gpt-6-luna", "purpose": "compaction", "input_tokens": 9}})
    assert compaction.totals["input_tokens"] == 9 and compaction.totals["calls"] == 1
