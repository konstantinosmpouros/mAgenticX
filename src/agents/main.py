# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))


import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from runtime.checkpointer import init_durable_checkpointer
from runtime.filesystem import run_workspace_retention_loop
from core.logging import (
    RequestLoggingMiddleware,
    configure_logging,
    get_logger,
    register_exception_handlers,
    shutdown_logging,
)
from runtime.skill_registry import (
    rebuild_global_manifest,
    reconcile_all_user_manifests,
    seed_global_registry,
)
from runtime.abstractions import seed_global_agents
from utils.agents import refresh_registry
from router.catalog import router as catalog_router
from router.embeddings import router as embeddings_router
from router.generation import router as generation_router
from router.inference import router as inference_router
from router.memories import router as memories_router
from router.skills import router as skills_router
from router.agent_tools import router as agent_tools_router
from router.user_agents import router as user_agents_router
from router.voice import router as voice_router


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
    retention_task: asyncio.Task | None = None
    try:
        logger.info("service_startup", "Agents service startup initiated")
        # Bootstrap the global skills registry volume from the image seed,
        # index it into manifest.json, then heal per-user manifests against
        # filesystem state.
        seed_global_registry()
        rebuild_global_manifest()
        reconcile_all_user_manifests()
        # Seed built-in declarative (YAML) agents into the global volume, then
        # re-scan so they join AGENT_REGISTRY (invisible at import, before seed).
        seed_global_agents()
        refresh_registry()
        # Durable checkpointer — fail fast and loud if agent_runtime is
        # unreachable; cross-turn resume depends on it.
        await init_durable_checkpointer(app)
        pool = app.state.checkpointer_pool
        # TTL retention for conversation input/output caches (blob-backed in
        # the DB, so erasure is safe). Best-effort background loop — it logs
        # and retries on failure, never takes the service down.
        retention_task = asyncio.create_task(
            run_workspace_retention_loop(), name="workspace-retention"
        )
        yield
    finally:
        if retention_task is not None:
            retention_task.cancel()
            # Swallow only the cancellation we just requested.
            try:
                await retention_task
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


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}


app.include_router(catalog_router)
app.include_router(embeddings_router)
app.include_router(generation_router)
app.include_router(inference_router)
app.include_router(memories_router)
app.include_router(skills_router)
app.include_router(agent_tools_router)
app.include_router(user_agents_router)
app.include_router(voice_router)
