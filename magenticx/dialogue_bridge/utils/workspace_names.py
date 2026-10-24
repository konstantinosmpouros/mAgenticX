"""The name an upload has in the agent's ``/conversation/input/`` folder (plan 43).

The agent reads a conversation's uploads straight from ``attachments``, by name,
and the history it is given points at those names. So the name is assigned
once, when the file is uploaded, stored (``attachments.workspace_name``) and
never changed — deleting an earlier message does not rename a later file.

The rule is the one the agents service applied when it copied uploads onto its
volume, so names the agent saw before still resolve:

* the file name made into one safe path segment (no slashes, control
  characters or leading dots — the characters the agents service refuses);
* the first file to hold a name keeps it; different bytes under a taken name
  become ``stem_1.ext``, ``stem_2.ext``, …;
* the same bytes under the same name reuse it — re-sending a file is no new file.

Migration 0042 holds a frozen copy of this rule for the backfill.
"""
from __future__ import annotations

import unicodedata

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, ConversationTable, MessageTable

#: Characters, not bytes: the agents service caps a whole path at 1024 bytes,
#: which this leaves ample room for even in four-byte characters.
MAX_NAME_CHARS = 200
_FALLBACK_NAME = "file"


def safe_workspace_name(file_name: str) -> str:
    """``file_name`` as one path segment the agents service accepts."""
    name = unicodedata.normalize("NFC", file_name or "")
    name = "".join("_" if char in "/\\" or not char.isprintable() else char for char in name)
    name = name.strip().lstrip(".").strip() or _FALLBACK_NAME
    if len(name) <= MAX_NAME_CHARS:
        return name
    stem, dot, ext = name.rpartition(".")
    if dot and stem and len(ext) < MAX_NAME_CHARS // 2:
        return f"{stem[:MAX_NAME_CHARS - len(ext) - 1]}.{ext}"
    return name[:MAX_NAME_CHARS]


class WorkspaceNames:
    """The names a conversation's uploads hold, and who holds each (by hash)."""

    def __init__(self, taken: dict[str, str | None] | None = None) -> None:
        self._taken: dict[str, str | None] = dict(taken or {})

    @classmethod
    async def load(cls, db: AsyncSession, conversation_id: str) -> WorkspaceNames:
        """The names already taken in ``conversation_id``, every branch included.

        Takes the conversation row ``FOR UPDATE`` first, so two messages posted
        at once cannot both claim the same free name.
        """
        await db.execute(
            select(ConversationTable.id).where(ConversationTable.id == conversation_id).with_for_update()
        )
        rows = await db.execute(
            select(AttachmentTable.workspace_name, AttachmentTable.content_sha256)
            .join(MessageTable, AttachmentTable.message_id == MessageTable.id)
            .where(
                MessageTable.conversation_id == conversation_id,
                AttachmentTable.origin == "upload",
                AttachmentTable.workspace_name.is_not(None),
            )
        )
        return cls({name: sha256 for name, sha256 in rows.all()})

    def assign(self, file_name: str, sha256: str | None) -> str:
        """The name for a new upload of ``file_name`` with these bytes."""
        name = safe_workspace_name(file_name)
        stem, dot, ext = name.rpartition(".")
        if not dot:
            stem, ext = name, ""
        suffix = f".{ext}" if ext else ""
        candidate, index = name, 0
        while candidate in self._taken:
            if sha256 is not None and self._taken[candidate] == sha256:
                return candidate
            index += 1
            candidate = f"{stem}_{index}{suffix}"
        self._taken[candidate] = sha256
        return candidate
