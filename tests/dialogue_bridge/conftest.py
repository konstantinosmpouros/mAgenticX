from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from fastapi_pagination import add_pagination
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


ROOT = Path(__file__).resolve().parents[2]
SERVICE_ROOT = ROOT / "src" / "dialogue_bridge"

if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{(ROOT / '.pytest-bootstrap-dialogue-bridge.db').as_posix()}")
os.environ.setdefault("SESSION_TOKEN_SECRET", "test-session-token-secret")
os.environ.setdefault("SESSION_COOKIE_SECURE", "false")
os.environ.setdefault("TRUSTED_PROXY_SECRET", "test-trusted-proxy-secret")
os.environ.setdefault("AGENTS_SERVICE_URL", "http://agents.test")

from main import app as bridge_app  # noqa: E402
from core.auth_session import require_csrf_protection  # noqa: E402
from core.database import (  # noqa: E402
    AgentTable,
    Base,
    ConversationReportTable,
    ConversationTable,
    MessageTable,
    UserTable,
    get_db,
)
from utils.validators import validate_userId  # noqa: E402


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest_asyncio.fixture
async def db_engine(tmp_path):
    db_path = tmp_path / "dialogue_bridge_test.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path.as_posix()}", future=True)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    try:
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
def session_factory(db_engine):
    return async_sessionmaker(bind=db_engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def seeded_user(session_factory):
    async with session_factory() as session:
        user = UserTable(
            username="dialogue-test-user",
            vault_user_id="vault-dialogue-test-user",
            is_active=True,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


@pytest_asyncio.fixture
async def seeded_agent(session_factory):
    async with session_factory() as session:
        agent = AgentTable(
            slug="test-agent",
            name="Test Agent",
            description="Agent used for dialogue bridge API tests",
            icon="bot",
            is_active=True,
        )
        session.add(agent)
        await session.commit()
        await session.refresh(agent)
        return agent


@pytest.fixture
def app(session_factory, seeded_user):
    add_pagination(bridge_app)

    async def override_get_db():
        async with session_factory() as session:
            yield session

    async def override_validate_user_id(user_id: str):
        return seeded_user

    async def override_csrf_protection():
        return None

    bridge_app.dependency_overrides[get_db] = override_get_db
    bridge_app.dependency_overrides[validate_userId] = override_validate_user_id
    bridge_app.dependency_overrides[require_csrf_protection] = override_csrf_protection

    try:
        yield bridge_app
    finally:
        bridge_app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        yield async_client


@pytest.fixture
def conversation_factory(session_factory, seeded_user, seeded_agent):
    async def create_conversation(
        *,
        title: str,
        is_archived: bool = False,
        is_reported: bool = False,
        messages: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        async with session_factory() as session:
            conversation = ConversationTable(
                user_id=seeded_user.id,
                agent_id=seeded_agent.id,
                agent_name=seeded_agent.name,
                title=title,
                is_private=False,
                is_archived=is_archived,
                archived_at=utcnow() if is_archived else None,
                is_reported=is_reported,
                reported_at=utcnow() if is_reported else None,
                last_message_preview=(messages[-1]["content"] if messages else ""),
            )
            session.add(conversation)
            await session.flush()

            created_messages: list[MessageTable] = []
            for payload in messages or []:
                message = MessageTable(
                    conversation_id=conversation.id,
                    sender=payload.get("sender", "user"),
                    type=payload.get("type", "text"),
                    content=payload.get("content"),
                    parent_message_id=payload.get("parent_message_id"),
                )
                session.add(message)
                created_messages.append(message)

            await session.commit()

            return {
                "conversation_id": conversation.id,
                "message_ids": [message.id for message in created_messages],
            }

    return create_conversation


@pytest.fixture
def db_session_factory(session_factory):
    return session_factory


__all__ = [
    "ConversationReportTable",
]
