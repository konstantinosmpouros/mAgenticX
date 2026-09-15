"""Agent tool: look at an image in this conversation, whole or zoomed in.

``read_file`` can already return an image, but it is a general file reader —
the model reaches for it with offsets and limits, and its result renders as a
file read. ``view_image`` is the narrow, obvious verb for "show me this
picture", and the UI renders it as the picture alone.

Returns a ``ToolMessage`` carrying an **image content block**, which is what
actually puts the image in front of the model — a JSON string of base64 would
reach it as text and be worth nothing. The AG-UI emitter replaces that block
with a bounded thumbnail on its way to the browser (``harness/agui/previews``),
so the model's copy and the rendered copy differ by design.

**Zooming is a second look, not a first one.** A region is given in pixels of
the full image, which the model cannot guess — so every result leads with a
text block stating the image's dimensions. The intended loop is: view the
whole thing, read the size off the result, then come back for the region worth
reading closely. A crop smaller than ``MIN_DETAIL_EDGE`` is scaled up, because
a 60x20 slice of a screenshot carries the same few pixels of text whether or
not the model is told to look harder.

Bound **per run** to this conversation, and readable from both mounts:
``/conversation/input/`` (the user's uploads) and ``/conversation/output/``
(what the agent has produced).
"""
from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import Annotated, Any, Optional

from langchain_core.messages import ToolMessage
from langchain_core.tools import InjectedToolCallId, StructuredTool
from pydantic import BaseModel, Field

from core.logging import get_logger
from core.settings import settings
from harness.filesystem import resolve_conversation_file

try:  # optional at import time so a missing wheel degrades instead of crashing
    from PIL import Image
except ImportError:  # pragma: no cover - Pillow is pinned in requirements
    Image = None  # type: ignore[assignment]

logger = get_logger(__name__)

#: Only formats a vision model can actually consume. Anything else is refused
#: with a readable reason rather than handed over as an unusable block.
#:
#: Mapped explicitly rather than via ``mimetypes.guess_type``, which reads the
#: host's mime database: the agents image does not know ``.webp`` there, so a
#: format this tool advertises would have been refused depending on where it
#: ran.
MIME_BY_SUFFIX: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

SUPPORTED_MIMES: frozenset[str] = frozenset(MIME_BY_SUFFIX.values())

#: A crop is scaled up to at least this edge. Cropping is how the model reads
#: small text, and a tight crop is by definition few pixels — handing it back
#: at native size wastes the round trip.
MIN_DETAIL_EDGE = 768

#: Ceiling on that upscale. Past roughly 6x there is no information left to
#: recover, only bytes.
MAX_UPSCALE = 6.0

#: Cap on the re-encoded crop's edge, so a zoom into a huge region cannot send
#: back something larger than the original view.
MAX_DETAIL_EDGE = 2048


class _Region(BaseModel):
    """A rectangle in pixels of the full image, origin at the top-left."""

    x: int = Field(ge=0, description="Left edge, in pixels from the left of the image.")
    y: int = Field(ge=0, description="Top edge, in pixels from the top of the image.")
    width: int = Field(gt=0, description="Width of the region in pixels.")
    height: int = Field(gt=0, description="Height of the region in pixels.")


class _ViewImageArgs(BaseModel):
    path: str = Field(
        description="Virtual path of the image to look at, under "
        "'/conversation/input/' or '/conversation/output/' — for example "
        "'/conversation/input/screenshot.png'."
    )
    region: Optional[_Region] = Field(
        default=None,
        description="Optional rectangle to zoom into, in pixels of the full "
        "image. Omit it to see the whole image — the result tells you the "
        "dimensions, which is what you need to choose a region. The crop is "
        "enlarged for you, so ask for the area you want to read, not a padded "
        "one.",
    )
    # Injected by LangChain, never by the model: a ToolMessage has to carry the
    # id of the call it answers, and this is excluded from the model-facing
    # schema automatically.
    tool_call_id: Annotated[str, InjectedToolCallId]


def _failure(text: str, tool_call_id: str) -> ToolMessage:
    """An error the model can read and act on, not an exception.

    This runs mid-turn: raising would fail the user's run over a mistyped
    filename. ``status="error"`` is what makes the UI render the step as failed.
    """
    return ToolMessage(
        content=text, name="view_image", tool_call_id=tool_call_id, status="error"
    )


def clamp_region(region: _Region, width: int, height: int) -> tuple[int, int, int, int] | None:
    """Intersect a requested region with the image, or None if they miss entirely.

    Clamped rather than rejected because a model estimating coordinates off a
    previous look will routinely overshoot an edge by a few pixels, and failing
    that costs a whole round trip to learn nothing.
    """
    left = min(region.x, width)
    top = min(region.y, height)
    right = min(region.x + region.width, width)
    bottom = min(region.y + region.height, height)
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _encode(img: Any, keep_alpha: bool) -> tuple[bytes, str]:
    """Re-encode a cropped/scaled image, preserving transparency when present."""
    buffer = io.BytesIO()
    if keep_alpha:
        img.save(buffer, format="PNG", optimize=True)
        return buffer.getvalue(), "image/png"
    img.save(buffer, format="JPEG", quality=88, optimize=True)
    return buffer.getvalue(), "image/jpeg"


def _crop(raw: bytes, region: _Region) -> tuple[bytes, str, str] | str:
    """Return ``(bytes, mime, note)`` for the zoomed region, or an error string."""
    with Image.open(io.BytesIO(raw)) as img:
        img.load()
        full_w, full_h = img.size
        box = clamp_region(region, full_w, full_h)
        if box is None:
            return (
                f"The region x={region.x} y={region.y} w={region.width} "
                f"h={region.height} lies outside the image, which is "
                f"{full_w}x{full_h} pixels."
            )

        left, top, right, bottom = box
        keep_alpha = img.mode in ("RGBA", "LA", "P")
        cropped = img.convert("RGBA" if keep_alpha else "RGB").crop(box)

        crop_w, crop_h = cropped.size
        longest = max(crop_w, crop_h)
        scale = 1.0
        if longest < MIN_DETAIL_EDGE:
            scale = min(MIN_DETAIL_EDGE / longest, MAX_UPSCALE)
        elif longest > MAX_DETAIL_EDGE:
            scale = MAX_DETAIL_EDGE / longest
        if scale != 1.0:
            cropped = cropped.resize(
                (max(1, round(crop_w * scale)), max(1, round(crop_h * scale))),
                Image.LANCZOS,
            )

        data, mime = _encode(cropped, keep_alpha)

    note = (
        f"Zoomed into x={left} y={top} w={right - left} h={bottom - top} of a "
        f"{full_w}x{full_h} image"
    )
    if (left, top, right, bottom) != (region.x, region.y, region.x + region.width, region.y + region.height):
        note += " (clamped to the image bounds)"
    if scale != 1.0:
        note += f", shown at {scale:.1f}x"
    return data, mime, note + "."


def _describe(raw: bytes) -> str:
    """Leading note for a full view — the dimensions a zoom needs to be aimed."""
    if Image is None:
        return "Showing the whole image."
    try:
        with Image.open(io.BytesIO(raw)) as img:
            width, height = img.size
    except Exception:
        return "Showing the whole image."
    return (
        f"Showing the whole image, {width}x{height} pixels. To read a detail, "
        "call view_image again with a 'region' in these coordinates."
    )


def build_view_image_tool(
    *, user_id: str, agent_slug: str, conversation_id: str
) -> StructuredTool:
    """Return a ``view_image`` tool bound to this run's conversation."""

    def _view_image(
        path: str, tool_call_id: str, region: Optional[_Region] = None
    ) -> ToolMessage:
        try:
            resolved = resolve_conversation_file(
                user_id=user_id,
                agent_slug=agent_slug,
                conversation_id=conversation_id,
                virtual_path=path,
            )
        except ValueError as exc:
            return _failure(f"Could not view the image: {exc}", tool_call_id)

        if not resolved.is_file():
            return _failure(
                f"No image at {path!r} — it does not exist in this filesystem. "
                "Use 'ls' to see what is in '/conversation/input/' and "
                "'/conversation/output/'.",
                tool_call_id,
            )

        suffix = Path(path).suffix.lower()
        mime = MIME_BY_SUFFIX.get(suffix)
        if mime is None:
            return _failure(
                f"{path!r} is not a viewable image ({suffix or 'no extension'}). "
                f"Supported: {', '.join(sorted(MIME_BY_SUFFIX))}.",
                tool_call_id,
            )

        try:
            raw = resolved.read_bytes()
        except OSError as exc:
            logger.warning(
                "view_image_read_failed",
                "Could not read an image for view_image",
                agent_slug=agent_slug,
                conversation_id=conversation_id,
                failure_reason=type(exc).__name__,
            )
            return _failure(f"Could not read {path!r}.", tool_call_id)

        max_bytes = settings.filesystem.view_image_max_bytes
        if len(raw) > max_bytes:
            return _failure(
                f"{path!r} is too large to view "
                f"({len(raw) // 1024} KB, limit {max_bytes // 1024} KB).",
                tool_call_id,
            )

        note = _describe(raw)
        if region is not None:
            if Image is None:
                return _failure(
                    "Zooming is unavailable on this deployment — call "
                    "view_image without a 'region' to see the whole image.",
                    tool_call_id,
                )
            try:
                cropped = _crop(raw, region)
            except Exception as exc:
                logger.warning(
                    "view_image_crop_failed",
                    "Could not crop an image for view_image",
                    agent_slug=agent_slug,
                    conversation_id=conversation_id,
                    failure_reason=type(exc).__name__,
                )
                return _failure(
                    f"Could not zoom into {path!r} — the image could not be decoded.",
                    tool_call_id,
                )
            if isinstance(cropped, str):
                return _failure(cropped, tool_call_id)
            raw, mime, note = cropped

        logger.info(
            "image_viewed",
            "Agent viewed an image from the conversation filesystem",
            agent_slug=agent_slug,
            conversation_id=conversation_id,
            filename=resolved.name,
            image_bytes=len(raw),
            zoomed=region is not None,
        )
        return ToolMessage(
            content_blocks=[
                {"type": "text", "text": note},
                {
                    "type": "image",
                    "base64": base64.standard_b64encode(raw).decode("ascii"),
                    "mime_type": mime,
                },
            ],
            name="view_image",
            tool_call_id=tool_call_id,
            status="success",
        )

    return StructuredTool.from_function(
        func=_view_image,
        name="view_image",
        description=(
            "Look at an image in this conversation — a screenshot or photo the "
            "user uploaded to '/conversation/input/', or a chart or render you "
            "produced in '/conversation/output/'. The image is shown to you "
            "directly, so call this whenever a question depends on what a "
            "picture actually contains rather than on its filename.\n"
            "Call it with just a 'path' to see the whole image; the result "
            "tells you its pixel dimensions. When a detail is too small to "
            "read — small text, a number on an axis, one control in a UI — "
            "call it AGAIN on the same path with a 'region' in those "
            "coordinates to zoom in. The crop is enlarged for you, so ask for "
            "the area you actually want to read. Zoom as often as you need; "
            "each call is a fresh look, not a replacement for the last one.\n"
            "PNG, JPEG, GIF and WebP only; for any other file use 'read_file'."
        ),
        args_schema=_ViewImageArgs,
    )


__all__ = ["MIME_BY_SUFFIX", "SUPPORTED_MIMES", "build_view_image_tool", "clamp_region"]
