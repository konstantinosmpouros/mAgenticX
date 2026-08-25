from fastapi import APIRouter, Depends, status

from core.security.internal_trust import require_internal_caller
from core.logging import get_logger
from schemas import (
    ConversationSuggestions,
    ConversationTitle,
    SuggestionsRequest,
    TitleRequest,
)
from utils import generate_suggestions, generate_title

logger = get_logger(__name__)

router = APIRouter()


@router.post(
    "/titles/generate",
    response_model=ConversationTitle,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def generate_conversation_title(req: TitleRequest) -> ConversationTitle:
    """Generate a short, descriptive title for a new conversation."""
    logger.info("title_request_received", "Conversation title request received", prompt_messages=len(req.user_input))
    return await generate_title(req)


@router.post(
    "/suggestions/generate",
    response_model=ConversationSuggestions,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def generate_conversation_suggestions(req: SuggestionsRequest) -> ConversationSuggestions:
    """Generate personalized starter suggestions for a new conversation."""
    logger.info("suggestion_request_received", "Conversation suggestion request received", prompt_messages=len(req.user_input))
    return await generate_suggestions(req)
