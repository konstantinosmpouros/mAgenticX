# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

import asyncio
import subprocess
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi_pagination import add_pagination
from core.settings import settings
from utils.inference_runs import cleanup_orphaned_inference_runs
from observability import (
    RequestLoggingMiddleware,
    configure_logging,
    get_logger,
    register_exception_handlers,
)
from slowapi.middleware import SlowAPIMiddleware
from core.rate_limit import limiter

from router import (
    auth_router,
    catalog_router,
    inference_router,
    preferences_router,
    conversations_router,
    messages_router,
    attachments_router,
    shared_conv_router,
    speech_router,
    voice_router,
    search_router,
    skills_router,
)

configure_logging()
logger = get_logger(__name__)


def _run_alembic_upgrade() -> None:
    """Apply pending migrations to bring the DB to ``head``.

    Spawned as a subprocess so alembic gets a clean Python interpreter free
    of any uvicorn-imported state — calling alembic in-process at module load
    deadlocks (two worker threads stuck on futex_wait_queue) even though the
    exact same command exits cleanly via ``docker exec``. Process isolation
    is the safest fix and matches the standard "migrate before serve"
    deployment pattern. The subprocess inherits the parent's environment so
    DATABASE_URL and friends propagate automatically.
    """
    result = subprocess.run(
        ["alembic", "-c", str(PACKAGE_ROOT / "alembic.ini"), "upgrade", "head"],
        cwd=str(PACKAGE_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.stdout:
        logger.info("alembic_subprocess_stdout", "Alembic subprocess output", output=result.stdout.strip())
    if result.stderr:
        logger.info("alembic_subprocess_stderr", "Alembic subprocess stderr", output=result.stderr.strip())
    if result.returncode != 0:
        raise RuntimeError(
            f"alembic upgrade head failed with exit code {result.returncode}"
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("service_startup", "Dialogue bridge startup initiated")
    if settings.database.run_migrations_on_startup:
        logger.info("database_migrations_started", "Running alembic upgrade head")
        # asyncio.to_thread keeps the FastAPI event loop responsive while the
        # subprocess runs. Subprocess isolation is the key — the previous
        # in-process attempt deadlocked because alembic's env.py spun up its
        # own asyncio.run inside our worker thread; ``subprocess.run`` is OS-
        # level and shares no state with the parent loop, so to_thread is
        # safe here.
        await asyncio.to_thread(_run_alembic_upgrade)
        logger.info("database_migrations_completed", "Alembic upgrade head completed")
    else:
        # Emergency opt-out — boot without touching the schema. The operator
        # is expected to apply migrations manually before serving real traffic.
        logger.warning(
            "database_migrations_skipped",
            "RUN_MIGRATIONS_ON_STARTUP=false — skipping alembic upgrade head",
        )
    await cleanup_orphaned_inference_runs()
    logger.info("database_schema_ready", "Database schema is ready")
    yield
    logger.info("service_shutdown", "Dialogue bridge shutdown completed")


# Initialize FastAPI app
app = FastAPI(
    title="Bridge Service",
    description="A service that bridges the gap between various dialogue systems and applications.",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan
)


# Attach rate limiter to app state
app.state.limiter = limiter


# Register exception handlers and middlewares
register_exception_handlers(app)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors.allowed_origins),
    allow_credentials=settings.cors.allow_credentials,
    allow_methods=list(settings.cors.allow_methods),
    allow_headers=list(settings.cors.allow_headers),
    expose_headers=list(settings.cors.expose_headers),
    max_age=settings.cors.max_age_seconds,
)
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(RequestLoggingMiddleware)


# Add pagination
add_pagination(app)


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}


# Include API routers
app.include_router(
    auth_router,
    prefix=f"/v1/auth",
    tags=["Auth"]
)
app.include_router(
    inference_router,
    prefix=f"/v1/inference",
    tags=["Inference"],
)
app.include_router(
    speech_router,
    prefix=f"/v1/speech",
    tags=["Speech"],
)
app.include_router(
    voice_router,
    prefix=f"/v1/voice",
    tags=["Voice"],
)
app.include_router(
    catalog_router,
    prefix=f"/v1/catalog",
    tags=["Catalog"]
)
app.include_router(
    preferences_router,
    prefix=f"/v1/preferences",
    tags=["Preferences"]
)
app.include_router(
    conversations_router,
    prefix=f"/v1/conversations",
    tags=["Conversations"],
)
app.include_router(
    messages_router,
    prefix=f"/v1/messages",
    tags=["Messages"],
)
app.include_router(
    attachments_router,
    prefix=f"/v1/attachments",
    tags=["Attachments"],
)
app.include_router(
    shared_conv_router,
    prefix=f"/v1/shared-conversations",
    tags=["Shared Conversations"],
)
app.include_router(
    search_router,
    prefix=f"/v1/search",
    tags=["Search"],
)
app.include_router(
    skills_router,
    prefix=f"/v1/skills",
    tags=["Skills"],
)
