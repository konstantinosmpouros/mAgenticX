from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi_pagination import add_pagination
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import AgentTable, Base, engine
from utils import sync_agents_with_service

from apis import (
    auth_router,
    inference_router,
    utils_router,
    conversations_router,
    messages_router,
    attachments_router
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize database schema
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield


app = FastAPI(title="Bridge Service", lifespan=lifespan)
add_pagination(app)

app.include_router(auth_router)
app.include_router(inference_router)
app.include_router(utils_router)
app.include_router(conversations_router)
app.include_router(messages_router)
app.include_router(attachments_router)
