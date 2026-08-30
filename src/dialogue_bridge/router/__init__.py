from router.auth import router as auth_router
from router.catalog import router as catalog_router
from router.user_agents import router as user_agents_router
from router.agent_tools import router as agent_tools_router
from router.inference import router as inference_router
from router.preferences import router as preferences_router
from router.conversations import router as conversations_router
from router.messages import router as messages_router
from router.attachments import router as attachments_router
from router.shared_conv import router as shared_conv_router
from router.speech import router as speech_router
from router.search import router as search_router
from router.voice import router as voice_router
from router.skills import router as skills_router
from router.memories import router as memories_router
from router.scheduled_tasks import router as scheduled_tasks_router
from router.usage import router as usage_router
from router.internal_memory import router as internal_memory_router
from router.internal_workspace import router as internal_workspace_router

__all__ = [
    "auth_router",
    "user_agents_router",
    "catalog_router",
    "agent_tools_router",
    "inference_router",
    "preferences_router",
    "conversations_router",
    "messages_router",
    "attachments_router",
    "shared_conv_router",
    "speech_router",
    "voice_router",
    "search_router",
    "skills_router",
    "memories_router",
    "scheduled_tasks_router",
    "usage_router",
    "internal_memory_router",
    "internal_workspace_router",
]
