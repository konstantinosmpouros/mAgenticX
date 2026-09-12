"""Per-(user, agent, tool) approval gates.

The Agents tab's Approvals section could only ever *show* the five gates the
platform mandates; there was no way to add a sixth. The capability existed in
the agents service the whole time — ``_HITL_FLOOR`` is a minimum ("a user may
add gates, never remove a mandated one") and ``AgentSpec.hitl`` is an open
map — but nothing in the product could write to it, and the builder hardcoded
the map to exactly the floor.

The gate belongs on this table rather than in the agent's definition because it
is a per-user choice about a shared agent: a platform agent like ``omni`` cannot
be edited, so a definition-level gate could never cover it. This is the same
shape as the on/off overrides already here — written through the bridge, carried
to the agent on the run config, no copy on the volume to reconcile.

It is a **second axis**, not another ``state`` value: a tool can be switched on
*and* gated, so the two facts have to be expressible at once. Hence a separate
boolean, and hence ``state`` becoming nullable — a row may now exist purely to
carry an approval gate, with no on/off opinion at all.

Additive and safe against live data: one new column with a server default, and
one constraint *relaxed*. Existing rows get ``requires_approval = false``, which
is exactly their behaviour today. Nothing is dropped and no value is rewritten.

Revision ID: 0022_tool_approval

The id is deliberately short: ``alembic_version.version_num`` is varchar(32),
so a longer slug fails the version bump *after* the DDL has run.
Revises: 0021_agent_tool_prefs
"""

from alembic import op
import sqlalchemy as sa

revision = "0022_tool_approval"
down_revision = "0021_agent_tool_prefs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_agent_tool_prefs",
        sa.Column(
            "requires_approval",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    # A row may now carry only an approval gate, with no enable/disable opinion.
    op.alter_column(
        "user_agent_tool_prefs",
        "state",
        existing_type=sa.String(),
        nullable=True,
    )


def downgrade() -> None:
    # Rows that exist only for an approval gate have no `state` to fall back to,
    # and the column is about to be NOT NULL again — drop those rows first or the
    # ALTER fails. They carry no on/off choice, so nothing a user set is lost
    # beyond the gate this migration introduced.
    op.execute("DELETE FROM user_agent_tool_prefs WHERE state IS NULL")
    op.alter_column(
        "user_agent_tool_prefs",
        "state",
        existing_type=sa.String(),
        nullable=False,
    )
    op.drop_column("user_agent_tool_prefs", "requires_approval")
