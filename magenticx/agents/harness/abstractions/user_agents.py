"""User-authored agent definitions — validate, write, read, delete.

A user's agents are rows in ``agent_runtime``: the validated ``AgentSpec`` in
``agent_definitions`` and its authored files in ``agent_definition_files``. They
used to be a folder per agent on the volume *and* a copy in ``chat_db``, kept in
step by a reconciliation pass; this module now writes exactly one of them.

``agent.yaml`` is **never stored**. It is rendered from the spec whenever the
YAML form is wanted, so what runs is always exactly what passed validation — a
stale or uploaded manifest cannot describe an agent that no longer matches it.

The same :class:`~harness.abstractions.agent_spec.AgentSpec` that governs built-in
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

A save is **one transaction**: the spec and its files land together or not at
all. That replaces the staging-directory-and-rename dance the folder layout
needed, and it closes a gap that dance could not — a spec whose ``prompt:``
points at a file that was not written is an agent that fails to build, and
across two separate writes there was a window where exactly that was true.
"""
from __future__ import annotations

import base64
import binascii
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

from core.settings import settings
from core.logging import get_logger
from harness.abstractions.agent_spec import AgentSpec
from harness.agent_registry.store import MANIFEST_FILENAME, AgentDefinitionStore
from harness.filesystem import layout
from harness.memory import get_memory_pool
from harness.tools.registry import is_known_native_tool
from schema import AgentFile, UserAgentDetail, UserAgentSummary

logger = get_logger(__name__)

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
        if rel == MANIFEST_FILENAME:
            errors.append(
                f"{MANIFEST_FILENAME} is generated from the definition — do not upload it."
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
def _store() -> AgentDefinitionStore:
    """The definition store on this service's ``agent_runtime`` pool.

    Borrowed from the same accessor memory and skills use — one pool for one
    database, rather than another for two more tables.
    """
    return AgentDefinitionStore(get_memory_pool())


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


async def list_user_agents(user_id: str) -> List[UserAgentSummary]:
    """Every agent this user has authored."""
    return [
        _summary_from_spec(row["spec"], row["slug"])
        for row in await _store().list_specs(user_id)
    ]


async def get_user_agent(user_id: str, slug: str) -> Optional[UserAgentDetail]:
    """One agent's full definition (spec + authored files) for editing.

    ``agent.yaml`` is absent from ``files`` because it is never stored — the
    builder must not offer a generated manifest as an editable file, and
    :func:`validate_write` refuses one on the way back in.
    """
    loaded = await _store().get_definition(user_id, slug)
    if loaded is None:
        return None
    raw, stored = loaded

    files = [
        AgentFile(path=path, content=content, encoding=encoding, size=len(content))
        for path, (content, encoding) in sorted(stored.items())
    ]
    summary = _summary_from_spec(raw, slug)
    return UserAgentDetail(**summary.model_dump(), spec=raw, files=files)


# ---------------------------------------------------------------------------
# Write / delete
# ---------------------------------------------------------------------------
async def write_user_agent(
    user_id: str, spec: AgentSpec, files: List[AgentFile]
) -> UserAgentSummary:
    """Persist a validated definition, replacing any previous version.

    Assumes :func:`validate_write` already passed — it does not re-validate, but
    it does re-run the path check on the way in, because the value that reaches
    the database must be the one that was checked and not a second reading of
    the payload.

    The spec is stored as the **validated** model dump rather than the raw
    request, so what runs is exactly what passed validation. ``agent.yaml`` is
    not written anywhere; it is rendered from this spec when the YAML form is
    wanted.
    """
    staged: Dict[str, tuple[str, str]] = {}
    for item in files:
        rel = str(_validate_relpath(item.path))
        raw = _decode(item, rel)
        # Stored as text: the extension allowlist admits prompts and config
        # only, so there is no binary case to carry an encoding for.
        staged[rel] = (raw.decode("utf-8"), "utf-8")

    replaced = await _store().save(
        user_id, spec.slug, spec=spec.model_dump(mode="json"), files=staged
    )
    logger.info(
        "user_agent_written",
        "Wrote a user-authored agent definition",
        user_id=user_id,
        agent_slug=spec.slug,
        file_count=len(staged),
        replaced=replaced,
        declared_skills=len(spec.skills),
    )
    return _summary_from_spec(spec.model_dump(mode="json"), spec.slug)


async def delete_user_agent(user_id: str, slug: str) -> bool:
    """Remove an agent's definition. True when something was removed.

    Only the *definition* goes: the per-agent state — conversations, memory
    rows, tool preferences — is keyed separately and survives, so deleting an
    agent never destroys conversation history.
    """
    removed = await _store().delete(user_id, slug)
    if removed:
        logger.info(
            "user_agent_deleted",
            "Removed a user-authored agent definition",
            user_id=user_id,
            agent_slug=slug,
        )
    return removed


__all__ = [
    "AgentValidationError",
    "delete_user_agent",
    "get_user_agent",
    "list_user_agents",
    "validate_write",
    "write_user_agent",
]
