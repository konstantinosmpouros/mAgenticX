"""Persist user-authored agents and skills in chat_db.

Custom agent definitions and custom skills lived only on the agents-service
volume, which has no backup: losing it destroyed content no ``pg_dump`` could
recover, and left ``agents`` rows pointing at nothing. These tables make
Postgres the source of truth; the volume becomes a materialised cache the
agents service rebuilds on boot.

Additive only — no existing table is touched and nothing is dropped, so this is
safe to apply against live data. Back-filling the rows from what is already on
the volume is done by the reconciliation pass at agents-service boot, not here:
the migration cannot reach the volume, and a two-way sync is needed for the
memory work regardless.

Revision ID: 0019_persist_user_content

The id is deliberately short: ``alembic_version.version_num`` is varchar(32),
so a longer slug fails the version bump *after* the DDL has run.
Revises: 0018_retire_prefers_agentic_chat
"""

from alembic import op
import sqlalchemy as sa

revision = "0019_persist_user_content"
down_revision = "0018_retire_prefers_agentic_chat"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- Part A: the agent definition ------------------------------------
    # The spec the builder submitted. Nullable because platform agents keep
    # their definition in the image; only user-authored rows carry one.
    op.add_column("agents", sa.Column("definition_spec", sa.JSON(), nullable=True))
    op.create_table(
        "agent_definition_files",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("agent_id", "path", name="uq_agent_definition_files_path"),
    )
    op.create_index(
        op.f("ix_agent_definition_files_agent_id"),
        "agent_definition_files",
        ["agent_id"],
    )

    # --- Part B: custom skills + the two selection tables ----------------
    op.create_table(
        "user_skills",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), server_default="", nullable=False),
        sa.Column("category", sa.String(), nullable=True),
        sa.Column("origin", sa.String(), server_default="user", nullable=False),
        sa.Column("created_by_agent", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "name", name="uq_user_skills_name"),
    )
    op.create_index(op.f("ix_user_skills_user_id"), "user_skills", ["user_id"])

    op.create_table(
        "user_skill_files",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("skill_id", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["skill_id"], ["user_skills.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("skill_id", "path", name="uq_user_skill_files_path"),
    )
    op.create_index(op.f("ix_user_skill_files_skill_id"), "user_skill_files", ["skill_id"])

    op.create_table(
        "user_skill_pool",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("skill_name", sa.String(), nullable=False),
        sa.Column("type", sa.String(), server_default="custom", nullable=False),
        sa.Column("source_path", sa.String(), server_default="", nullable=False),
        sa.Column("category", sa.String(), server_default="", nullable=False),
        sa.Column("added_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "skill_name", name="uq_user_skill_pool_name"),
    )
    op.create_index(op.f("ix_user_skill_pool_user_id"), "user_skill_pool", ["user_id"])

    op.create_table(
        "user_agent_skills",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("agent_slug", sa.String(), nullable=False),
        sa.Column("skill_name", sa.String(), nullable=False),
        sa.Column("assigned_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "agent_slug", "skill_name", name="uq_user_agent_skills"
        ),
    )
    op.create_index(op.f("ix_user_agent_skills_user_id"), "user_agent_skills", ["user_id"])
    op.create_index(
        op.f("ix_user_agent_skills_agent_slug"), "user_agent_skills", ["agent_slug"]
    )


def downgrade() -> None:
    # Dropping these loses every custom agent definition and custom skill that
    # has not also been materialised to the volume. Kept for completeness of the
    # chain; do not run it against an environment that has cut over to Postgres
    # as the source of truth.
    op.drop_index(op.f("ix_user_agent_skills_agent_slug"), table_name="user_agent_skills")
    op.drop_index(op.f("ix_user_agent_skills_user_id"), table_name="user_agent_skills")
    op.drop_table("user_agent_skills")

    op.drop_index(op.f("ix_user_skill_pool_user_id"), table_name="user_skill_pool")
    op.drop_table("user_skill_pool")

    op.drop_index(op.f("ix_user_skill_files_skill_id"), table_name="user_skill_files")
    op.drop_table("user_skill_files")

    op.drop_index(op.f("ix_user_skills_user_id"), table_name="user_skills")
    op.drop_table("user_skills")

    op.drop_index(
        op.f("ix_agent_definition_files_agent_id"), table_name="agent_definition_files"
    )
    op.drop_table("agent_definition_files")
    op.drop_column("agents", "definition_spec")
