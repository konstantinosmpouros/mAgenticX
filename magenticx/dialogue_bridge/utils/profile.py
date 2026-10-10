"""Edit profile: the name and the photo the app shows for a user.

Microsoft owns ``users.display_name`` — every sign-in rewrites it from the
token's ``name`` claim — so the user's own choice is kept in
``users.preferred_name`` and wins whenever it is set (``UserTable.shown_name``).
Clearing it goes back to Microsoft's name.

Microsoft sends no photo, so a photo is always the user's upload. It is never
stored as sent: the bytes are decoded, checked to be a PNG, JPEG or WebP,
cropped to a square and re-encoded as a small WebP. That drops every byte the
user did not see — EXIF (location, camera), embedded profiles, a script
smuggled in a polyglot file — and bounds what is stored and served.
"""
from __future__ import annotations

import asyncio
import io
from datetime import datetime, timezone

from fastapi import HTTPException, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.parked import parked_sessions
from core.database import UserAvatarTable, UserTable
from core.logging import get_logger
from core.settings import settings
from utils.auth import load_user

logger = get_logger(__name__)

#: What a stored avatar is, always.
AVATAR_MIME = "image/webp"

# Decoded formats a photo may arrive in. Pillow names, not MIME types: the
# format is read from the bytes, never from the client's Content-Type.
_ACCEPTED_FORMATS = frozenset({"PNG", "JPEG", "WEBP"})

_NOT_AN_IMAGE = "Use a PNG, JPEG or WebP image."


class AvatarRejected(ValueError):
    """The upload is not an image we accept; the message is safe to show."""


async def _require_user(db: AsyncSession, user_id: str) -> UserTable:
    user = await load_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return user


async def update_preferred_name(db: AsyncSession, user_id: str, name: str | None) -> UserTable:
    """Save (or clear, with ``None``) the user's chosen name and return the user.

    ``name`` arrives validated and normalized by ``schema.ProfileUpdate``.
    """
    user = await _require_user(db, user_id)
    user.preferred_name = name
    await db.commit()
    await db.refresh(user)
    # The name itself is personal data: log only that it changed, and how.
    logger.info("profile_name_updated", "A user changed the name the app shows", reset=name is None)
    return user


async def read_capped_upload(upload: UploadFile) -> bytes:
    """The upload's bytes, refused (413) as soon as they pass the cap.

    Read in chunks so an oversized body is never buffered whole.
    """
    cfg = settings.profile
    buffer = bytearray()
    while chunk := await upload.read(cfg.avatar_read_chunk_bytes):
        buffer.extend(chunk)
        if len(buffer) > cfg.avatar_max_upload_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=f"The photo is too large (max {cfg.avatar_max_upload_bytes // (1024 * 1024)} MB).",
            )
    return bytes(buffer)


def reencode_avatar(raw: bytes) -> bytes:
    """Decode ``raw`` and return a fresh square WebP, or raise :class:`AvatarRejected`.

    CPU-bound and synchronous — call it through ``asyncio.to_thread``.
    """
    cfg = settings.profile
    try:
        with Image.open(io.BytesIO(raw)) as probe:
            if probe.format not in _ACCEPTED_FORMATS:
                raise AvatarRejected(_NOT_AN_IMAGE)
            # Checked before decoding a single pixel: the header states the size.
            if probe.width * probe.height > cfg.avatar_max_pixels:
                raise AvatarRejected("The photo has too many pixels.")
            probe.load()
            image = ImageOps.exif_transpose(probe)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise AvatarRejected(_NOT_AN_IMAGE) from exc

    # A square from the middle, at the size the app shows; transparency kept.
    image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    side = cfg.avatar_size_px
    square = ImageOps.fit(image, (side, side), method=Image.Resampling.LANCZOS)
    out = io.BytesIO()
    # A new file holds only the pixels: no EXIF, ICC or XMP is copied over.
    square.save(out, format="WEBP", quality=85, method=4)
    return out.getvalue()


async def save_avatar(db: AsyncSession, user_id: str, raw: bytes) -> UserTable:
    """Re-encode and store the user's photo; returns the user (its new version)."""
    user = await _require_user(db, user_id)
    try:
        data = await asyncio.to_thread(reencode_avatar, raw)
    except AvatarRejected as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    existing = await db.get(UserAvatarTable, user_id)
    if existing is None:
        db.add(UserAvatarTable(user_id=user_id, data=data, mime=AVATAR_MIME, updated_at=now))
    else:
        existing.data, existing.mime, existing.updated_at = data, AVATAR_MIME, now
    user.avatar_updated_at = now
    await db.commit()
    await db.refresh(user)
    logger.info("profile_avatar_updated", "A user set a profile photo", stored_bytes=len(data))
    return user


async def remove_avatar(db: AsyncSession, user_id: str) -> UserTable:
    """Delete the user's photo (if any); the app goes back to initials."""
    user = await _require_user(db, user_id)
    await db.execute(delete(UserAvatarTable).where(UserAvatarTable.user_id == user_id))
    user.avatar_updated_at = None
    await db.commit()
    await db.refresh(user)
    logger.info("profile_avatar_removed", "A user removed their profile photo")
    return user


async def may_view_avatar(viewer_id: str, owner_id: str, device_id: str | None) -> bool:
    """A photo is shown to its owner, and to the accounts signed in on the same
    browser (the account switcher lists them) — to nobody else."""
    if viewer_id == owner_id:
        return True
    if not (settings.session.multi_account_enabled and device_id):
        return False
    return owner_id in await parked_sessions.list_user_ids(device_id)


async def load_avatar(db: AsyncSession, owner_id: str) -> UserAvatarTable | None:
    """The stored photo, or ``None``."""
    return (await db.execute(select(UserAvatarTable).where(UserAvatarTable.user_id == owner_id))).scalar_one_or_none()
