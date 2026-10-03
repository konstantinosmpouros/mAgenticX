"""Every alembic revision id must fit the column alembic stores it in.

``alembic_version.version_num`` is ``varchar(32)``. A longer id passes every
unit test — the migration's own DDL runs fine — and fails only on the last
statement of a real upgrade, when alembic stamps the new id. Postgres rolls the
whole migration back, so the bridge crash-loops on boot. That is exactly what
``0027_user_preferences_improve_model`` (35 characters) did locally.

The check is static: it reads the files, so it needs no database.
"""
from __future__ import annotations

import re
from pathlib import Path

VERSIONS = Path(__file__).resolve().parents[2] / "magenticx" / "dialogue_bridge" / "core" / "database" / "migrations" / "versions"
_REVISION = re.compile(r'^revision(?:\s*:\s*str)?\s*=\s*["\']([^"\']+)["\']', re.M)
ALEMBIC_VERSION_NUM_LENGTH = 32


def test_every_revision_id_fits_alembic_version_num():
    files = sorted(VERSIONS.glob("*.py"))
    assert files, f"no migrations found under {VERSIONS}"
    too_long = {}
    for path in files:
        match = _REVISION.search(path.read_text(encoding="utf-8"))
        assert match, f"{path.name} declares no revision id"
        if len(match.group(1)) > ALEMBIC_VERSION_NUM_LENGTH:
            too_long[path.name] = len(match.group(1))
    assert too_long == {}, f"revision ids longer than {ALEMBIC_VERSION_NUM_LENGTH} chars: {too_long}"
