"""Request / response contract of ``POST /v1/exec`` (plan 11 §5).

Every field is validated before anything is spawned. The identity fields are
used for the audit record only — they never become a path: the box sees a fresh
per-call temp dir holding just the files sent in ``files`` (plan 36 keeps
conversation files in the database, not on a shared disk). ``workdir`` is an
enum, not a path.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from schema.files import MAX_FILES, FileIn, FileOut

# A user / conversation id: a UUID or another plain token. No dots, slashes or
# leading punctuation, so it can only ever be one path segment.
ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
# The agents service's own slug rule (harness/abstractions/agent_spec.py SLUG_RE).
SLUG_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
MAX_COMMAND_CHARS = 16000

KilledReason = Literal["timeout", "memory", "output_limit", "disk_limit", "error"]


class ExecRequest(BaseModel):
    """One command to run in a fresh box, bound to one conversation."""

    model_config = ConfigDict(extra="forbid")

    user_id: str = Field(..., pattern=ID_PATTERN)
    agent_slug: str = Field(..., max_length=64, pattern=SLUG_PATTERN)
    conversation_id: str = Field(..., pattern=ID_PATTERN)
    command: str = Field(..., min_length=1, max_length=MAX_COMMAND_CHARS)
    # Bounded above by the server ceiling (SANDBOX_MAX_WALL_SECONDS) in the
    # router, since the ceiling is a runtime setting.
    timeout_seconds: int | None = Field(None, ge=1)
    workdir: Literal["output", "input"] = "output"
    # The files the command needs (input/…, read-only in the box) and the
    # current output/ files it may update. Size caps are runtime settings and
    # are checked in utils/exec_service.py.
    files: list[FileIn] = Field(default_factory=list, max_length=MAX_FILES)

    @field_validator("command")
    @classmethod
    def _no_nul(cls, value: str) -> str:
        # A NUL cannot be passed in an argv element; refuse it here rather than
        # fail inside the docker CLI.
        if "\x00" in value:
            raise ValueError("command must not contain NUL bytes")
        if not value.strip():
            raise ValueError("command must not be blank")
        return value

    @field_validator("files")
    @classmethod
    def _unique_paths(cls, value: list[FileIn]) -> list[FileIn]:
        paths = [f.path for f in value]
        if len(set(paths)) != len(paths):
            raise ValueError("files must not repeat a path")
        # A file and a directory of the same name cannot both exist.
        prefixes = {p.rsplit("/", i)[0] for p in paths for i in range(1, p.count("/"))}
        if prefixes & set(paths):
            raise ValueError("a file path is also used as a directory")
        return value


class ExecResponse(BaseModel):
    """What happened. A failed or killed command is still a 200 with this body."""

    model_config = ConfigDict(extra="forbid")

    exit_code: int | None
    stdout: str
    stderr: str
    truncated: bool
    duration_ms: int = Field(..., ge=0)
    killed_reason: KilledReason | None = None
    # Every regular file under output/ that is new or whose bytes changed.
    files: list[FileOut] = Field(default_factory=list)
    # Some output files were left out (per-file / total caps, or a name that
    # breaks the path rule).
    files_truncated: bool = False
