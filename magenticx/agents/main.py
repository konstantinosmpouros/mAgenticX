# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))


import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from harness.async_tasks.client import set_protocol_app
from harness.async_tasks.events import TaskStreamPublisher
from harness.async_tasks.runner import TaskRunner, set_task_runner
from harness.async_tasks.store import AsyncTaskStore
from harness.checkpointer import init_durable_checkpointer
from core.settings import settings
from core.logging import (
    RequestLoggingMiddleware,
    configure_logging,
    get_logger,
    register_exception_handlers,
    shutdown_logging,
)
from harness.skill_registry import run_remote_skill_sync_loop
from harness.abstractions import seed_global_agents
from utils.agents import refresh_registry
from router.account import router as account_router
from router.agent_protocol import router as agent_protocol_router
from router.catalog import router as catalog_router
from router.commands import router as commands_router
from router.conversation_files import router as conversation_files_router
from router.embeddings import router as embeddings_router
from router.export import router as export_router
from router.generation import router as generation_router
from router.inference import router as inference_router
from router.memories import router as memories_router
from router.skills import router as skills_router
from router.tasks import router as tasks_router
from router.agent_tools import router as agent_tools_router
from router.user_agents import router as user_agents_router
from router.voice import router as voice_router
from router.workflows import router as workflows_router


configure_logging()
logger = get_logger(__name__)


def _make_loop_exception_handler(old_handler=None):
    def handler(loop, context):
        ex = context.get("exception")
        # Silently ignore common disconnect/cancel noise
        if isinstance(ex, (asyncio.CancelledError, BrokenPipeError, ConnectionResetError)):
            return
        # Suppress LangGraph uvloop callback noise on cancellation
        handle = context.get("handle") or context.get("task")
        msg = context.get("message", "")
        text = f"{msg} {handle!r}"
        if isinstance(ex, TypeError) and "NoneType" in str(ex) and "langgraph" in text:
            return
        logger.error(
            "event_loop_exception",
            "Unhandled event loop exception",
            exc_info=bool(ex),
            exception_type=type(ex).__name__ if ex is not None else None,
            loop_message=msg or None,
        )
        if old_handler is not None:
            try:
                old_handler(loop, context)
                return
            except Exception:
                pass
        loop.default_exception_handler(context)
    return handler


@asynccontextmanager
async def _lifespan(app: FastAPI):
    loop = asyncio.get_event_loop()
    old = loop.get_exception_handler()
    loop.set_exception_handler(_make_loop_exception_handler(old))
    pool = None
    remote_sync_task: asyncio.Task | None = None
    task_runner: TaskRunner | None = None
    try:
        logger.info("service_startup", "Agents service startup initiated")
        # Seed built-in declarative (YAML) agents into the global volume, then
        # re-scan so they join AGENT_REGISTRY (invisible at import, before seed).
        seed_global_agents()
        refresh_registry()
        # Durable checkpointer — fail fast and loud if agent_runtime is
        # unreachable; cross-turn resume depends on it.
        await init_durable_checkpointer(app)
        pool = app.state.checkpointer_pool
        # Background tasks (plan 41). The tables always exist (conversation
        # delete and account purge reap them); the runner only with the flag.
        task_store = AsyncTaskStore(pool)
        if settings.checkpointer.setup_on_startup:
            await task_store.setup()
        if settings.async_tasks.enabled:
            task_runner = TaskRunner(task_store, TaskStreamPublisher())
            set_task_runner(task_runner)
            # Runs a restart cut settle as errors; their parents are told.
            await task_runner.recover()
        # Plan 30: the skill catalogue is the remote sources, indexed daily.
        # Returns at once when REMOTE_SKILLS_ENABLED is false, so no request
        # ever leaves the service.
        remote_sync_task = asyncio.create_task(
            run_remote_skill_sync_loop(), name="remote-skill-sync"
        )
        yield
    finally:
        if task_runner is not None:
            set_task_runner(None)
            await task_runner.shutdown()
        if remote_sync_task is not None:
            remote_sync_task.cancel()
            # Swallow only the cancellation we just requested.
            try:
                await remote_sync_task
            except asyncio.CancelledError:
                pass
        if pool is not None:
            await pool.close()
        loop.set_exception_handler(old)
        logger.info("service_shutdown", "Agents service shutdown completed")
        shutdown_logging()


app = FastAPI(lifespan=_lifespan, title="Agents Service")
register_exception_handlers(app)
app.add_middleware(RequestLoggingMiddleware)
# Async sub-agents call /ap through this app in process (harness.async_tasks.client).
set_protocol_app(app)


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}


app.include_router(account_router)
app.include_router(agent_protocol_router)
app.include_router(catalog_router)
app.include_router(commands_router)
app.include_router(conversation_files_router)
app.include_router(embeddings_router)
app.include_router(export_router)
app.include_router(generation_router)
app.include_router(inference_router)
app.include_router(memories_router)
app.include_router(skills_router)
app.include_router(tasks_router)
app.include_router(agent_tools_router)
app.include_router(user_agents_router)
app.include_router(voice_router)
app.include_router(workflows_router)
