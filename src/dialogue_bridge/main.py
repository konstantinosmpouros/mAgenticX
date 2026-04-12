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
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize database schema
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


app = FastAPI(title="Bridge Service", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)
add_pagination(app)

app.include_router(auth_router)
app.include_router(inference_router)
app.include_router(meta_router)
app.include_router(conversations_router)
app.include_router(messages_router)
app.include_router(attachments_router)
