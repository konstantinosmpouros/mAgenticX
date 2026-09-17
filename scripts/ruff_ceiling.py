"""Fail when ruff findings rise above the agreed ceiling.

The backend's counterpart to the frontend's `npm run lint:ceiling`. The point is
not to reach zero in one sweep — 1,200 of the current findings are typing
modernisation (`UP006`/`UP045`) that belongs in its own reviewed change. The
point is that the number can only go **down**: a new finding fails the check,
and whenever the count drops the ceiling is lowered to lock the gain in.

    python scripts/ruff_ceiling.py          # check against CEILING
    python scripts/ruff_ceiling.py --update # rewrite CEILING to the current count

`--update` refuses to raise the ceiling. Raising it is a decision, not a script
run: edit the constant by hand and say why in the commit.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

#: Lower this whenever the count drops. Never raise it without a written reason.
CEILING = 1160

_SELF = Path(__file__).resolve()
_REPO_ROOT = _SELF.parent.parent


def count_findings() -> int:
    """Number of ruff findings across the linted tree."""
    result = subprocess.run(
        [sys.executable, "-m", "ruff", "check", "magenticx", "tests", "--output-format", "concise"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        # Explicit, not the locale default: ruff emits UTF-8, and on a Windows
        # console defaulting to a legacy code page (cp1253 here) decoding the
        # findings — which quote source containing en dashes — raised
        # UnicodeDecodeError and left stdout None.
        encoding="utf-8",
        errors="replace",
    )
    # ruff exits 1 when it has findings and 2 on a usage/config error. Only the
    # latter is a failure of this script rather than a result to report.
    if result.returncode not in (0, 1):
        sys.stderr.write(result.stderr or "ruff failed to run\n")
        raise SystemExit(2)
    return sum(1 for line in result.stdout.splitlines() if line.strip())


def update_ceiling(current: int) -> int:
    """Rewrite CEILING to ``current``, refusing to raise it."""
    if current > CEILING:
        sys.stderr.write(
            f"Refusing to raise the ceiling ({CEILING} -> {current}). "
            "Fix the new findings, or edit CEILING by hand and justify it.\n"
        )
        raise SystemExit(1)
    if current == CEILING:
        print(f"Ceiling already at {CEILING}.")
        return 0
    text = _SELF.read_text(encoding="utf-8")
    _SELF.write_text(
        re.sub(r"^CEILING = \d+$", f"CEILING = {current}", text, count=1, flags=re.MULTILINE),
        encoding="utf-8",
    )
    print(f"Ceiling lowered {CEILING} -> {current}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="lower CEILING to the current count")
    args = parser.parse_args()

    current = count_findings()
    if args.update:
        return update_ceiling(current)

    if current > CEILING:
        sys.stderr.write(
            f"ruff: {current} findings, ceiling is {CEILING} — {current - CEILING} new.\n"
            "Run `ruff check src tests` to see them.\n"
        )
        return 1
    if current < CEILING:
        print(
            f"ruff: {current} findings, below the {CEILING} ceiling. "
            "Run with --update to lock the gain in."
        )
        return 0
    print(f"ruff: {current} findings, at the ceiling.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
