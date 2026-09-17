"""link auth identities: nullable vault_user_id + oidc_subject + auth_providers

Revision ID: 0014_link_identities
Revises: 0013_attachment_origin
Create Date: 2026-07-12

Enables one canonical ``users`` row per human across multiple login methods
(Vault userpass + Microsoft Entra OIDC), so the same person is never split into
two rows:

- ``vault_user_id`` becomes NULLABLE (an Entra-first user has no Vault id). It
  stays unique; Postgres permits many NULLs under a unique index.
- ``oidc_subject`` — new, nullable, unique: the Entra ``oid`` (immutable per user
  per tenant), the OIDC counterpart of ``vault_user_id``.
- ``auth_providers`` — new, nullable: comma-separated set of proven login methods
  ("vault", "entra") for the row, for observability. Backfilled to "vault" for
  every existing row (all pre-existing users came in via Vault).

Non-destructive: only relaxes a constraint and adds two columns; no data is
dropped. Existing rows keep their ``vault_user_id`` and gain ``auth_providers =
'vault'``.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0014_link_identities"
down_revision: Union[str, None] = "0013_attachment_origin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("oidc_subject", sa.String(), nullable=True))
    op.add_column("users", sa.Column("auth_providers", sa.String(), nullable=True))
    op.create_index(
        op.f("ix_users_oidc_subject"), "users", ["oidc_subject"], unique=True
    )
    # Relax vault_user_id: Entra-only users have no Vault id.
    op.alter_column(
        "users", "vault_user_id", existing_type=sa.String(), nullable=True
    )
    # Every pre-existing user authenticated via Vault.
    op.execute(
        "UPDATE users SET auth_providers = 'vault' "
        "WHERE vault_user_id IS NOT NULL AND auth_providers IS NULL"
    )


def downgrade() -> None:
    # Re-tightening requires every row to have a vault_user_id; Entra-only rows
    # (oidc_subject set, vault_user_id NULL) would violate NOT NULL, so drop them
    # first — they cannot exist under the old schema anyway.
    op.execute("DELETE FROM users WHERE vault_user_id IS NULL")
    op.alter_column(
        "users", "vault_user_id", existing_type=sa.String(), nullable=False
    )
    op.drop_index(op.f("ix_users_oidc_subject"), table_name="users")
    op.drop_column("users", "auth_providers")
    op.drop_column("users", "oidc_subject")
