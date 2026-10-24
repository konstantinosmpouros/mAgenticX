"""Encryption at rest for conversation files — the checkpointer's key and cipher.

A file's bytes are the same kind of data as the checkpoints that mention them
(the agent's working state), so they get the same protection: AES (EAX) under
``LANGGRAPH_AES_KEY`` / ``LANGGRAPH_AES_KEY_FILE``, through the very cipher
LangGraph's ``EncryptedSerializer`` uses for the checkpoint blobs. One key, one
mechanism, one rotation story.

Without a key (local dev) the bytes are stored as they are — exactly what the
checkpointer does there. Every blob records which cipher wrote it, so turning
encryption on later keeps the older plaintext blobs readable.
"""
from __future__ import annotations

from functools import lru_cache

from langgraph.checkpoint.serde.base import CipherProtocol
from langgraph.checkpoint.serde.encrypted import EncryptedSerializer

from core.settings import settings

PLAINTEXT = "none"
_AES_KEY_LENGTHS = (16, 24, 32)


class FileCipher:
    """Encrypts on write, decrypts on read; plaintext when no key is configured."""

    def __init__(self, cipher: CipherProtocol | None) -> None:
        self._cipher = cipher

    @property
    def encrypted(self) -> bool:
        return self._cipher is not None

    def encrypt(self, data: bytes) -> tuple[str, bytes]:
        """``(cipher name, stored bytes)`` — the name is kept beside the bytes."""
        if self._cipher is None:
            return PLAINTEXT, data
        return self._cipher.encrypt(data)

    def decrypt(self, name: str, data: bytes) -> bytes:
        if name == PLAINTEXT:
            return data
        if self._cipher is None:
            raise RuntimeError(
                "A conversation file is encrypted but LANGGRAPH_AES_KEY is not configured."
            )
        return self._cipher.decrypt(name, data)


@lru_cache(maxsize=1)
def get_file_cipher() -> FileCipher:
    """The process-wide cipher, built from the checkpointer's key."""
    key = settings.checkpointer.aes_key.get_secret_value()
    if not key:
        return FileCipher(None)
    raw = key.encode()
    if len(raw) not in _AES_KEY_LENGTHS:
        raise ValueError("LANGGRAPH_AES_KEY must be 16, 24, or 32 bytes long.")
    return FileCipher(EncryptedSerializer.from_pycryptodome_aes(key=raw).cipher)
