"""Approval becomes a tri-state so a default gate can be switched off.

``requires_approval`` was NOT NULL with a ``false`` default, so a row's absence
meant "no opinion" and ``false`` meant the same thing. That is enough while every
gate defaults off — but prebuilt tools default **on** (``write_file``,
``edit_file``, ``task``, ``create_skill``), and turning one off has to be
storable as a real choice rather than a missing row.

After this, ``NULL`` means "follow the baseline", ``true`` means the user gated
it, and ``false`` means the user cleared a gate the baseline sets. The existing
``false`` rows all pre-date any gate-able default, so they mean "no opinion" and
are backfilled to ``NULL`` — the meaning they actually carried.

Locked gates (``execute``) are unaffected: they are merged after every user
choice at build time and cannot be cleared from here.

Revision ID: 0023_tool_approval_tristate

The id is deliberately short: ``alembic_version.version_num`` is varchar(32),
so a longer slug fails the version bump *after* the DDL has run.
Revises: 0022_tool_approval
"""

from alembic import op
import sqlalchemy as sa

revision = "0023_tool_approval_tristate"
down_revision = "0022_tool_approval"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "user_agent_tool_prefs",
        "requires_approval",
        existing_type=sa.Boolean(),
        nullable=True,
        server_default=None,
    )
    # Every existing `false` was written when it was the column default and
    # meant "no opinion"; NULL is now how that is spelled.
    op.execute("UPDATE user_agent_tool_prefs SET requires_approval = NULL WHERE requires_approval = false")
    # A row carrying neither axis is now meaningless.
    op.execute("DELETE FROM user_agent_tool_prefs WHERE state IS NULL AND requires_approval IS NULL")


def downgrade() -> None:
    # `false` and NULL collapse back to the same meaning.
    op.execute("UPDATE user_agent_tool_prefs SET requires_approval = false WHERE requires_approval IS NULL")
    op.alter_column(
        "user_agent_tool_prefs",
        "requires_approval",
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.text("false"),
    )
