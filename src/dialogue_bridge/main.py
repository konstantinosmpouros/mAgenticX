# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi_pagination import add_pagination
from database import Base, engine
from observability import (
    RequestLoggingMiddleware,
    configure_logging,
    get_logger,
    register_exception_handlers,
)
from slowapi.middleware import SlowAPIMiddleware
from utils.rate_limit import limiter

from apis import (
    auth_router,
    inference_router,
    meta_router,
    conversations_router,
    messages_router,
    attachments_router
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


app = FastAPI(title="Bridge Service", lifespan=lifespan)
app.state.limiter = limiter
register_exception_handlers(app)
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(RequestLoggingMiddleware)
add_pagination(app)

app.include_router(auth_router)
app.include_router(inference_router)
app.include_router(meta_router)
app.include_router(conversations_router)
app.include_router(messages_router)
app.include_router(attachments_router)
