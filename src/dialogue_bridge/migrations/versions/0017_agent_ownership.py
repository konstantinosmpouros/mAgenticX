"""add agent ownership (user-authored agents)

Revision ID: 0017_agent_ownership
Revises: 0016_retire_enabled_tools
Create Date: 2026-08-11

Agents were platform-only: every row came from the agents-service manifest and
``slug`` was globally unique. A user can now author their own agent, whose
definition lives in their workspace at
``/var/magenticx/workspaces/users/<user>/custom_agents/<slug>/agent.yaml``.

- ``owner_user_id`` — NULL for a platform agent, set for a user-authored one.
  ``ON DELETE CASCADE``: deleting a user takes their agents with them.
- Uniqueness moves from "slug is globally unique" to two rules:
  * ``(owner_user_id, slug)`` unique — one slug per owner.
  * a **partial** unique index on ``slug WHERE owner_user_id IS NULL`` — platform
    slugs stay globally unique. This half cannot be expressed as a plain
    constraint because Postgres permits unlimited NULLs in a unique index, so
    the composite rule alone would let two platform agents share a slug.

Hand-written on purpose: ``alembic revision --autogenerate`` silently ignores
``postgresql_where``, so the partial index would have been dropped from the
generated migration.

Non-destructive: one nullable column plus index changes. Existing rows are all
platform agents and keep ``owner_user_id IS NULL``, so the partial index
reproduces exactly the constraint being dropped.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0017_agent_ownership"
down_revision: Union[str, None] = "0016_retire_enabled_tools"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("owner_user_id", sa.String(), nullable=True))
    op.create_foreign_key(
        "fk_agents_owner_user_id_users",
        "agents",
        "users",
        ["owner_user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_agents_owner_user_id", "agents", ["owner_user_id"])

    # Replace the global unique constraint with the two owner-aware rules. Order
    # matters: create the partial index before dropping the old constraint so
    # platform slugs are never briefly unprotected.
    op.create_index(
        "uq_agents_global_slug",
        "agents",
        ["slug"],
        unique=True,
        postgresql_where=sa.text("owner_user_id IS NULL"),
    )
    op.drop_constraint("uq_agents_slug", "agents", type_="unique")
    op.create_unique_constraint("uq_agents_owner_slug", "agents", ["owner_user_id", "slug"])


def downgrade() -> None:
    # Reverting requires that no user-authored agents exist — a global unique
    # constraint on slug cannot hold once two users own the same slug. Fail
    # loudly rather than deleting somebody's agent to make the schema fit.
    conn = op.get_bind()
    owned = conn.execute(
        sa.text("SELECT count(*) FROM agents WHERE owner_user_id IS NOT NULL")
    ).scalar()
    if owned:
        raise RuntimeError(
            f"Cannot downgrade: {owned} user-authored agent(s) exist. Remove them "
            "first — this downgrade will not delete user data."
        )

    op.drop_constraint("uq_agents_owner_slug", "agents", type_="unique")
    op.create_unique_constraint("uq_agents_slug", "agents", ["slug"])
    op.drop_index("uq_agents_global_slug", table_name="agents")
    op.drop_index("ix_agents_owner_user_id", table_name="agents")
    op.drop_constraint("fk_agents_owner_user_id_users", "agents", type_="foreignkey")
    op.drop_column("agents", "owner_user_id")
