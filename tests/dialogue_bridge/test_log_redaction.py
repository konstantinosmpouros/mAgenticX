"""Log-safety invariants for values we emit verbatim.

Subprocess output is the one place the bridge logs a free-text blob it did not
compose itself, so the usual key-based redaction cannot help: the secret is
*inside* the value. These tests pin the two rules that make that safe — URL
credentials are masked, and the field names used for alembic output are not on
the content drop-list (naming them `output` silently discarded them, which is
how a failing migration came to log an empty `fields: {}`).
"""
from __future__ import annotations

import pytest

from observability import scrub_url_credentials
from observability.redaction import _should_drop_key, sanitize_for_logging


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "could not connect: postgresql+asyncpg://admin:sup3rs3cret@chat_postgres:5432/chat",
            "could not connect: postgresql+asyncpg://admin:***@chat_postgres:5432/chat",
        ),
        # No credentials to mask — must pass through untouched.
        ("postgresql://chat_postgres:5432/chat", "postgresql://chat_postgres:5432/chat"),
        ("plain text, nothing to do", "plain text, nothing to do"),
        # Every occurrence, not just the first.
        (
            "redis://u1:pw1@r:6379 and postgres://u2:pw2@p:5432",
            "redis://u1:***@r:6379 and postgres://u2:***@p:5432",
        ),
    ],
)
def test_scrub_url_credentials(raw: str, expected: str):
    assert scrub_url_credentials(raw) == expected


def test_scrub_url_credentials_leaves_no_password_behind():
    secret = "sup3rs3cret"
    assert secret not in scrub_url_credentials(
        f"postgresql+asyncpg://admin:{secret}@chat_postgres:5432/chat"
    )


def test_alembic_field_names_survive_sanitisation():
    """The regression that hid a failing migration: `output` is on the content
    drop-list, so the value was replaced and then filtered out entirely."""
    assert _should_drop_key("output") is True          # why the old name failed
    assert _should_drop_key("alembic_stderr") is False
    assert _should_drop_key("alembic_stdout") is False

    kept = sanitize_for_logging({"alembic_stderr": "FAILED: relation does not exist"})
    assert kept == {"alembic_stderr": "FAILED: relation does not exist"}

    dropped = sanitize_for_logging({"output": "FAILED: relation does not exist"})
    assert dropped == {}


def test_alembic_field_names_are_not_treated_as_secrets():
    """A name containing e.g. `token` would be [REDACTED] by the substring rule."""
    value = sanitize_for_logging({"alembic_stderr": "Running upgrade 0016 -> 0017"})
    assert value["alembic_stderr"] == "Running upgrade 0016 -> 0017"
