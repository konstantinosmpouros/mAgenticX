"""Per-(user, agent) tool overrides move into chat_db.

The Agents tab's per-agent tool toggles lived only in
``<agent_root>/tool_prefs.json`` on the agents-service volume, which has no
backup: losing it silently reverts every user's tool choices to the agent's
declared baseline — a change nobody is notified of and which looks like the
product forgetting a setting.

They belong here for the same reason ``use_memory``, ``search_past_convs`` and
``personalization`` already do: they are user preferences about how an agent
behaves, the user writes them through the bridge, and they reach the agent by
riding the run config. Unlike custom agents and skills, there is nothing for the
volume to hold — so this table has no materialised copy and needs no
reconciliation.

One row per override rather than the file's two arrays: a toggle becomes a
single write instead of a read-modify-write of the whole document, and "who
disabled this tool" becomes answerable.

Additive only — one new table, nothing dropped, safe against live data. The
handful of existing ``tool_prefs.json`` files are adopted lazily by the bridge
the first time each (user, agent) pair's tool list is opened; the migration
cannot reach the volume.

Revision ID: 0021_agent_tool_prefs

The id is deliberately short: ``alembic_version.version_num`` is varchar(32),
so a longer slug fails the version bump *after* the DDL has run.
Revises: 0020_skill_pool_tombstone
"""

from alembic import op
import sqlalchemy as sa

revision = "0021_agent_tool_prefs"
down_revision = "0020_skill_pool_tombstone"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_agent_tool_prefs",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        # The agent SLUG, not agents.id: the pairing is meaningful for platform
        # agents too, and the slug is the stable identifier for it.
        sa.Column("agent_slug", sa.String(), nullable=False),
        # Canonical tool-cache-key: "<server>/<tool>" for MCP, the bare name for
        # native. Stored verbatim — it is matched against live tools by this
        # exact string.
        sa.Column("tool_key", sa.String(), nullable=False),
        # 'disabled' | 'enabled'
        sa.Column("state", sa.String(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "agent_slug", "tool_key", name="uq_user_agent_tool_prefs"
        ),
    )
    op.create_index(
        op.f("ix_user_agent_tool_prefs_user_id"),
        "user_agent_tool_prefs",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_user_agent_tool_prefs_agent_slug"),
        "user_agent_tool_prefs",
        ["agent_slug"],
        unique=False,
    )


def downgrade() -> None:
    # Drops every stored override. Harmless only because the volume copy still
    # exists at the time this ships; once the agents service stops writing the
    # file, a downgrade loses the user's tool choices for real.
    op.drop_index(
        op.f("ix_user_agent_tool_prefs_agent_slug"), table_name="user_agent_tool_prefs"
    )
    op.drop_index(
        op.f("ix_user_agent_tool_prefs_user_id"), table_name="user_agent_tool_prefs"
    )
    op.drop_table("user_agent_tool_prefs")
