"""User-authored agent definitions — validate, write, read, delete, import, export.

A user's agents are rows in ``agent_runtime``: the validated ``AgentSpec`` in
``agent_definitions`` and its authored files in ``agent_definition_files``. They
used to be a folder per agent on the volume *and* a copy in ``chat_db``, kept in
step by a reconciliation pass; this module now writes exactly one of them.

``agent.yaml`` is **never stored**. It is rendered from the spec whenever the
YAML form is wanted (:func:`render_agent_yaml`, the export), so what runs is
always exactly what passed validation — a stale or uploaded manifest cannot
describe an agent that no longer matches it. An uploaded ``agent.yaml`` comes in
through :func:`parse_agent_yaml` and becomes a spec like any other.

The same :class:`~harness.abstractions.agent_spec.AgentSpec` that governs built-in
agents governs these, so a user agent cannot express anything a platform agent
cannot. Everything security-relevant lives in :func:`validate_definition`,
because a user-authored agent runs with *platform* credentials — the prompt is
untrusted user data, but the capability surface must stay platform-governed:

* **YAML is configuration, never code** — ``extra="forbid"`` on every spec model,
  and ``yaml.safe_load`` on the way in.
* **Models come from an allowlist** (``settings.registry.allowed_agent_models``),
  not free text, so a user cannot select something nonexistent or costly.
* **Tools are checked**: native tools against the in-code registry, MCP tools
  against the gateway's live catalog.
* **Approval gates are checked**: ``hitl`` may only name tools the agent has, may
  not gate a tool that is itself a pause (``ask_user``), and may not clear a
  locked gate (``execute``). Which of the rest ask is the user's choice — the
  builder saves it as their approval preferences, not here.
* **Prompt paths are confined** to the agent's own folder and must resolve to a
  file included in the same request — no absolute paths, no traversal, no
  pointing at another agent's or another user's prompt.
* **Platform slugs are reserved** so a user agent can never be mistaken for a
  built-in (the runtime keeps the namespaces separate anyway, but a colliding
  slug would make the per-user tools endpoint ambiguous).
* **Quotas** cap agents per user, files, bytes and text lengths.

Problems come back as :class:`~schema.AgentIssue` — each pinned to a path in the
spec (``subagents.0.subagents.1.name``) or a file (``files[AGENT.md]``) — so the
builder can mark the exact field rather than print one joined message.

A save is **one transaction**: the spec and its files land together or not at
all. That replaces the staging-directory-and-rename dance the folder layout
needed, and it closes a gap that dance could not — a spec whose ``prompt:``
points at a file that was not written is an agent that fails to build, and
across two separate writes there was a window where exactly that was true.
"""
from __future__ import annotations

import base64
import binascii
import io
import re
import unicodedata
import zipfile
from collections.abc import Iterator
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional, Tuple

import yaml
from pydantic import ValidationError

from core.logging import get_logger
from core.settings import settings
from harness.abstractions.agent_spec import MAX_SUBAGENT_DEPTH, SLUG_RE, AgentSpec
from harness.agent_registry.store import (
    MANIFEST_FILENAME,
    AgentDefinitionExistsError,
    AgentDefinitionStore,
)
from harness.filesystem import layout
from harness.memory import get_memory_pool
from harness.tools.builtins import BUILTIN_BY_NAME
from harness.tools.registry import is_known_native_tool
from schema import AgentFile, AgentIssue, UserAgentDetail, UserAgentSummary

logger = get_logger(__name__)

# An agent folder is prompts + config only — no scripts, no binaries. Narrower
# than the skill allowlist on purpose.
_ALLOWED_EXTENSIONS = frozenset({".md", ".txt", ".yaml", ".yml"})
_MAX_FILES = 20
_MAX_FILE_BYTES = 256 * 1024            # 256 KiB — a prompt, not a payload
_MAX_TOTAL_BYTES = 1024 * 1024          # 1 MiB per agent
_MAX_PATH_DEPTH = 3
_MAX_YAML_BYTES = 256 * 1024            # an uploaded agent.yaml

# Text limits, checked when a definition is written (never on load, so an agent
# saved before they existed still runs). A sub-agent's name is what the model
# calls it by and what the chat shows, so it gets the slug's shape.
_MAX_NAME_CHARS = 80
_MAX_DESCRIPTION_CHARS = 500
_MAX_SUBAGENT_NAME_CHARS = 48
_MAX_SUBAGENT_DESCRIPTION_CHARS = 1000

#: Where generated prompts go: the main agent's, and each sub-agent's under
#: ``subagents/`` named by its path (``subagents/researcher--fact-checker.md``) —
#: the layout the builder writes.
PROMPT_FILE = "AGENT.md"
SUBAGENT_DIR = "subagents"

#: The order :func:`render_agent_yaml` writes the keys in — the seed agent's.
_YAML_KEY_ORDER = (
    "id", "slug", "name", "version", "type", "description", "icon",
    "prompt", "model", "memory", "tools", "skills", "subagents", "hitl",
)
_SUBAGENT_KEY_ORDER = ("name", "description", "prompt", "model", "tools", "subagents")


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
    """The file's bytes, which must be UTF-8 text whatever the encoding."""
    if file.encoding == "base64":
        try:
            raw = base64.b64decode(file.content, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise AgentValidationError(f"Invalid base64 content for {rel_key}") from exc
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AgentValidationError(f"{rel_key} is not UTF-8 text.") from exc
        return raw
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


def _issue(path: str, message: str, severity: str = "error") -> AgentIssue:
    return AgentIssue(path=path, message=message, severity=severity)


def _raw_tool_key(ref: Any) -> Optional[str]:
    """``ToolRef.key()`` for a raw mapping, or ``None`` when it is malformed
    (the structural pass reports that)."""
    if not isinstance(ref, dict):
        return None
    if ref.get("native"):
        return f"native::{ref['native']}"
    if ref.get("server_id") and ref.get("tool_name"):
        return f"{ref['server_id']}::{ref['tool_name']}"
    return None


def _shown_tool(key: str) -> str:
    return key.replace("native::", "").replace("::", "/")


def _tree_issues(raw: Dict[str, Any]) -> List[AgentIssue]:
    """The sub-agent tree's rules, with the path of the node that breaks them.

    The same rules ``AgentSpec`` enforces — depth, unique sibling names, no name
    repeated down a branch, tools only narrowing — plus the write-time shape of
    a sub-agent (its name a slug, a description to be picked by), walked on the
    raw mapping so each problem names the node rather than the whole spec.
    """
    issues: List[AgentIssue] = []

    def check(nodes: Any, *, prefix: str, allowed: set[str], above: tuple[str, ...]) -> None:
        if not isinstance(nodes, list):
            return
        depth = len(above) + 1
        names = [n.get("name") for n in nodes if isinstance(n, dict)]
        for index, node in enumerate(nodes):
            if not isinstance(node, dict):
                continue
            here = f"{prefix}.{index}"
            name = node.get("name")
            label = " > ".join((*above, str(name or "?")))
            if depth > MAX_SUBAGENT_DEPTH:
                issues.append(_issue(
                    here,
                    f"Sub-agent {label!r} is {depth} levels below the agent; at most "
                    f"{MAX_SUBAGENT_DEPTH} are allowed.",
                ))
                continue
            if not isinstance(name, str) or not name.strip():
                issues.append(_issue(f"{here}.name", "A sub-agent needs a name."))
            else:
                if len(name) > _MAX_SUBAGENT_NAME_CHARS or not SLUG_RE.match(name):
                    issues.append(_issue(
                        f"{here}.name",
                        f"Sub-agent name {name!r} must be lowercase words joined by hyphens "
                        f"(e.g. fact-checker), at most {_MAX_SUBAGENT_NAME_CHARS} characters.",
                    ))
                if names.count(name) > 1:
                    issues.append(_issue(f"{here}.name", f"Two sub-agents here are named {name!r}."))
                if name in above:
                    issues.append(_issue(
                        f"{here}.name",
                        f"Sub-agent {label!r} repeats a name above it; sub-agents cannot loop.",
                    ))
            description = node.get("description")
            if not isinstance(description, str) or not description.strip():
                issues.append(_issue(
                    f"{here}.description",
                    "A sub-agent needs a description: it is how its agent decides to use it.",
                ))
            elif len(description) > _MAX_SUBAGENT_DESCRIPTION_CHARS:
                issues.append(_issue(
                    f"{here}.description",
                    f"Keep a sub-agent's description under {_MAX_SUBAGENT_DESCRIPTION_CHARS} characters.",
                ))
            own = {k for k in map(_raw_tool_key, node.get("tools") or []) if k}
            extra = sorted(own - allowed)
            if extra:
                whose = f"sub-agent {above[-1]!r}" if above else "the agent"
                issues.append(_issue(
                    f"{here}.tools",
                    f"Lists tools {whose} does not have: {', '.join(map(_shown_tool, extra))}. "
                    "A sub-agent can only use some of the tools of the agent above it.",
                ))
            check(
                node.get("subagents"),
                prefix=f"{here}.subagents",
                allowed=own or allowed,
                above=(*above, str(name)),
            )

    agent_tools = {k for k in map(_raw_tool_key, raw.get("tools") or []) if k}
    check(raw.get("subagents"), prefix="subagents", allowed=agent_tools, above=())
    return issues


def _top_level_issues(raw: Dict[str, Any]) -> List[AgentIssue]:
    issues: List[AgentIssue] = []
    name = raw.get("name")
    if isinstance(name, str):
        if not name.strip():
            issues.append(_issue("name", "The agent needs a name."))
        elif len(name) > _MAX_NAME_CHARS:
            issues.append(_issue("name", f"Keep the name under {_MAX_NAME_CHARS} characters."))
    description = raw.get("description")
    if isinstance(description, str) and len(description) > _MAX_DESCRIPTION_CHARS:
        issues.append(_issue(
            "description", f"Keep the description under {_MAX_DESCRIPTION_CHARS} characters."
        ))
    return issues


def _structural_issues(exc: ValidationError, *, tree_reported: bool) -> List[AgentIssue]:
    """Pydantic's errors as issues. A model-level error (empty ``loc``) is the
    slug or the tree validator; the tree's are already reported per node."""
    issues: List[AgentIssue] = []
    for err in exc.errors():
        message = str(err.get("msg", "")).removeprefix("Value error, ")
        loc = ".".join(str(part) for part in err.get("loc", ()))
        if not loc:
            if message.startswith("Invalid agent slug"):
                loc = "slug"
            elif tree_reported:
                continue
        elif err.get("type") == "missing":
            message = f"{loc.rsplit('.', 1)[-1]} is required."
        issues.append(_issue(loc, message))
    return issues


def walk_indexed(spec: AgentSpec) -> Iterator[Tuple[str, Tuple[str, ...], Any]]:
    """Every sub-agent at every depth with its spec path
    (``subagents.0.subagents.1``) and its name path."""
    def walk(nodes, prefix: str, above: tuple[str, ...]):
        for index, sa in enumerate(nodes):
            here = f"{prefix}.{index}"
            names = (*above, sa.name)
            yield here, names, sa
            yield from walk(sa.subagents, f"{here}.subagents", names)

    yield from walk(spec.subagents, "subagents", ())


def _reference_issues(
    spec: AgentSpec,
    *,
    known_skills: frozenset[str],
    known_mcp_tools: Optional[frozenset[str]],
    mcp_enabled: bool,
) -> List[AgentIssue]:
    issues: List[AgentIssue] = []
    allowed_models = frozenset(settings.registry.allowed_agent_models)

    def model_issue(path: str, model_id: Optional[str]) -> None:
        if model_id and model_id not in allowed_models:
            issues.append(_issue(path, f"{model_id!r} is not a model agents can use here."))

    model_issue("model.main", spec.model.main)
    for name, model_id in spec.model.subagents.items():
        model_issue(f"model.subagents.{name}", model_id)

    def tool_issues(prefix: str, tools) -> None:
        for index, ref in enumerate(tools):
            if ref.is_native and not is_known_native_tool(ref.native):
                issues.append(_issue(f"{prefix}.{index}", f"Unknown built-in tool {ref.native!r}."))

    tool_issues("tools", spec.tools)
    for path, _, sa in walk_indexed(spec):
        model_issue(f"{path}.model", sa.model)
        tool_issues(f"{path}.tools", sa.tools)

    # MCP tools: the gateway's live catalog is the authority. Down or off is a
    # warning, not an error — the run filters to the live tools anyway, and an
    # outage must not stop someone editing a prompt.
    mcp_refs = [(i, ref) for i, ref in enumerate(spec.tools) if not ref.is_native]
    if mcp_refs and not mcp_enabled:
        issues.append(_issue(
            "tools", "MCP tools are turned off on this deployment, so these won't load.", "warning"
        ))
    elif mcp_refs and known_mcp_tools is None:
        issues.append(_issue(
            "tools",
            "Couldn't reach the MCP gateway to check these tools; they're checked again when "
            "the agent runs.",
            "warning",
        ))
    elif mcp_refs:
        for index, ref in mcp_refs:
            if f"{ref.server_id}/{ref.tool_name}" not in known_mcp_tools:
                issues.append(_issue(
                    f"tools.{index}",
                    f"{ref.server_id}/{ref.tool_name} isn't offered by the MCP gateway; remove it "
                    "or pick another tool.",
                ))

    for index, skill_name in enumerate(spec.skills):
        if skill_name not in known_skills:
            issues.append(_issue(
                f"skills.{index}",
                f"Skill {skill_name!r} is not in your skill pool — add it before assigning it "
                "to an agent.",
            ))

    # Approval gates: only tools the agent has, never a pause, never clearing
    # a locked gate. Gates are keyed by bare tool name (``harness.tools.gates``).
    mcp_names = {ref.tool_name for ref in spec.tools if not ref.is_native}
    for tool_name, asks in spec.hitl.items():
        path = f"hitl.{tool_name}"
        builtin = BUILTIN_BY_NAME.get(tool_name)
        if builtin is None and tool_name not in mcp_names:
            issues.append(_issue(path, f"{tool_name!r} is not a tool this agent has."))
        elif builtin is not None and not builtin.gateable and asks:
            issues.append(_issue(path, f"{tool_name!r} is itself a question to you; it can't ask first."))
        elif builtin is not None and builtin.locked and not asks:
            issues.append(_issue(path, f"{tool_name!r} always asks for approval."))
    return issues


def _file_issues(files: List[AgentFile]) -> Tuple[Dict[str, bytes], List[AgentIssue]]:
    """Check the uploaded files; returns the accepted ones by relative path."""
    issues: List[AgentIssue] = []
    if len(files) > _MAX_FILES:
        issues.append(_issue("files", f"Too many files: {len(files)} > {_MAX_FILES}."))

    seen: Dict[str, bytes] = {}
    total = 0
    for item in files:
        try:
            rel = str(_validate_relpath(item.path))
            raw = _decode(item, rel)
        except AgentValidationError as exc:
            issues.append(_issue(f"files[{item.path}]", str(exc)))
            continue
        where = f"files[{rel}]"
        if rel == MANIFEST_FILENAME:
            issues.append(_issue(
                where, f"{MANIFEST_FILENAME} is generated from the definition — do not upload it."
            ))
            continue
        if rel in seen:
            issues.append(_issue(where, f"Duplicate file path: {rel}"))
            continue
        if len(raw) > _MAX_FILE_BYTES:
            issues.append(_issue(where, f"{rel} exceeds the {_MAX_FILE_BYTES // 1024} KiB per-file limit."))
            continue
        total += len(raw)
        seen[rel] = raw
    if total > _MAX_TOTAL_BYTES:
        issues.append(_issue("files", f"The definition exceeds the {_MAX_TOTAL_BYTES // 1024} KiB total limit."))
    return seen, issues


def validate_definition(
    user_id: str,
    payload_spec: Dict[str, Any],
    files: List[AgentFile],
    *,
    reserved_slugs: frozenset[str],
    known_skills: frozenset[str],
    existing_slug: Optional[str] = None,
    known_mcp_tools: Optional[frozenset[str]] = None,
    mcp_enabled: bool = False,
) -> Tuple[Optional[AgentSpec], List[AgentIssue]]:
    """Validate a create/update payload. Returns ``(spec, issues)``.

    ``spec`` is the parsed :class:`AgentSpec` when no issue is an error (warnings
    never block), else ``None``. Everything is collected rather than stopping at
    the first problem, so the builder can show them all at once.

    ``existing_slug`` is the slug being updated — supplied so a rename is
    detected and rejected (renaming is a delete-and-create, not an edit).
    ``known_mcp_tools`` is the gateway's catalog as ``server/tool`` keys, or
    ``None`` when it could not be read.
    """
    raw = payload_spec if isinstance(payload_spec, dict) else {}
    if not isinstance(payload_spec, dict):
        return None, [_issue("", "The definition must be a mapping of fields.")]

    # --- structural -------------------------------------------------------
    tree = _tree_issues(raw)
    issues = [*_top_level_issues(raw), *tree]
    try:
        spec = AgentSpec.model_validate(raw)
    except ValidationError as exc:
        issues.extend(_structural_issues(exc, tree_reported=bool(tree)))
        _, file_issues = _file_issues(files)
        return None, [*issues, *file_issues]

    if existing_slug is not None and spec.slug != existing_slug:
        issues.append(_issue(
            "slug",
            f"An agent's slug cannot change ({existing_slug!r} → {spec.slug!r}); create a new "
            "agent instead.",
        ))
    if spec.slug in reserved_slugs:
        issues.append(_issue("slug", f"{spec.slug!r} is reserved by a built-in agent; choose another name."))

    # --- referential ------------------------------------------------------
    issues.extend(_reference_issues(
        spec, known_skills=known_skills, known_mcp_tools=known_mcp_tools, mcp_enabled=mcp_enabled
    ))

    # --- files ------------------------------------------------------------
    seen, file_issues = _file_issues(files)
    issues.extend(file_issues)

    # --- prompt references must resolve to an included file ---------------
    # Every sub-agent's, at every depth (the tree's limits are AgentSpec's).
    refs = [("prompt", "prompt", spec.prompt)]
    refs += [
        (f"{path}.prompt", f"sub-agent {' > '.join(names)!r} prompt", sa.prompt)
        for path, names, sa in walk_indexed(spec)
    ]
    for path, label, raw_ref in refs:
        rel = _normalise_prompt_ref(raw_ref)
        if rel is None:
            issues.append(_issue(
                path, f"The {label} must be a relative path inside the agent folder (got {raw_ref!r})."
            ))
        elif rel not in seen:
            issues.append(_issue(path, f"The {label} points at {rel!r}, which is not among the uploaded files."))

    blocking = any(issue.severity == "error" for issue in issues)
    return (None if blocking else spec), issues


def errors_of(issues: List[AgentIssue]) -> List[str]:
    """The messages of the issues that block a save."""
    return [i.message for i in issues if i.severity == "error"]


def validate_write(
    user_id: str,
    payload_spec: Dict[str, Any],
    files: List[AgentFile],
    *,
    reserved_slugs: frozenset[str],
    known_skills: frozenset[str],
    existing_slug: Optional[str] = None,
) -> Tuple[Optional[AgentSpec], List[str]]:
    """:func:`validate_definition` with the blocking messages only, for callers
    that predate issues. MCP tools are not checked against the gateway here."""
    spec, issues = validate_definition(
        user_id,
        payload_spec,
        files,
        reserved_slugs=reserved_slugs,
        known_skills=known_skills,
        existing_slug=existing_slug,
        known_mcp_tools=None,
        mcp_enabled=True,
    )
    return spec, errors_of(issues)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
def model_label(model_id: str) -> str:
    """A model id as people say it: ``openai:gpt-4o-mini`` → ``GPT-4o mini``,
    ``openai:gpt-6-luna`` → ``GPT-6 Luna``."""
    name = model_id.split(":", 1)[-1]
    match = re.match(r"^(gpt)-([0-9][0-9a-z.]*)(.*)$", name)
    if match:
        rest = " ".join(
            word if word == "mini" else word.capitalize()
            for word in match.group(3).split("-") if word
        )
        return f"GPT-{match.group(2)}{' ' + rest if rest else ''}"
    return " ".join(word.capitalize() for word in re.split(r"[-_]", name) if word)


def agent_model_options() -> List[Dict[str, Any]]:
    """The models a user-authored agent may run on, in allowlist order, with the
    one the builder preselects: Omni's main model when it is allowed, else the
    first."""
    allowed = list(settings.registry.allowed_agent_models)
    preferred = settings.deep_agents.omni.main_model
    default = preferred if preferred in allowed else (allowed[0] if allowed else None)
    return [{"id": m, "label": model_label(m), "default": m == default} for m in allowed]


# ---------------------------------------------------------------------------
# Import (agent.yaml in) / render (agent.yaml out)
# ---------------------------------------------------------------------------
def slugify(text: str) -> str:
    """A display name as a slug — the builder's rule (agentSpec.ts ``slugify``):
    accents folded, lowercase, runs of anything else one hyphen, 48 at most."""
    folded = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", folded.lower()).strip("-")
    return slug[:48].strip("-")


def _is_inline_prompt(value: Any) -> bool:
    """A ``prompt:`` written out in the YAML rather than pointing at a file."""
    if not isinstance(value, str) or not value.strip():
        return False
    text = value.strip()
    if "\n" in text or " " in text:
        return True
    return PurePosixPath(text).suffix.lower() not in _ALLOWED_EXTENSIONS


def parse_agent_yaml(
    text: str, files: List[AgentFile]
) -> Tuple[Optional[Dict[str, Any]], List[AgentFile], List[AgentIssue]]:
    """An uploaded ``agent.yaml`` as a spec mapping the builder can use.

    Returns ``(spec, files, issues)``. Never saves, and checks only what the
    YAML itself gets wrong — the result goes through :func:`validate_definition`
    like any write. To make a hand-written file work:

    * a ``prompt:`` written inline (main or any sub-agent) moves into a
      generated file — ``AGENT.md``, ``subagents/<name>--<name>.md`` — and the
      spec points at it;
    * a missing ``slug`` comes from the name; a missing ``type``, ``version``
      or ``id`` gets the builder's defaults;
    * ``model: openai:gpt-5`` is read as ``model: {main: openai:gpt-5}``.
    """
    issues: List[AgentIssue] = []
    if len((text or "").encode("utf-8")) > _MAX_YAML_BYTES:
        return None, files, [_issue("", f"The YAML is over {_MAX_YAML_BYTES // 1024} KiB.")]
    try:
        data = yaml.safe_load(text or "")
    except yaml.MarkedYAMLError as exc:
        mark = exc.problem_mark or exc.context_mark
        where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark else ""
        reason = exc.problem or exc.context or "invalid YAML"
        return None, files, [_issue("", f"The YAML doesn't parse{where}: {reason}.")]
    except yaml.YAMLError as exc:
        return None, files, [_issue("", f"The YAML doesn't parse: {exc}.")]
    if not isinstance(data, dict):
        return None, files, [_issue("", "The YAML must be a mapping of fields (name:, prompt:, …).")]

    spec: Dict[str, Any] = dict(data)
    if not spec.get("slug") and isinstance(spec.get("name"), str):
        spec["slug"] = slugify(spec["name"])
    spec.setdefault("type", "deep_agent")
    spec.setdefault("version", "1.0.0")
    if not spec.get("id") and spec.get("slug"):
        spec["id"] = f"{spec['slug']}-v1"
    if isinstance(spec.get("model"), str):
        spec["model"] = {"main": spec["model"]}

    out = list(files)
    taken = {str(f.path).strip().lstrip("./") for f in files}

    def move_inline(owner: Dict[str, Any], rel: str, path: str) -> None:
        if not _is_inline_prompt(owner.get("prompt")):
            return
        if rel in taken:
            issues.append(_issue(path, f"The prompt is written inline, but {rel!r} is already among the files."))
            return
        out.append(AgentFile(path=rel, content=str(owner["prompt"]).strip() + "\n"))
        taken.add(rel)
        owner["prompt"] = f"./{rel}"

    move_inline(spec, PROMPT_FILE, "prompt")

    def walk(nodes: Any, prefix: str, above: tuple[str, ...]) -> Any:
        if not isinstance(nodes, list):
            return nodes
        copied = []
        for index, node in enumerate(nodes):
            if not isinstance(node, dict):
                copied.append(node)
                continue
            node = dict(node)
            names = (*above, slugify(str(node.get("name") or f"sub-agent-{index + 1}")))
            move_inline(node, f"{SUBAGENT_DIR}/{'--'.join(names)}.md", f"{prefix}.{index}.prompt")
            node["subagents"] = walk(node.get("subagents"), f"{prefix}.{index}.subagents", names)
            if node["subagents"] is None:
                node.pop("subagents")
            copied.append(node)
        return copied

    if "subagents" in spec:
        spec["subagents"] = walk(spec["subagents"], "subagents", ())
    return spec, out, issues


def _clean(value: Any) -> Any:
    """Drop what the YAML need not say: unset values and empty collections."""
    if isinstance(value, dict):
        cleaned = {k: _clean(v) for k, v in value.items()}
        return {k: v for k, v in cleaned.items() if v is not None and v != [] and v != {}}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


def _ordered(mapping: Dict[str, Any], order: Tuple[str, ...]) -> Dict[str, Any]:
    keys = [k for k in order if k in mapping] + [k for k in mapping if k not in order]
    return {k: mapping[k] for k in keys}


def render_agent_yaml(raw: Dict[str, Any]) -> str:
    """A stored spec as ``agent.yaml``, in the seed agent's key order.

    Unset values and empty lists are left out; :func:`parse_agent_yaml` reads
    the result back to the same definition.
    """
    data = _clean(raw)

    def order_subagents(nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            _ordered({**n, **({"subagents": order_subagents(n["subagents"])} if n.get("subagents") else {})},
                     _SUBAGENT_KEY_ORDER)
            for n in nodes
        ]

    if data.get("subagents"):
        data["subagents"] = order_subagents(data["subagents"])
    return yaml.safe_dump(
        _ordered(data, _YAML_KEY_ORDER), sort_keys=False, allow_unicode=True, width=100
    )


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------
def _store() -> AgentDefinitionStore:
    """The definition store on this service's ``agent_runtime`` pool.

    Borrowed from the same accessor memory and skills use — one pool for one
    database, rather than another for two more tables.
    """
    return AgentDefinitionStore(get_memory_pool())


def _count_subagents(nodes: Any) -> int:
    if not isinstance(nodes, list):
        return 0
    return sum(1 + _count_subagents(n.get("subagents")) for n in nodes if isinstance(n, dict))


def _summary_from_spec(raw: Dict[str, Any], slug: str) -> UserAgentSummary:
    model = raw.get("model")
    return UserAgentSummary(
        id=str(raw.get("id") or slug),
        slug=slug,
        name=str(raw.get("name") or slug),
        version=str(raw.get("version") or ""),
        type="deep agent",
        description=str(raw.get("description") or ""),
        icon=str(raw.get("icon") or ""),
        model=str(model.get("main") or "") if isinstance(model, dict) else "",
        tool_count=len(raw.get("tools") or []),
        skill_count=len(raw.get("skills") or []),
        subagent_count=_count_subagents(raw.get("subagents")),
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
    :func:`validate_definition` refuses one on the way back in.
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


async def export_user_agent(user_id: str, slug: str) -> Optional[bytes]:
    """One agent as a ``.zip``: the rendered ``agent.yaml`` and its files at the
    root — the folder layout of a built-in YAML agent, which imports back
    unchanged. ``None`` for an unknown agent."""
    loaded = await _store().get_definition(user_id, slug)
    if loaded is None:
        return None
    raw, stored = loaded
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST_FILENAME, render_agent_yaml(raw))
        for path, (content, _encoding) in sorted(stored.items()):
            archive.writestr(path, content)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Write / delete
# ---------------------------------------------------------------------------
async def write_user_agent(
    user_id: str, spec: AgentSpec, files: List[AgentFile], *, create: bool = False
) -> UserAgentSummary:
    """Persist a validated definition, replacing any previous version.

    Assumes :func:`validate_definition` already passed — it does not re-validate,
    but it does re-run the path check on the way in, because the value that
    reaches the database must be the one that was checked and not a second
    reading of the payload.

    ``create`` makes it insert-only: when the slug is already this user's it
    raises :class:`AgentDefinitionExistsError` instead of replacing, decided by
    the database so two concurrent creates cannot both win.

    The spec is stored as the **validated** model dump rather than the raw
    request, so what runs is exactly what passed validation.
    """
    staged: Dict[str, tuple[str, str]] = {}
    for item in files:
        rel = str(_validate_relpath(item.path))
        raw = _decode(item, rel)
        # Stored as text: the extension allowlist admits prompts and config
        # only, so there is no binary case to carry an encoding for.
        staged[rel] = (raw.decode("utf-8"), "utf-8")

    dumped = spec.model_dump(mode="json")
    replaced = await _store().save(
        user_id, spec.slug, spec=dumped, files=staged, create_only=create
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
    return _summary_from_spec(dumped, spec.slug)


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
    "AgentDefinitionExistsError",
    "AgentValidationError",
    "agent_model_options",
    "delete_user_agent",
    "errors_of",
    "export_user_agent",
    "get_user_agent",
    "list_user_agents",
    "model_label",
    "parse_agent_yaml",
    "render_agent_yaml",
    "slugify",
    "validate_definition",
    "validate_write",
    "walk_indexed",
    "write_user_agent",
]
