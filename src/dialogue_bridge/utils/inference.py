import logging
import base64

from fastapi import HTTPException, status
from observability import log_event

from database import MessageTable


def validate_and_order_message_path(
    messages: list[MessageTable],
    message_ids: list[str] | None,
) -> list[MessageTable]:
    """
    Validate a requested message path and return the corresponding messages
    in the exact requested order.
    """
    if not message_ids:
        return messages

    cleaned_ids: list[str] = []
    for raw_id in message_ids:
        if not isinstance(raw_id, str) or not raw_id.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="messagePath contains invalid ids.",
            )
        cleaned_ids.append(raw_id.strip())

    if len(set(cleaned_ids)) != len(cleaned_ids):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="messagePath contains duplicates.")

    lookup = {message.id: message for message in messages}
    ordered_messages: list[MessageTable] = []
    for message_id in cleaned_ids:
        match = lookup.get(message_id)
        if not match:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="messagePath references messages outside this conversation or messagePath is corrupted.",
            )
        ordered_messages.append(match)

    return ordered_messages


def prepare_inference_history(
    *,
    logger: logging.Logger,
    messages: list[MessageTable],
    message_ids: list[str] | None,
    enabled_tools_count: int,
) -> tuple[list[MessageTable], list[dict]]:
    """
    Resolve the message branch for inference, strip any trailing empty AI
    placeholder, serialise the final message list, and emit the branch log.
    """
    history_messages = list(validate_and_order_message_path(messages, message_ids))
    placeholder_stripped = False

    if history_messages:
        last_msg = history_messages[-1]
        is_placeholder = (
            last_msg.sender == "ai"
            and not last_msg.content
            and (not getattr(last_msg, "attachments", None))
        )
        if is_placeholder:
            placeholder_stripped = True
            history_messages = history_messages[:-1]

    history = [serialise_message_with_images_for_agent(message) for message in history_messages]
    log_event(
        logger,
        logging.INFO,
        "inference_branch_resolved",
        "Inference branch resolved",
        requested_message_path_length=len(message_ids or []),
        branch_source="message_path" if message_ids else "conversation",
        placeholder_stripped=placeholder_stripped,
        resolved_history_messages=len(history_messages),
        serialised_messages=len(history),
        enabled_tools=enabled_tools_count,
    )
    return history_messages, history


def serialise_message_with_images_for_agent(msg: MessageTable) -> dict:
    """
    Convert a MessageTable (with attachments) into a LangChain message with multimodal content.
    - Images are embedded as data-URLs
    - Other attachments are listed by name in a text block
    """
    role = "user" if msg.sender == "user" else "ai"
    text_content = (msg.content or "").strip()
    attachments = getattr(msg, "attachments", []) or []

    content_parts = []
    other_attachment_notes = []

    if text_content:
        # Always include the textual portion first so the agent sees the prompt.
        content_parts.append({"type": "text", "text": text_content})

    # Walk each attachment and emit multimodal descriptors as needed.
    for attachment in attachments:
        mime = (getattr(attachment, "mime_type", None) or "").lower()
        blob = getattr(attachment, "blob", None)
        data_bytes = getattr(blob, "data", None) if blob is not None else None

        if mime.startswith("image/") and data_bytes:
            # Inline images as base64 data URLs to keep transport self-contained.
            data_b64 = base64.b64encode(data_bytes).decode("ascii")
            data_url = f"data:{mime};base64,{data_b64}"
            content_parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": data_url,
                        "detail": "auto",
                    },
                }
            )
        else:
            name = getattr(attachment, "file_name", None)
            if name:
                # Non-image attachments are summarized as text bullets.
                label = f"{name} ({attachment.mime_type})" if getattr(attachment, "mime_type", None) else name
                other_attachment_notes.append(label)

    if other_attachment_notes:
        # Append metadata for downloadable artifacts after the main content.
        attachment_text = "Attachments:\n" + "\n".join(f"- {note}" for note in other_attachment_notes)
        content_parts.append({"type": "text", "text": attachment_text})

    if not content_parts:
        content_parts.append({"type": "text", "text": ""})

    if len(content_parts) == 1 and content_parts[0]["type"] == "text":
        content_payload = content_parts[0]["text"]
    else:
        content_payload = content_parts

    return {"role": role, "content": content_payload}
