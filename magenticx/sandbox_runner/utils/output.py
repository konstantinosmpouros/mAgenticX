"""Turn a box's stdout/stderr — attacker-controlled bytes — into safe model text.

The bytes are capped first (``CappedBuffer``), then decoded with explicit
error handling, then stripped of control characters (except newline and tab)
and of the Unicode bidirectional overrides that can make text read differently
from what it is. The result goes into a model's context, so it is treated the
way any untrusted input is.
"""
from __future__ import annotations

import re

# C0 controls except \t (0x09) and \n (0x0a), DEL, the C1 block, and the bidi
# embedding / override / isolate controls.
_UNSAFE_CHARS = re.compile("[\x00-\x08\x0b-\x1f\x7f\x80-\x9f‪-‮⁦-⁩]")


class CappedBuffer:
    """Accumulates up to ``cap`` bytes of a stream and counts everything seen."""

    def __init__(self, cap: int) -> None:
        self._cap = cap
        self._chunks: list[bytes] = []
        self._kept = 0
        self.seen = 0

    def feed(self, chunk: bytes) -> None:
        """Keep what fits under the cap; count the rest."""
        self.seen += len(chunk)
        room = self._cap - self._kept
        if room > 0:
            piece = chunk[:room]
            self._chunks.append(piece)
            self._kept += len(piece)

    @property
    def truncated(self) -> bool:
        return self.seen > self._kept

    def data(self) -> bytes:
        return b"".join(self._chunks)


def sanitize_output(raw: bytes) -> str:
    """Decode (invalid UTF-8 → U+FFFD) and strip unsafe control characters."""
    text = raw.decode("utf-8", errors="replace")
    return _UNSAFE_CHARS.sub("", text)


def safe_prefix(text: str, limit: int) -> str:
    """A short, single-line, control-free prefix for an audit record."""
    flat = _UNSAFE_CHARS.sub("", text.replace("\n", " ").replace("\t", " "))
    return flat[:limit]
