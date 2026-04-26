# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi_pagination import add_pagination
from core.configs import settings
from core.database import Base, engine
from observability import (
    RequestLoggingMiddleware,
    configure_logging,
    get_logger,
    register_exception_handlers,
)
from slowapi.middleware import SlowAPIMiddleware
from utils.rate_limit import limiter

from router import (
    auth_router,
    catalog_router,
    inference_router,
    preferences_router,
    conversations_router,
    messages_router,
    attachments_router,
    shared_conversations_router,
)

configure_logging()
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize database schema
    logger.info("service_startup", "Dialogue bridge startup initiated")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
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
    shared_conversations_router,
    prefix=f"/v1/shared-conversations",
    tags=["Shared Conversations"],
)
