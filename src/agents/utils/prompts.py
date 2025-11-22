from typing import Any, List, Literal, Dict, Mapping, Optional, Sequence, Union, cast

from langchain_core.prompts import ChatPromptTemplate
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field, ValidationError



# --------------------------------------------------------------------------------------
# Content schemas (extensible: add audio, video, etc. later)
# --------------------------------------------------------------------------------------

class TextPart(BaseModel):
    """Text content part."""
    type: Literal["text"] = "text"
    text: str


class ImageURLPayload(BaseModel):
    """Schema for image_url payload accepted by OpenAI multimodal endpoints."""
    url: str
    detail: Optional[Literal["auto", "low", "high"]] = None


class ImageURLPart(BaseModel):
    """Image content part (data URL or remote URL)."""
    type: Literal["image_url"] = "image_url"
    image_url: Union[str, ImageURLPayload]


SupportedPart = Union[TextPart, ImageURLPart]


def make_merge_with_template(system_template: ChatPromptTemplate):
    """Return a callable that prepends the given system template before user input."""
    def _merge(user_input: UserInputT) -> List[BaseMessage]:
        user_msgs: List[BaseMessage] = normalise_user_input(user_input)
        merged = ChatPromptTemplate.from_messages(system_template.messages + user_msgs)
        return merged.format_messages()

    return _merge


def _coerce_part(part: Mapping[str, Any]) -> SupportedPart:
    """Validate and coerce a raw dict part into a SupportedPart model."""
    t = str(part.get("type", "")).lower()
    if t == "text":
        return TextPart(**part)
    if t == "image_url":
        return ImageURLPart(**part)
    raise ValueError(f"Unsupported content part type: {t!r} (part={part})")


def _normalize_content(
    content: Union[str, Sequence[Mapping[str, Any]], None]
) -> Union[str, List[Dict[str, Any]]]:
    """
    Normalize message.content into:
        - str: passthrough
        - list[dict]: validated via Pydantic and returned as plain dicts
        - None: -> "" (empty string)
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        out: List[Dict[str, Any]] = []
        for idx, raw in enumerate(content):
            if not isinstance(raw, Mapping):
                raise TypeError(f"Content part at index {idx} must be a dict, got {type(raw)}")
            try:
                model = _coerce_part(raw)
            except ValidationError as ve:  # extra safety if fields missing
                raise ValueError(f"Invalid content part at index {idx}: {ve}") from ve
            out.append(model.model_dump(exclude_none=True))
        return out
    raise TypeError(f"content must be str | list[dict] | None, got {type(content)}")



# --------------------------------------------------------------------------------------
# Role normalization and dict -> BaseMessage
# --------------------------------------------------------------------------------------

_ROLE_MAP = {
    "system": "system",
    "user": "human",
    "human": "human",
    "assistant": "ai",
    "ai": "ai",
}

def _normalize_role(raw: Optional[str]) -> str:
    key = (raw or "").strip().lower()
    if key not in _ROLE_MAP:
        raise ValueError(
            f"Unsupported role: {raw!r}. Expected one of: {', '.join(_ROLE_MAP.keys())}"
        )
    return _ROLE_MAP[key]


def dict_to_message(data: Mapping[str, Any]) -> BaseMessage:
    """
    Convert a chat payload dict -> BaseMessage, with multimodal-safe content.

    Accepts:
        {"role": "user", "content": "hi"}
        {"role": "user", "content": [{"type":"text","text":"..."}, {"type":"image_url","image_url":"..."}]}
    """
    role = _normalize_role(data.get("role"))
    content = _normalize_content(data.get("content"))

    if role == "human":
        return HumanMessage(content=content)
    if role == "ai":
        return AIMessage(content=content)
    if role == "system":
        return SystemMessage(content=content)

    # Should not happen due to normalization
    raise ValueError(f"Unhandled normalized role {role!r}")



# --------------------------------------------------------------------------------------
# Public normaliser: ALWAYS strips system (agents inject their own system prompts)
# --------------------------------------------------------------------------------------

UserInputT = Union[
    ChatPromptTemplate,
    Sequence[BaseMessage],
    Sequence[Mapping[str, Any]],
]


def _strip_system(messages: Sequence[BaseMessage]) -> List[BaseMessage]:
    """Drop any SystemMessage instances."""
    return [m for m in messages if not isinstance(m, SystemMessage)]


def normalise_user_input(
    user_input: UserInputT,
    *,
    template_kwargs: Optional[Dict[str, Any]] = None,
) -> List[BaseMessage]:
    """
    Normalize heterogeneous user input into List[BaseMessage] with system messages removed.

    Supports:
        1) ChatPromptTemplate         -> .format_messages(**template_kwargs or {})
        2) list[BaseMessage]          -> passthrough
        3) list[dict{role, content}]  -> each dict_to_message(...)

    Multimodal content is preserved (content can be a str or a list of validated parts).
    """
    # 1) ChatPromptTemplate
    if isinstance(user_input, ChatPromptTemplate):
        msgs = user_input.format_messages(**(template_kwargs or {}))
        return _strip_system(msgs)

    # Ensure a sequence
    if not isinstance(user_input, (list, tuple)):
        raise TypeError(
            "user_input must be ChatPromptTemplate | list[BaseMessage] | list[dict]"
        )

    # 2) Empty -> nothing to do
    if not user_input:
        return []

    first = user_input[0]

    # 2) list[BaseMessage]
    if isinstance(first, BaseMessage):
        msgs = cast(Sequence[BaseMessage], user_input)
        return _strip_system(msgs)

    # 3) list[dict]
    if isinstance(first, Mapping):
        msgs = [dict_to_message(cast(Mapping[str, Any], d)) for d in cast(Sequence[Mapping[str, Any]], user_input)]
        return _strip_system(msgs)

    raise TypeError(
        "user_input must be ChatPromptTemplate | list[BaseMessage] | list[dict]; "
        f"got element type {type(first)!r}"
    )


__all__ = [
    "TextPart",
    "ImageURLPayload",
    "ImageURLPart",
    "dict_to_message",
    "normalise_user_input",
    "make_merge_with_template",
]
