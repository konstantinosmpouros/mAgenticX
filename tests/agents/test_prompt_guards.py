from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage, SystemMessage


def test_normalise_user_input_strips_system_messages(agents_service):
    messages = [
        SystemMessage(content="System"),
        HumanMessage(content="Hello"),
    ]

    normalised = agents_service.prompts.normalise_user_input(messages)

    assert len(normalised) == 1
    assert normalised[0].content == "Hello"


def test_normalise_user_input_rejects_invalid_roles(agents_service):
    with pytest.raises(ValueError, match="Unsupported role"):
        agents_service.prompts.normalise_user_input([{"role": "moderator", "content": "Hello"}])


def test_dict_to_message_preserves_multimodal_content(agents_service):
    message = agents_service.prompts.dict_to_message(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Look at this"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,abcd", "detail": "low"}},
            ],
        }
    )

    assert message.content == [
        {"type": "text", "text": "Look at this"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abcd", "detail": "low"}},
    ]
