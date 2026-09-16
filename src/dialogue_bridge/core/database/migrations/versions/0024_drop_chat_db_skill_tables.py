"""Drop the chat_db skill tables — skills live in agent_runtime now.

Skills used to exist twice: as directories on the agents volume and as rows
here, with a 900-second loop reading, hashing and reconciling both for every
user whether or not anything had changed. They now live in ``agent_runtime``,
the database the agents service owns and reads on every run, and the bridge
reaches them over the internal hop the way the Memories tab already does.

These four tables therefore have **no readers and no writers left**: the bridge
stopped writing them, its skill reads go upstream, and the sync no longer plans
or adopts skills at all.

**This is destructive and cannot be undone.** It is safe only because the
content was dummy data in every environment, confirmed before the change, and
because ``agent_runtime`` has been the sole source for skills since the mount
was rewired. ``downgrade`` recreates the shape but cannot recover a single row.

Revision ID: 0024_drop_chat_db_skill_tables
Revises: 0023_tool_approval_tristate
"""
from alembic import op
import sqlalchemy as sa

revision = "0024_drop_chat_db_skill_tables"
down_revision = "0023_tool_approval_tristate"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Child tables first: user_skill_files FKs user_skills.
    op.drop_table("user_skill_files")
    op.drop_table("user_skills")
    op.drop_table("user_agent_skills")
    op.drop_table("user_skill_pool")


def downgrade() -> None:
    """Recreate the empty shape.

    Structure only — the rows are gone. A downgrade past this point leaves the
    bridge with tables nothing populates, which is why the code that read them
    was deleted rather than left behind a flag.
    """
    op.create_table(
        "user_skill_pool",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("skill_name", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False, server_default="custom"),
        sa.Column("source_path", sa.String(), nullable=False, server_default=""),
        sa.Column("category", sa.String(), nullable=False, server_default=""),
        sa.Column("added_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_skill_pool_user_id", "user_skill_pool", ["user_id"])

    op.create_table(
        "user_agent_skills",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("agent_slug", sa.String(), nullable=False),
        sa.Column("skill_name", sa.String(), nullable=False),
        sa.Column("assigned_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_agent_skills_user_id", "user_agent_skills", ["user_id"])
    op.create_index("ix_user_agent_skills_agent_slug", "user_agent_skills", ["agent_slug"])

    op.create_table(
        "user_skills",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False, server_default=""),
        sa.Column("category", sa.String(), nullable=False, server_default=""),
        sa.Column("origin", sa.String(), nullable=False, server_default="user"),
        sa.Column("created_by_agent", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_skills_user_id", "user_skills", ["user_id"])

    op.create_table(
        "user_skill_files",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("skill_id", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["skill_id"], ["user_skills.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_skill_files_skill_id", "user_skill_files", ["skill_id"])
