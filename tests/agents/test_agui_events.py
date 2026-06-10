import pytest
from pydantic import ValidationError


# ----------------------------------------------------------------------
# Event type constants
# ----------------------------------------------------------------------
def test_event_type_constants(agents_service):
    ev = agents_service.agui_events
    assert ev.HITL_INTERRUPT_EVENT_TYPE == "HITL_INTERRUPT"
    assert ev.PLAN_SNAPSHOT_EVENT_TYPE == "PLAN_SNAPSHOT"
    assert ev.TASK_SUBAGENT_EVENT_TYPE == "TASK_SUBAGENT"
    assert ev.SUBAGENT_EVENT_TYPE == "SUBAGENT_EVENT"
    assert ev.BEFORE_AGENT_EVENT_TYPE == "BEFORE_AGENT_EVENT"


# ----------------------------------------------------------------------
# HITLInterruptEvent
# ----------------------------------------------------------------------
def test_hitl_interrupt_event_full(agents_service):
    ev = agents_service.agui_events
    model = ev.HITLInterruptEvent(
        thread_id="thread-1",
        interrupt={"value": "needs approval"},
        metadata={"source": "node-a"},
    )
    dumped = model.model_dump()
    assert dumped == {
        "thread_id": "thread-1",
        "interrupt": {"value": "needs approval"},
        "metadata": {"source": "node-a"},
    }


def test_hitl_interrupt_event_metadata_defaults_none(agents_service):
    ev = agents_service.agui_events
    model = ev.HITLInterruptEvent(thread_id="t", interrupt="raw-interrupt")
    dumped = model.model_dump()
    assert dumped["thread_id"] == "t"
    assert dumped["interrupt"] == "raw-interrupt"
    assert dumped["metadata"] is None


def test_hitl_interrupt_event_interrupt_accepts_any(agents_service):
    ev = agents_service.agui_events
    model = ev.HITLInterruptEvent(thread_id="t", interrupt=[1, 2, 3])
    assert model.interrupt == [1, 2, 3]


def test_hitl_interrupt_event_requires_thread_id(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.HITLInterruptEvent(interrupt="x")


def test_hitl_interrupt_event_requires_interrupt(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.HITLInterruptEvent(thread_id="t")


# ----------------------------------------------------------------------
# PlanItem + PlanSnapshot
# ----------------------------------------------------------------------
def test_plan_item_full(agents_service):
    ev = agents_service.agui_events
    item = ev.PlanItem(content="do thing", status="in_progress", metadata={"x": 1})
    dumped = item.model_dump()
    assert dumped == {
        "content": "do thing",
        "status": "in_progress",
        "metadata": {"x": 1},
    }


def test_plan_item_metadata_defaults_none(agents_service):
    ev = agents_service.agui_events
    item = ev.PlanItem(content="step", status="pending")
    assert item.model_dump()["metadata"] is None


@pytest.mark.parametrize("status", ["pending", "in_progress", "completed"])
def test_plan_item_valid_statuses(agents_service, status):
    ev = agents_service.agui_events
    item = ev.PlanItem(content="c", status=status)
    assert item.status == status


def test_plan_item_invalid_status_rejected(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.PlanItem(content="c", status="done")


def test_plan_item_requires_content(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.PlanItem(status="pending")


def test_plan_snapshot_full(agents_service):
    ev = agents_service.agui_events
    snapshot = ev.PlanSnapshot(
        items=[
            ev.PlanItem(content="a", status="pending"),
            ev.PlanItem(content="b", status="completed", metadata={"k": "v"}),
        ],
        updated_at=123456,
        metadata={"plan": "main"},
    )
    dumped = snapshot.model_dump()
    assert dumped["updated_at"] == 123456
    assert dumped["metadata"] == {"plan": "main"}
    assert len(dumped["items"]) == 2
    assert dumped["items"][0] == {"content": "a", "status": "pending", "metadata": None}
    assert dumped["items"][1] == {"content": "b", "status": "completed", "metadata": {"k": "v"}}


def test_plan_snapshot_optional_fields_default_none(agents_service):
    ev = agents_service.agui_events
    snapshot = ev.PlanSnapshot(items=[])
    dumped = snapshot.model_dump()
    assert dumped["items"] == []
    assert dumped["updated_at"] is None
    assert dumped["metadata"] is None


def test_plan_snapshot_coerces_dict_items(agents_service):
    ev = agents_service.agui_events
    snapshot = ev.PlanSnapshot(items=[{"content": "c", "status": "in_progress"}])
    assert isinstance(snapshot.items[0], ev.PlanItem)
    assert snapshot.items[0].content == "c"


def test_plan_snapshot_requires_items(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.PlanSnapshot()


# ----------------------------------------------------------------------
# TaskSubAgentEvent
# ----------------------------------------------------------------------
def test_task_subagent_event_full(agents_service):
    ev = agents_service.agui_events
    model = ev.TaskSubAgentEvent(
        task_id="task-1",
        subagent_type="researcher",
        description="dig into the docs",
    )
    assert model.model_dump() == {
        "task_id": "task-1",
        "subagent_type": "researcher",
        "description": "dig into the docs",
    }


@pytest.mark.parametrize("missing", ["task_id", "subagent_type", "description"])
def test_task_subagent_event_required_fields(agents_service, missing):
    ev = agents_service.agui_events
    kwargs = {"task_id": "t", "subagent_type": "s", "description": "d"}
    kwargs.pop(missing)
    with pytest.raises(ValidationError):
        ev.TaskSubAgentEvent(**kwargs)


# ----------------------------------------------------------------------
# SubAgentEvent
# ----------------------------------------------------------------------
def test_subagent_event_full(agents_service):
    ev = agents_service.agui_events
    model = ev.SubAgentEvent(
        task_id="task-9",
        namespace=["root", "child"],
        event={"type": "TEXT_MESSAGE_CHUNK", "delta": "hi"},
    )
    assert model.model_dump() == {
        "task_id": "task-9",
        "namespace": ["root", "child"],
        "event": {"type": "TEXT_MESSAGE_CHUNK", "delta": "hi"},
    }


@pytest.mark.parametrize("missing", ["task_id", "namespace", "event"])
def test_subagent_event_required_fields(agents_service, missing):
    ev = agents_service.agui_events
    kwargs = {"task_id": "t", "namespace": ["a"], "event": {"k": "v"}}
    kwargs.pop(missing)
    with pytest.raises(ValidationError):
        ev.SubAgentEvent(**kwargs)


def test_subagent_event_namespace_must_be_list(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.SubAgentEvent(task_id="t", namespace="not-a-list-but-required-list", event={})


# ----------------------------------------------------------------------
# BeforeAgentEvent
# ----------------------------------------------------------------------
def test_before_agent_event_full(agents_service):
    ev = agents_service.agui_events
    model = ev.BeforeAgentEvent(message="delegated work", metadata={"caller": "x"})
    assert model.model_dump() == {
        "message": "delegated work",
        "metadata": {"caller": "x"},
    }


def test_before_agent_event_metadata_defaults_none(agents_service):
    ev = agents_service.agui_events
    model = ev.BeforeAgentEvent(message="m")
    assert model.model_dump() == {"message": "m", "metadata": None}


def test_before_agent_event_requires_message(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.BeforeAgentEvent(metadata={})
