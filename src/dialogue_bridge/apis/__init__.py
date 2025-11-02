from apis.auth import router as auth_router
from apis.inference import router as inference_router
from apis.utils import router as utils_router
from apis.conversations import router as conversations_router
from apis.messages import router as messages_router
from apis.attachments import router as attachments_router

__all__ = [
    "auth_router",
    "inference_router",
    "utils_router",
    "conversations_router",
    "messages_router",
    "attachments_router",
]
