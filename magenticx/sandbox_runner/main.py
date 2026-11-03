"""sandbox_runner — runs one untrusted command per call in a throwaway gVisor box.

App factory, lifespan and ``/health`` only; ``/v1/exec`` lives in
``router/exec.py``. Internal-only service (plan 11): no host port, reached by
the agents service over mTLS with the internal-caller secret. Uvicorn (and its
TLS) is started by ``entrypoint.sh`` once the inner Docker daemon is up and the
box image is loaded.
"""
from contextlib import asynccontextmanager
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

from fastapi import FastAPI  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402

from core.logging import (  # noqa: E402
    RequestLoggingMiddleware,
    configure_logging,
    get_logger,
    register_exception_handlers,
)

configure_logging()
logger = get_logger(__name__)

from core.settings import settings  # noqa: E402
from router.exec import router as exec_router  # noqa: E402
from schema import HealthResponse  # noqa: E402
from utils.health import health_monitor  # noqa: E402
from utils.runner import sweep_leftovers  # noqa: E402
from utils.workspace import sweep_calls_root  # noqa: E402


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Boxes orphaned by a previous crash are removed before any new one runs.
    removed = await sweep_leftovers(settings.sandbox)
    # ...and so are their per-call temp dirs.
    swept_dirs = sweep_calls_root(settings.sandbox.calls_root)
    logger.info(
        "service_startup",
        "Sandbox runner startup",
        swept_containers=removed,
        swept_call_dirs=swept_dirs,
        runtime=settings.sandbox.runtime,
        image=settings.sandbox.image,
    )
    yield
    logger.info("service_shutdown", "Sandbox runner shutdown completed")


app = FastAPI(lifespan=_lifespan, title="Sandbox Runner", docs_url=None, redoc_url=None, openapi_url=None)
register_exception_handlers(app)
app.add_middleware(RequestLoggingMiddleware)
app.include_router(exec_router)


@app.get("/health", include_in_schema=False, response_model=HealthResponse)
async def health():
    """200 only when a real ``--runtime=runsc`` box just reported a gVisor kernel."""
    verdict = await health_monitor.verdict()
    body = HealthResponse(
        status="ok" if verdict.ok else "unavailable",
        runtime=settings.sandbox.runtime,
        gvisor=verdict.ok,
    )
    return JSONResponse(status_code=200 if verdict.ok else 503, content=body.model_dump())
