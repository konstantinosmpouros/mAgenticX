"""Drop the chat_db copy of agent definitions — they live in agent_runtime now.

A custom agent's definition existed twice: as ``agents.definition_spec`` plus
``agent_definition_files`` here, and as a folder on the agents volume, with a
900-second per-user pass hashing both to keep them agreeing. It now lives once,
in ``agent_runtime``, which the agents service owns and reads on every run.

What stays is the **catalog row** in ``agents`` — id, slug, name, icon,
``owner_user_id``, ``is_active``. The bridge lists and routes agents on every
page load and conversations carry a foreign key to it, so that read must not
become a cross-service hop. An agent therefore lives in two places on purpose:
its identity here, its definition there.

**This is destructive and cannot be undone.** It is safe only because the
definitions in both environments are dummy (``nova`` plus test agents), because
``agent_runtime`` has been the sole source since the reads were rewired, and
because the reconciliation pass had already copied what existed into it before
being deleted. ``downgrade`` restores the shape but not a single row.

Revision ID: 0025_drop_agent_definition_copy
Revises: 0024_drop_chat_db_skill_tables
"""
from alembic import op
import sqlalchemy as sa

revision = "0025_drop_agent_definition_copy"
down_revision = "0024_drop_chat_db_skill_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Child first: agent_definition_files FKs agents.
    op.drop_table("agent_definition_files")
    op.drop_column("agents", "definition_spec")


def downgrade() -> None:
    """Recreate the empty shape.

    Structure only — the definitions are gone. A downgrade past this point
    leaves the bridge with a column and a table nothing populates, which is why
    the code that read them was deleted rather than left behind a flag.
    """
    op.add_column("agents", sa.Column("definition_spec", sa.JSON(), nullable=True))
    op.create_table(
        "agent_definition_files",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_agent_definition_files_agent_id", "agent_definition_files", ["agent_id"]
    )
