"""The Usage tab's five pages (plan 33): Overview, conversations, one
conversation, agents, one agent.

Pinned:

* the Overview's new totals and coverage fields, the model ranking, the
  previous-week window and the drill-in counts;
* the conversation list ranks by running totals, pages by keyset without
  repeating or skipping, never lists a private chat (it comes back as one
  aggregate), searches titles only, and rejects a forged cursor;
* one conversation counts replaced answers (off the latest branch), splits main
  agent and sub-agents, counts pre-plan-33 answers' calls from their event log,
  and is a 404 for a private chat or another user's;
* agents are entities — platform, custom (own only), deleted — with the
  sub-agents and models they really used; another user's custom agent never
  appears and its profile is a 404; a deleted agent is reachable by name;
* the Overview and Agents pages read the daily rollups (filled here through
  the same writer _finish_run uses), not the answers.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from core.database import AgentTable, ConversationTable, MessageTable, MessageUsageTable, UserTable
from utils.usage_rollups import add_answer_to_rollups


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def _fill_rollups(session) -> None:
    """Add every seeded answer to the daily rollups exactly as _finish_run does."""
    groups = defaultdict(list)
    for row in (await session.execute(select(MessageUsageTable))).scalars():
        groups[row.message_id].append({
            "scope": row.scope, "group_name": row.agent_name, "model_name": row.model_name or "",
            "calls": row.calls, "input_tokens": row.input_tokens, "cached_input_tokens": row.cached_input_tokens,
            "output_tokens": row.output_tokens, "reasoning_tokens": row.reasoning_tokens,
            "model_ms": row.model_latency_ms,
        })
    answers = (await session.execute(
        select(MessageTable, ConversationTable.user_id)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(MessageTable.sender == "ai")
    )).all()
    for message, user_id in answers:
        detailed = message.model_calls is not None
        await add_answer_to_rollups(
            session, user_id=user_id, day=message.created_at.date(), agent_id=message.agent_id,
            agent_name=message.agent_name, groups=groups[message.id],
            answer={
                "answers": 1, "input_tokens": message.input_tokens or 0,
                "cached_input_tokens": message.cached_input_tokens or 0,
                "output_tokens": message.output_tokens or 0, "reasoning_tokens": message.reasoning_tokens or 0,
                "model_ms": message.model_latency_ms or 0, "model_calls": message.model_calls or 0,
                "tool_calls": message.tool_calls or 0, "detailed_answers": int(detailed),
                "detailed_input_tokens": (message.input_tokens or 0) if detailed else 0,
            },
        )


def _usage_event(mid: str) -> dict:
    return {"type": "CUSTOM", "name": "TOKEN_USAGE", "value": {"message_id": mid, "input_tokens": 1}}


@pytest.fixture
def seed(session_factory, seeded_user, seeded_agent):
    """Write conversations, answers, usage rows and running totals directly."""

    async def build():
        now = _now()
        async with session_factory() as session:
            custom = AgentTable(slug="pricing", name="Pricing analyst", description="d", icon="chart",
                                is_active=True, owner_user_id=seeded_user.id, type="deep agent")
            other_user = UserTable(username="someone-else", oidc_subject="oid-someone-else", is_active=True)
            session.add_all([custom, other_user])
            await session.flush()
            foreign = AgentTable(slug="theirs", name="Their agent", description="d", icon="bot",
                                 is_active=True, owner_user_id=other_user.id)
            session.add(foreign)
            await session.flush()

            def conversation(title, agent, *, private=False, user=seeded_user):
                conv = ConversationTable(user_id=user.id, agent_id=agent.id, agent_name=agent.name,
                                         title=title, is_private=private)
                session.add(conv)
                return conv

            big = conversation("Q3 planning deck", seeded_agent)
            small = conversation("Pricing research", custom)
            mid = conversation("Weekly notes", seeded_agent)
            secret = conversation("Secret plans", seeded_agent, private=True)
            theirs = conversation("Not yours", foreign, user=other_user)
            await session.flush()

            def answer(conv, agent_id, agent_name, parent, *, inp, out, at, detailed=True, events=None, **extra):
                msg = MessageTable(
                    conversation_id=conv.id, sender="ai", content="a", parent_message_id=parent,
                    agent_id=agent_id, agent_name=agent_name, input_tokens=inp, output_tokens=out,
                    created_at=at, updated_at=at, is_error=False,
                    model_calls=extra.pop("calls", 2) if detailed else None,
                    tool_calls=extra.pop("tools", 1) if detailed else None,
                    model_latency_ms=extra.pop("ms", 1_000) if detailed else None,
                    raw_events=events, **extra,
                )
                session.add(msg)
                return msg

            def question(conv, parent, at):
                msg = MessageTable(conversation_id=conv.id, sender="user", content="q",
                                   parent_message_id=parent, created_at=at, updated_at=at,
                                   is_error=False)
                session.add(msg)
                return msg

            # The big conversation: an old answer (no call counts), then a
            # question with an answer that was retried — the first try is replaced.
            q1 = question(big, None, now - timedelta(days=3))
            await session.flush()
            old = answer(big, seeded_agent.id, seeded_agent.name, q1.id, inp=50_000, out=500,
                         at=now - timedelta(days=3, seconds=-1), detailed=False,
                         events=[_usage_event("c1"), _usage_event("c2"), _usage_event("c3"),
                                 {"type": "TOOL_CALL_START", "toolCallId": "t1"}])
            await session.flush()
            q2 = question(big, old.id, now - timedelta(days=1))
            await session.flush()
            replaced = answer(big, seeded_agent.id, seeded_agent.name, q2.id, inp=100_000, out=900,
                              at=now - timedelta(days=1, seconds=-1), cached_input_tokens=60_000)
            kept = answer(big, seeded_agent.id, seeded_agent.name, q2.id, inp=150_000, out=1_100,
                          at=now - timedelta(hours=2), cached_input_tokens=120_000,
                          context_tokens=200_000, context_window=272_000, compaction_percent=92.0,
                          model_name="gpt-5")
            answer(small, custom.id, custom.name, None, inp=20_000, out=200, at=now - timedelta(hours=5))
            answer(mid, seeded_agent.id, seeded_agent.name, None, inp=60_000, out=600, at=now - timedelta(hours=1))
            answer(secret, seeded_agent.id, seeded_agent.name, None, inp=9_000, out=90, at=now - timedelta(hours=1))
            # An answer from an agent that has since been deleted (agent_id NULL).
            answer(mid, None, "Old drafter", None, inp=4_000, out=40, at=now - timedelta(hours=1))
            answer(theirs, foreign.id, foreign.name, None, inp=7_000, out=70, at=now - timedelta(hours=1))
            # Someone else's custom agent, run by OUR user once (before the ownership fix).
            answer(small, foreign.id, foreign.name, None, inp=1_000, out=10, at=now - timedelta(hours=1))
            await session.flush()

            for msg, groups in (
                (replaced, [("main", seeded_agent.name, "gpt-5", 1, 100_000)]),
                (kept, [("main", seeded_agent.name, "gpt-5", 2, 120_000),
                        ("subagent", "researcher", "gpt-4.1", 3, 30_000)]),
            ):
                for scope, name, model, calls, inp in groups:
                    session.add(MessageUsageTable(
                        message_id=msg.id, conversation_id=big.id, user_id=seeded_user.id,
                        agent_id=seeded_agent.id, main_agent_name=seeded_agent.name, scope=scope,
                        agent_name=name, model_name=model, calls=calls, input_tokens=inp,
                        cached_input_tokens=0, output_tokens=100, reasoning_tokens=0,
                        model_latency_ms=500, created_at=msg.created_at,
                    ))

            def totals(conv, answers, total, ctx=None, window=None, updated=now):
                conv.usage_answers = answers
                conv.usage_total_tokens = total
                conv.usage_input_tokens = total
                conv.last_context_tokens, conv.last_context_window = ctx, window
                conv.usage_updated_at = updated

            totals(big, 3, 302_500, 200_000, 272_000, now - timedelta(hours=2))
            totals(small, 2, 21_210, None, None, now - timedelta(hours=1))
            totals(mid, 2, 64_640, 30_000, 272_000, now - timedelta(minutes=30))
            totals(secret, 1, 9_090, None, None, now - timedelta(hours=1))
            totals(theirs, 1, 7_070, None, None, now - timedelta(hours=1))
            await session.flush()
            await _fill_rollups(session)
            await session.commit()
            return {"big": big.id, "small": small.id, "mid": mid.id, "secret": secret.id,
                    "theirs": theirs.id, "custom": custom.id, "foreign": foreign.id,
                    "replaced": replaced.id, "kept": kept.id, "old": old.id}

    return build


def _base(user) -> str:
    return f"/v1/usage/{user.id}"


async def test_the_overview_carries_coverage_models_and_drill_counts(client, seeded_user, seed):
    await seed()
    response = await client.get(f"{_base(seeded_user)}/summary")
    assert response.status_code == 200
    body = response.json()

    totals = body["totals"]
    assert totals["detailedAnswers"] == 7          # every seeded answer but the old one
    assert totals["cachedInputTokens"] == 180_000
    assert totals["modelCalls"] == 14 and totals["toolCalls"] == 7
    assert [m["model"] for m in body["perModel"]] == ["gpt-5", "gpt-4.1"]
    assert body["perModel"][0]["calls"] == 3
    assert body["nearCompactionCount"] == 1        # 200K of 272K
    assert body["agentCount"] == 4                 # test agent, custom, deleted, foreign
    assert "previous7Days" in body and body["daily"]


async def test_the_conversation_list_ranks_pages_and_hides_private_chats(client, seeded_user, seed):
    ids = await seed()
    base = f"{_base(seeded_user)}/conversations"

    first = (await client.get(base, params={"limit": 2})).json()
    assert [row["id"] for row in first["items"]] == [ids["big"], ids["mid"]]
    assert first["private"] == {"conversations": 1, "answers": 1, "totalTokens": 9_090}
    assert first["nextCursor"]

    second = (await client.get(base, params={"limit": 2, "cursor": first["nextCursor"]})).json()
    assert [row["id"] for row in second["items"]] == [ids["small"]]
    assert second["nextCursor"] is None and second["private"] is None

    recent = (await client.get(base, params={"sort": "recent"})).json()
    assert [row["id"] for row in recent["items"]] == [ids["mid"], ids["small"], ids["big"]]
    by_fill = (await client.get(base, params={"sort": "context"})).json()
    assert [row["id"] for row in by_fill["items"]] == [ids["big"], ids["mid"]]

    found = (await client.get(base, params={"q": "pricing"})).json()
    assert [row["id"] for row in found["items"]] == [ids["small"]] and found["private"] is None
    assert (await client.get(base, params={"q": "100%_"})).json()["items"] == []

    forged = await client.get(base, params={"cursor": "eyJzIjoicmVjZW50In0"})
    assert forged.status_code == 400
    assert (await client.get(base, params={"limit": 51})).status_code == 422


async def test_one_conversation_splits_agents_counts_replaced_and_old_answers(client, seeded_user, seed):
    ids = await seed()
    body = (await client.get(f"{_base(seeded_user)}/conversations/{ids['big']}")).json()

    assert body["answers"] == 3 and body["replaced"] == 1
    assert body["totalTokens"] == 302_500
    # The old answer's calls come from its event log: 3 model calls, 1 tool call.
    assert body["modelCalls"] == 2 + 2 + 3 and body["toolCalls"] == 1 + 1 + 1
    assert body["callsComplete"] is True
    assert body["detailedAnswers"] == 2
    assert {(g["scope"], g["agentName"], g["model"], g["calls"]) for g in body["groups"]} == {
        ("main", "Test Agent", "gpt-5", 3),
        ("subagent", "researcher", "gpt-4.1", 3),
    }
    assert [point["id"] for point in body["branch"]] == [ids["old"], ids["kept"]]
    assert body["branch"][1]["contextTokens"] == 200_000

    assert (await client.get(f"{_base(seeded_user)}/conversations/{ids['secret']}")).status_code == 404
    assert (await client.get(f"{_base(seeded_user)}/conversations/{ids['theirs']}")).status_code == 404


async def test_agents_are_entities_and_never_someone_elses(client, seeded_user, seeded_agent, seed):
    ids = await seed()
    body = (await client.get(f"{_base(seeded_user)}/agents", params={"range": "all"})).json()
    by_name = {item["name"]: item for item in body["items"]}

    assert set(by_name) == {"Test Agent", "Pricing analyst", "Old drafter"}
    assert by_name["Test Agent"]["kind"] == "platform"
    assert by_name["Test Agent"]["subagents"] == ["researcher"]
    assert by_name["Test Agent"]["models"] == ["gpt-4.1", "gpt-5"]
    assert by_name["Pricing analyst"]["kind"] == "custom" and by_name["Pricing analyst"]["engine"] == "deep agent"
    assert by_name["Old drafter"]["kind"] == "deleted" and by_name["Old drafter"]["key"] == "name:Old drafter"

    custom_only = (await client.get(f"{_base(seeded_user)}/agents", params={"kind": "custom", "range": "all"})).json()
    assert [item["name"] for item in custom_only["items"]] == ["Pricing analyst"]

    profile = (await client.get(f"{_base(seeded_user)}/agents/{seeded_agent.id}", params={"range": "all"})).json()
    assert profile["agent"]["answers"] == 5
    assert [c["id"] for c in profile["topConversations"]] == [ids["big"], ids["mid"]]   # never the private one
    assert {g["agentName"] for g in profile["groups"]} == {"Test Agent", "researcher"}

    deleted = await client.get(f"{_base(seeded_user)}/agents/name:Old drafter")
    assert deleted.status_code == 200 and deleted.json()["agent"]["kind"] == "deleted"

    assert (await client.get(f"{_base(seeded_user)}/agents/{ids['foreign']}")).status_code == 404
    assert (await client.get(f"{_base(seeded_user)}/agents/name:Never existed")).status_code == 404
    assert (await client.get(f"{_base(seeded_user)}/agents/bad%0Akey")).status_code == 400   # a control character
