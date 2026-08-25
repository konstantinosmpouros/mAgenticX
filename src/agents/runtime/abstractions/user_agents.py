"""User-authored agent definitions — validate, write, read, delete.

A user's agents live in their own workspace, one folder per agent::

    <workspaces_root>/users/<user_id>/custom_agents/<slug>/
        agent.yaml          the AgentSpec document
        AGENT.md            the system prompt
        subagents/*.md      sub-agent prompts (optional)

The same :class:`~runtime.abstractions.agent_spec.AgentSpec` that governs built-in
agents governs these, so a user agent cannot express anything a platform agent
cannot. Everything security-relevant lives in :func:`validate_write`, because a
user-authored agent runs with *platform* credentials — the prompt is untrusted
user data, but the capability surface must stay platform-governed:

* **YAML is configuration, never code** — ``extra="forbid"`` on every spec model.
* **Models come from an allowlist** (``settings.registry.allowed_agent_models``),
  not free text, so a user cannot select something nonexistent or costly.
* **Native tools are validated** against the in-code registry.
* **HITL gates have a floor** — the dangerous builtins stay approval-gated no
  matter what the spec says. Without this, authoring an agent would be a
  one-line bypass of the confirmation gate on ``write_file``/``execute``.
* **Prompt paths are confined** to the agent's own folder and must resolve to a
  file included in the same request — no absolute paths, no traversal, no
  pointing at another agent's or another user's prompt.
* **Platform slugs are reserved** so a user agent can never be mistaken for a
  built-in (the runtime keeps the namespaces separate anyway, but a colliding
  slug would make the per-user tools endpoint ambiguous).
* **Quotas** cap agents per user, files, and bytes.

Writes are staged into a sibling temp directory and swapped into place, so a
failed or partial write never leaves a half-formed agent that discovery would
try to load.
"""
from __future__ import annotations

import base64
import binascii
import os
import shutil
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

import yaml

from core.settings import settings
from core.logging import get_logger
from runtime.abstractions.agent_spec import AgentSpec
from runtime.filesystem import layout
from runtime.skill_registry.user_registry import sync_agent_default_skills
from runtime.tools.registry import is_known_native_tool
from schema import AgentFile, UserAgentDetail, UserAgentSummary

logger = get_logger(__name__)

_MANIFEST_FILENAME = "agent.yaml"
# Approval gates a user's spec may add to but never remove. These are the tools
# whose misuse is irreversible or escapes the conversation.
_HITL_FLOOR: Tuple[str, ...] = ("write_file", "edit_file", "execute", "task")
# An agent folder is prompts + config only — no scripts, no binaries. Narrower
# than the skill allowlist on purpose.
_ALLOWED_EXTENSIONS = frozenset({".md", ".txt", ".yaml", ".yml"})
_MAX_FILES = 20
_MAX_FILE_BYTES = 256 * 1024            # 256 KiB — a prompt, not a payload
_MAX_TOTAL_BYTES = 1024 * 1024          # 1 MiB per agent
_MAX_PATH_DEPTH = 3


class AgentValidationError(ValueError):
    """A user-authored agent payload failed validation."""


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def _validate_relpath(raw_path: str) -> PurePosixPath:
    """Validate one agent-relative file path, or raise.

    Rejects absolute paths, ``..``/leading-dot segments, excessive depth, and
    anything outside the prompt/config extension allowlist. Backslashes are
    normalised so a Windows-authored path behaves the same.
    """
    cleaned = (raw_path or "").strip().replace("\\", "/").lstrip("/")
    parts = [seg for seg in cleaned.split("/") if seg not in ("", ".")]
    if not parts:
        raise AgentValidationError(f"Empty or invalid file path: {raw_path!r}")
    if len(parts) > _MAX_PATH_DEPTH:
        raise AgentValidationError(
            f"File path exceeds max depth {_MAX_PATH_DEPTH}: {raw_path!r}"
        )
    for seg in parts:
        try:
            layout.safe_segment(seg)
        except ValueError as exc:
            raise AgentValidationError(str(exc)) from exc
    if PurePosixPath(parts[-1]).suffix.lower() not in _ALLOWED_EXTENSIONS:
        raise AgentValidationError(
            f"File type not allowed for an agent definition: {parts[-1]}"
        )
    return PurePosixPath(*parts)


def _decode(file: AgentFile, rel_key: str) -> bytes:
    if file.encoding == "base64":
        try:
            return base64.b64decode(file.content, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise AgentValidationError(f"Invalid base64 content for {rel_key}") from exc
    return file.content.encode("utf-8")


def _normalise_prompt_ref(raw: str) -> Optional[str]:
    """A spec prompt reference (``./AGENT.md``) as a validated relative key.

    Returns ``None`` when the reference is not a usable in-folder path — an
    absolute path, a traversal attempt, or a disallowed type.
    """
    text = (raw or "").strip()
    if not text or text.startswith("/") or text.startswith("~"):
        return None
    try:
        return str(_validate_relpath(text))
    except AgentValidationError:
        return None


def validate_write(
    user_id: str,
    payload_spec: Dict[str, Any],
    files: List[AgentFile],
    *,
    reserved_slugs: frozenset[str],
    known_skills: frozenset[str],
    existing_slug: Optional[str] = None,
) -> Tuple[Optional[AgentSpec], List[str]]:
    """Validate a create/update payload. Returns ``(spec, errors)``.

    ``spec`` is the parsed :class:`AgentSpec` when everything passed, else
    ``None``. All errors are collected rather than raising on the first, so the
    builder UI can show every problem at once.

    ``existing_slug`` is the slug being updated — supplied so a rename is
    detected and rejected (the folder name is the slug; renaming is a
    delete-and-create, not an edit).
    """
    errors: List[str] = []

    # --- structural -------------------------------------------------------
    try:
        spec = AgentSpec.model_validate(payload_spec or {})
    except Exception as exc:  # pydantic ValidationError — surfaced verbatim
        return None, [f"Invalid agent definition: {exc}"]

    if existing_slug is not None and spec.slug != existing_slug:
        errors.append(
            f"An agent's slug cannot change ({existing_slug!r} → {spec.slug!r}); "
            "create a new agent instead."
        )

    # --- reserved / referential ------------------------------------------
    if spec.slug in reserved_slugs:
        errors.append(f"{spec.slug!r} is reserved by a built-in agent; choose another name.")

    allowed_models = frozenset(settings.registry.allowed_agent_models)
    errors.extend(
        spec.reference_errors(
            is_known_model=lambda m: m in allowed_models,
            is_known_native_tool=is_known_native_tool,
        )
    )

    for skill_name in spec.skills:
        if skill_name not in known_skills:
            errors.append(
                f"Skill {skill_name!r} is not in your skill pool — add it before "
                "assigning it to an agent."
            )

    # --- the HITL floor ---------------------------------------------------
    # A user may add gates, never remove a mandated one. Enforced server-side
    # because the builder UI is not the authority.
    missing_gates = [tool for tool in _HITL_FLOOR if not spec.hitl.get(tool, False)]
    if missing_gates:
        errors.append(
            "These tools must stay approval-gated: " + ", ".join(sorted(missing_gates))
        )

    # --- files ------------------------------------------------------------
    if len(files) > _MAX_FILES:
        errors.append(f"Too many files: {len(files)} > {_MAX_FILES}.")

    seen: Dict[str, bytes] = {}
    total = 0
    for item in files:
        try:
            rel = str(_validate_relpath(item.path))
            raw = _decode(item, rel)
        except AgentValidationError as exc:
            errors.append(str(exc))
            continue
        if rel == _MANIFEST_FILENAME:
            errors.append(
                f"{_MANIFEST_FILENAME} is generated from the definition — do not upload it."
            )
            continue
        if rel in seen:
            errors.append(f"Duplicate file path: {rel}")
            continue
        if len(raw) > _MAX_FILE_BYTES:
            errors.append(f"{rel} exceeds the {_MAX_FILE_BYTES // 1024} KiB per-file limit.")
            continue
        total += len(raw)
        seen[rel] = raw
    if total > _MAX_TOTAL_BYTES:
        errors.append(f"The definition exceeds the {_MAX_TOTAL_BYTES // 1024} KiB total limit.")

    # --- prompt references must resolve to an included file ---------------
    for label, raw_ref in [("prompt", spec.prompt), *[
        (f"sub-agent {sa.name!r} prompt", sa.prompt) for sa in spec.subagents
    ]]:
        rel = _normalise_prompt_ref(raw_ref)
        if rel is None:
            errors.append(
                f"The {label} must be a relative path inside the agent folder "
                f"(got {raw_ref!r})."
            )
        elif rel not in seen:
            errors.append(f"The {label} points at {rel!r}, which is not among the uploaded files.")

    return (spec if not errors else None), errors


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------
def _read_spec(manifest_path: Path) -> Optional[Dict[str, Any]]:
    try:
        return yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return None


def _summary_from_spec(raw: Dict[str, Any], slug: str) -> UserAgentSummary:
    return UserAgentSummary(
        id=str(raw.get("id") or slug),
        slug=slug,
        name=str(raw.get("name") or slug),
        version=str(raw.get("version") or ""),
        type="deep agent",
        description=str(raw.get("description") or ""),
        icon=str(raw.get("icon") or ""),
    )


def list_user_agents(user_id: str) -> List[UserAgentSummary]:
    """Every agent this user has authored. A folder whose manifest is missing or
    unreadable is skipped rather than failing the listing."""
    root = layout.user_custom_agents_root(user_id)
    if not root.is_dir():
        return []
    out: List[UserAgentSummary] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        raw = _read_spec(entry / _MANIFEST_FILENAME)
        if raw is None:
            logger.warning(
                "user_agent_unreadable",
                "Skipping a user agent whose manifest could not be read",
                agent_dir=str(entry),
            )
            continue
        out.append(_summary_from_spec(raw, entry.name))
    return out


def get_user_agent(user_id: str, slug: str) -> Optional[UserAgentDetail]:
    """One agent's full definition (spec + prompt files) for editing."""
    try:
        agent_dir = layout.user_custom_agent_dir(user_id, slug)
    except ValueError:
        return None
    raw = _read_spec(agent_dir / _MANIFEST_FILENAME)
    if raw is None:
        return None

    files: List[AgentFile] = []
    for path in sorted(agent_dir.rglob("*")):
        if not path.is_file() or path.name == _MANIFEST_FILENAME:
            continue
        rel = path.relative_to(agent_dir).as_posix()
        try:
            files.append(
                AgentFile(
                    path=rel,
                    content=path.read_text(encoding="utf-8"),
                    encoding="utf-8",
                    size=path.stat().st_size,
                )
            )
        except (OSError, UnicodeDecodeError):
            # Prompt folders are text-only; anything unreadable is reported as
            # empty rather than breaking the edit view.
            files.append(AgentFile(path=rel, content="", encoding="utf-8", size=0))

    summary = _summary_from_spec(raw, slug)
    return UserAgentDetail(**summary.model_dump(), spec=raw, files=files)


# ---------------------------------------------------------------------------
# Write / delete
# ---------------------------------------------------------------------------
def write_user_agent(user_id: str, spec: AgentSpec, files: List[AgentFile]) -> UserAgentSummary:
    """Write a validated agent folder, replacing any previous version atomically.

    Staged into a sibling ``.tmp`` directory and swapped in, so discovery never
    observes a half-written agent. Assumes :func:`validate_write` already passed —
    it does not re-validate.
    """
    agent_dir = layout.user_custom_agent_dir(user_id, spec.slug)
    staging = agent_dir.with_name(f".{spec.slug}.tmp")
    backup = agent_dir.with_name(f".{spec.slug}.old")

    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)

    # agent.yaml is generated from the validated spec, never taken from the
    # upload — so what runs is exactly what passed validation.
    (staging / _MANIFEST_FILENAME).write_text(
        yaml.safe_dump(spec.model_dump(mode="json"), sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    for item in files:
        rel = _validate_relpath(item.path)
        target = staging / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(_decode(item, str(rel)))

    agent_dir.parent.mkdir(parents=True, exist_ok=True)
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)
    replaced = agent_dir.exists()
    if replaced:
        os.replace(agent_dir, backup)
    try:
        os.replace(staging, agent_dir)
    except OSError:
        # Put the previous version back rather than leaving the user with nothing.
        if replaced:
            os.replace(backup, agent_dir)
        raise
    if replaced:
        shutil.rmtree(backup, ignore_errors=True)

    # Saving is the sync point for the agent's tier-① skills: resolve the spec's
    # declared `skills:` out of the user's pool into the read-only
    # `default_skills/` mount, so the agent ships with them and the per-agent
    # enable/disable endpoint (which only touches `skills/`) cannot remove them.
    # Deliberately after the folder swap — a failed sync must not roll back a
    # definition that is otherwise valid and written.
    synced = sync_agent_default_skills(
        user_id=user_id, agent_slug=spec.slug, skill_names=spec.skills
    )

    logger.info(
        "user_agent_written",
        "Wrote a user-authored agent definition",
        user_id=user_id,
        agent_slug=spec.slug,
        file_count=len(files),
        replaced=replaced,
        default_skills=len(synced),
    )
    return _summary_from_spec(spec.model_dump(mode="json"), spec.slug)


def delete_user_agent(user_id: str, slug: str) -> bool:
    """Remove an agent's definition folder. True when something was removed.

    Only the *definition* goes: the per-agent state tree (memory, enabled skills,
    conversation files) lives elsewhere and is retained, so deleting an agent
    never destroys conversation history.
    """
    try:
        agent_dir = layout.user_custom_agent_dir(user_id, slug)
    except ValueError:
        return False
    if not agent_dir.is_dir():
        return False
    shutil.rmtree(agent_dir)
    logger.info(
        "user_agent_deleted",
        "Removed a user-authored agent definition",
        user_id=user_id,
        agent_slug=slug,
    )
    return True


__all__ = [
    "AgentValidationError",
    "validate_write",
    "list_user_agents",
    "get_user_agent",
    "write_user_agent",
    "delete_user_agent",
]
