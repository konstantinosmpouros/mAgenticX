import base64

from database import MessageTable


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
