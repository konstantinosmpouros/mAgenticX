from router.auth import router as auth_router
from router.catalog import router as catalog_router
from router.inference import router as inference_router
from router.preferences import router as preferences_router
from router.conversations import router as conversations_router
from router.messages import router as messages_router
from router.attachments import router as attachments_router
from router.shared_conversations import router as shared_conversations_router

__all__ = [
    "auth_router",
    "catalog_router",
    "inference_router",
    "preferences_router",
    "conversations_router",
    "messages_router",
    "attachments_router",
    "shared_conversations_router",
]
