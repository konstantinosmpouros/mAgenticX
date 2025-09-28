"""Utilities for normalising flexible user inputs into LangChain message objects."""

from typing import Dict, List, Sequence, Union, cast

from langchain.prompts import ChatPromptTemplate
from langchain.schema import AIMessage, BaseMessage, HumanMessage, SystemMessage

__all__ = [
    "dict_to_message",
    "strip_system_messages",
    "normalise_user_input",
]


def dict_to_message(data: Dict[str, str]) -> BaseMessage | None:
    """Convert a dict with chat data into a message, ignoring system roles."""
    role = data.get("role", "").lower()
    content = data.get("content", "")
    if role in {"user", "human"}:
        return HumanMessage(content=content)
    if role in {"assistant", "ai"}:
        return AIMessage(content=content)
    return None


def strip_system_messages(messages: Sequence[BaseMessage]) -> List[BaseMessage]:
    """Drop any system messages from the provided sequence."""
    return [message for message in messages if not isinstance(message, SystemMessage)]


def normalise_user_input(
    user_input: Union[List[Dict[str, str]], ChatPromptTemplate, Sequence[BaseMessage]],
) -> List[BaseMessage]:
    """Return user input in list[BaseMessage] form without system messages."""

    messages: Sequence[BaseMessage]

    if isinstance(user_input, ChatPromptTemplate):
        messages = user_input.format_messages()

    elif isinstance(user_input, (list, tuple)) and (
        not user_input or isinstance(user_input[0], BaseMessage)
    ):
        messages = cast(Sequence[BaseMessage], user_input)

    elif (
        isinstance(user_input, (list, tuple))
        and user_input
        and isinstance(user_input[0], dict)
    ):
        maybe_messages = (
            dict_to_message(cast(Dict[str, str], payload))
            for payload in user_input
        )
        messages = [message for message in maybe_messages if message is not None]

    else:
        raise TypeError(
            "user_input must be ChatPromptTemplate, list[BaseMessage], "
            f"or list[dict[str,str]] (got {type(user_input)!r})"
        )

    return strip_system_messages(messages)
