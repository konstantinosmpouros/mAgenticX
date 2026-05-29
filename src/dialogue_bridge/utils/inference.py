import base64

from fastapi import HTTPException, status
from observability import EventLogger

from core.database import MessageTable


def build_path_to_message(messages: list[MessageTable], message_id: str) -> list[MessageTable]:
    """Return the parent-linked lineage ending at a message in this conversation."""
    lookup = {message.id: message for message in messages}
    current = lookup.get(message_id)
    if current is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message does not belong to this conversation.")

    path: list[MessageTable] = []
    seen: set[str] = set()
    while current is not None:
        if current.id in seen:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Conversation branch is cyclic.")
        seen.add(current.id)
        path.append(current)
        parent_id = current.parent_message_id
        if not parent_id:
            break
        current = lookup.get(parent_id)
        if current is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Conversation branch is incomplete.")

    path.reverse()
    return path


def resolve_inference_message_path(
    messages: list[MessageTable],
    parent_message_id: str,
    requested_message_ids: list[str] | None,
) -> list[str]:
    """
    Validate the UI branch hint when provided, then return the authoritative
    DB lineage ending at the parent message. The backend never trusts client
    ordering for the persisted run path.
    """
    if requested_message_ids:
        ordered = validate_and_order_message_path(messages, requested_message_ids)
        for previous, current in zip(ordered, ordered[1:]):
            if current.parent_message_id != previous.id:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="messagePath is not a valid message lineage.")
        if ordered[-1].id != parent_message_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="messagePath must end at the inference parent message.")

    return [message.id for message in build_path_to_message(messages, parent_message_id)]


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
    logger: EventLogger,
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
    logger.info(
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
