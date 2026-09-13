"""Shrink images in a tool result before it reaches the event stream.

A tool that returns an image (``read_file`` on a PNG, say) hands back a content
block carrying the whole file as base64. The **model** needs that. The event
stream does not: it is persisted twice — the Redis event log and the message row
— so shipping the original would put megabytes there for every call, and the
bridge's length cap would shred it into an undecodable prefix anyway.

So the emitter replaces each image block with a thumbnail. This runs in the
streaming path and therefore **never raises**: anything it cannot handle is
reported as ``omitted`` and the run continues.

The tool result itself is untouched. Only what the UI sees passes through here.
"""
from __future__ import annotations

import base64
import binascii
import io
import json
from typing import Any

from core.logging import get_logger
from core.settings import settings

try:  # optional at import time so a missing wheel degrades instead of crashing
    from PIL import Image
except ImportError:  # pragma: no cover - Pillow is pinned in requirements
    Image = None  # type: ignore[assignment]

logger = get_logger(__name__)

#: Formats kept as PNG so transparency survives; everything else becomes JPEG.
_TRANSPARENT_MIMES = {"image/png", "image/gif", "image/webp"}


def _encode_thumbnail(raw: bytes, mime: str) -> tuple[str, str] | None:
    """Return ``(base64, mime)`` for a bounded thumbnail, or None if it cannot be."""
    if Image is None:
        return None
    max_edge = settings.agui.image_preview_max_edge
    with Image.open(io.BytesIO(raw)) as img:
        img.load()
        keep_alpha = mime in _TRANSPARENT_MIMES and img.mode in ("RGBA", "LA", "P")
        img = img.convert("RGBA" if keep_alpha else "RGB")
        img.thumbnail((max_edge, max_edge))
        buffer = io.BytesIO()
        if keep_alpha:
            img.save(buffer, format="PNG", optimize=True)
            out_mime = "image/png"
        else:
            img.save(buffer, format="JPEG", quality=70, optimize=True)
            out_mime = "image/jpeg"
    data = buffer.getvalue()
    if len(data) > settings.agui.image_preview_max_bytes:
        return None
    return base64.b64encode(data).decode("ascii"), out_mime


def _shrink_block(block: dict[str, Any]) -> dict[str, Any]:
    """One image block, with its base64 replaced by a bounded preview.

    ``base64`` is dropped rather than renamed: nothing downstream should ever
    see the original, and a different key makes that unmistakable.
    """
    raw_b64 = block.get("base64")
    mime = str(block.get("mime_type") or "image/png")
    if not isinstance(raw_b64, str) or not raw_b64:
        return block

    out: dict[str, Any] = {k: v for k, v in block.items() if k != "base64"}
    try:
        raw = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        out["omitted"] = True
        return out

    out["bytes"] = len(raw)
    try:
        encoded = _encode_thumbnail(raw, mime)
    except Exception as exc:  # noqa: BLE001 - streaming path, must not abort the run
        logger.warning(
            "agui_image_preview_failed",
            "Could not build an image preview for a tool result",
            error_type=type(exc).__name__,
            mime_type=mime,
        )
        encoded = None

    if encoded is None:
        out["omitted"] = True
        return out

    out["preview_base64"], out["mime_type"] = encoded
    out["omitted"] = False
    return out


def shrink_image_blocks(content: str) -> str:
    """Replace image blocks in a serialised tool result with thumbnails.

    Returns ``content`` unchanged unless it parses as a list of content blocks
    containing at least one image — so text results never pay for a reparse
    beyond one cheap prefix check.
    """
    stripped = content.lstrip()
    if not stripped.startswith("[") or '"image"' not in content:
        return content

    try:
        blocks = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        return content
    if not isinstance(blocks, list):
        return content

    changed = False
    out: list[Any] = []
    for block in blocks:
        if isinstance(block, dict) and block.get("type") == "image" and block.get("base64"):
            out.append(_shrink_block(block))
            changed = True
        else:
            out.append(block)

    if not changed:
        return content
    return json.dumps(out, ensure_ascii=False)


__all__ = ["shrink_image_blocks"]
