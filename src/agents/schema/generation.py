"""Generation DTOs: conversation titles and personalized new-chat suggestions
produced by the generation router's structured-output LLM calls."""
from typing import Any, Dict, List
from pydantic import BaseModel


class TitleRequest(BaseModel):
    """Structured payload for generating a conversation title from the first user message."""
    user_input: List[Dict[str, Any]]


class ConversationTitle(BaseModel):
    """Structured LLM response carrying multiple generated title candidates."""
    titles: List[str]


class SuggestionsRequest(BaseModel):
    """Structured payload for generating personalized new-chat suggestions."""
    user_input: List[Dict[str, Any]]


class ConversationSuggestions(BaseModel):
    """Structured LLM response carrying generated new-chat suggestions."""
    suggestions: List[str]
