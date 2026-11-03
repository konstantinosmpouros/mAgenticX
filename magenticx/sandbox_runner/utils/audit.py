"""One structured audit record per ``/v1/exec`` call — including refusals (plan 11 §3.5).

The record identifies *who* (keyed-hash user id — correlates across services
through the shared redaction key, not re-identifiable from logs alone), *what*
(SHA-256 of the command plus a short control-free prefix), and *how it ended*
(exit code, duration, bytes written, truncation, kill reason). It never carries
the command's output or any file content.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Any

from core.logging import get_logger, hash_identifier
from core.settings import settings
from utils.output import safe_prefix

logger = get_logger("sandbox_runner.audit")


def command_digest(command: str) -> str:
    """SHA-256 of the exact command text (UTF-8)."""
    return hashlib.sha256(command.encode("utf-8", errors="replace")).hexdigest()


def audit_exec(
    *,
    outcome: str,
    user_id: str,
    agent_slug: str,
    conversation_id: str,
    command: str,
    workdir: str,
    level: int = logging.INFO,
    **fields: Any,
) -> None:
    """Emit the ``sandbox_exec`` audit event.

    ``outcome`` is one of ``completed`` / ``refused`` / ``unavailable`` /
    ``busy`` / ``failed``. Identity values may be malformed on a refusal, so
    they are hashed or capped before they reach the record.
    """
    logger.log(
        level,
        "sandbox_exec",
        "Sandbox exec audit record",
        outcome=outcome,
        user_id=hash_identifier(user_id),
        agent_slug=safe_prefix(agent_slug, 64),
        conversation_id=safe_prefix(conversation_id, 128),
        workdir=workdir,
        command_sha256=command_digest(command),
        command_prefix=safe_prefix(command, settings.logging.audit_command_prefix_chars),
        command_chars=len(command),
        **fields,
    )
