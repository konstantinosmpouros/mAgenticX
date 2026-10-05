from __future__ import annotations

import base64
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from fastapi_pagination import add_pagination
from httpx import ASGITransport, AsyncClient
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def _sqlite_encode(data: bytes, encoding: str) -> str:
    if encoding == "base64":
        return base64.b64encode(data).decode("ascii").replace("\n", "")
    raise ValueError(f"Unsupported encoding: {encoding}")


ROOT = Path(__file__).resolve().parents[2]
SERVICE_ROOT = ROOT / "magenticx" / "dialogue_bridge"

if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

os.environ.setdefault("APP_ENV", "test")
# Session tokens are signed by the real code path's file backend with a real RSA
# key — no fake signer — so mint + verify run exactly as they do in the bridge.
# Generated fresh per test session into the temp dir; `core.settings` reads it
# at import, so this must run before anything imports the app.
_SIGNING_KEY_PATH = Path(tempfile.mkdtemp(prefix="bridge-signing-")) / "session_signing_key.pem"
_SIGNING_KEY_PATH.write_bytes(
    rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
)
os.environ.setdefault("SESSION_SIGNING_BACKEND", "file")
os.environ.setdefault("SESSION_SIGNING_PRIVATE_KEY_FILE", str(_SIGNING_KEY_PATH))
# Microsoft Entra is the only way in, and settings refuse to boot without it.
# Never contacted: the `sso_login` fixture stubs Microsoft's half of the flow.
os.environ.setdefault("ENTRA_TENANT_ID", "00000000-0000-0000-0000-00000000e0e0")
os.environ.setdefault("ENTRA_CLIENT_ID", "00000000-0000-0000-0000-00000000c1c1")
os.environ.setdefault("ENTRA_CLIENT_SECRET", "test-entra-client-secret")
# A placeholder so `core.settings` can load at import time — never connected to.
# Every test gets its own engine from the `db_engine` fixture below. Kept in the
# temp dir because sqlalchemy/aiosqlite touches the file into existence, and the
# repo root is not a scratch space (it was landing there untracked and un-ignored).
os.environ.setdefault(
    "DATABASE_URL",
    f"sqlite+aiosqlite:///{(Path(tempfile.gettempdir()) / 'pytest-bootstrap-dialogue-bridge.db').as_posix()}",
)
os.environ.setdefault("SESSION_TOKEN_SECRET", "test-session-token-secret")
os.environ.setdefault("SESSION_COOKIE_SECURE", "false")
os.environ.setdefault("TRUSTED_PROXY_SECRET", "test-trusted-proxy-secret")
os.environ.setdefault("AGENTS_SERVICE_URL", "http://agents.test")
# Rate limits run FOR REAL against the fakeredis pool seeded below — every
# suite request shares one identity bucket, so the ceilings must be generous
# or a full run would trip 429s mid-suite. 429 semantics themselves are
# verified against the live stack, not here.
os.environ.setdefault("USER_RATE_LIMIT_MAX_CALLS", "1000000")
os.environ.setdefault("AUTH_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("INFERENCE_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("SPEECH_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("VOICE_SESSION_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("EXPORT_PDF_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("SHARE_CREATE_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("SKILL_UPLOAD_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("MESSAGE_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("SUGGESTIONS_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("REFRESH_RATE_LIMIT_MAX_ATTEMPTS", "1000000")
os.environ.setdefault("WS_CONNECT_RATE_LIMIT_MAX_ATTEMPTS", "1000000")

from main import app as bridge_app

# The fastapi-redis-sdk pool is normally created by the app lifespan, which
# these tests never run (they drive the ASGI app directly). Seed the SDK's
# pool state with an in-process fakeredis client so the global rate-limit
# middleware and per-route rate_limit dependencies execute their real code
# path — get_async_client demands both the pool and a client bound to it.
from fakeredis import aioredis as _fake_aioredis
from redis_fastapi.deps import _PoolState

_sdk_fake_redis = _fake_aioredis.FakeRedis(decode_responses=True)
_sdk_pool_state = _PoolState()
_sdk_pool_state.async_pool = _sdk_fake_redis.connection_pool
_sdk_pool_state._async_client = _sdk_fake_redis
bridge_app.state._redis = _sdk_pool_state
import router.auth as auth_router_module
from core.auth.providers import AuthIdentity
from core.auth.session import require_csrf_protection
from core.database import (
    AgentTable,
    Base,
    ConversationReportTable,
    ConversationTable,
    MessageTable,
    UserTable,
    get_db,
)
from utils.validators import validate_userId, validate_userId_even_if_pending


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest_asyncio.fixture
async def db_engine(tmp_path):
    db_path = tmp_path / "dialogue_bridge_test.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path.as_posix()}", future=True)

    @event.listens_for(engine.sync_engine, "connect")
    def register_sqlite_functions(dbapi_connection, _connection_record):
        dbapi_connection.create_function("encode", 2, _sqlite_encode)

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
            oidc_subject="oid-dialogue-test-user",
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
    bridge_app.dependency_overrides[validate_userId_even_if_pending] = override_validate_user_id
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
def sso_login(client, monkeypatch):
    """Sign the test client in the only way production can: the Entra callback.

    Only Microsoft's half is stubbed — ``complete_login`` returns a fixed
    identity instead of redeeming a code — so everything the bridge owns runs for
    real: resolve-by-oid, the active/conflict checks, ``finalize_login``, the
    session cookies, the device cookie and the refresh guard. ``park=True`` is
    "add another account", which production carries across the redirect via
    ``consume_park_intent``.

    Returns the callback response: a 302 to ``/`` on success, or to
    ``/login?sso=<reason>`` when the sign-in is refused.
    """

    async def login(
        username: str,
        *,
        subject: str | None = None,
        email: str | None = None,
        park: bool = False,
        reauth_for: str | None = None,
    ):
        identity = AuthIdentity(
            subject=subject or f"oid::{username}",
            username=username,
            provider="entra",
            email=email,
            claims={"name": username.title()},
        )

        async def complete_login(_auth_response):
            return identity

        async def consume_park_intent(_state):
            return park

        async def consume_reauth_intent(_state):
            # A re-authentication (plan 32) started for this user id.
            return reauth_for

        monkeypatch.setattr(auth_router_module, "complete_login", complete_login)
        monkeypatch.setattr(auth_router_module, "consume_park_intent", consume_park_intent)
        monkeypatch.setattr(auth_router_module, "consume_reauth_intent", consume_reauth_intent)
        return await client.get("/v1/auth/oidc/callback", params={"state": "test-state", "code": "test-code"})

    return login


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
