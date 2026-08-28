"""Agent tool: author a reusable skill into this user's pool and enable it here.

Bound **per run** (closes over the current run's ``user_id`` + ``agent_slug``,
which ``BaseAgent`` reads from the request config into ``self.context``), so it
can never write into another user's pool or another agent's workspace.

The skill is a folder: a generated ``SKILL.md`` plus any extra files the model
supplies by relative path (``references/api.md``, ``scripts/fetch.py``, …). Every
path is confined by the registry's own ``_validate_skill_relpath`` — depth cap,
per-segment sanitisation, extension allowlist — so nothing can be written
outside the skill folder.

Scripts are permitted here at the user's explicit instruction, which overrides
§3.2 of ``docs/plans/12-create-skill-tool.md`` (markdown-only). The risk that
section names is real and unchanged: nothing on this platform executes code
today (``SANDBOX_EXECUTION_ENABLED`` is false and the workspace factory refuses
to mint a sandbox-capable default), so a script written now is inert — but it
becomes live the day execution ships, under an approval whose reviewer may not
have read it. When the sandbox runner lands, agent-authored scripts should be
revisited as a deliberate decision rather than inherited silently.

Two writes, in order, reusing the same primitives the Settings UI calls:

1. :func:`add_custom_to_user` creates the skill folder in the user's pool
   (``users/<user>/skills/custom/<name>/``) and adds its manifest entry.
2. :func:`assign_user_skill_to_agent` copies that folder into the calling
   agent's per-(user, agent) skills directory so it is available to this agent.

Step 2 writes the **user-managed** tier, deliberately — not the read-only tier
that ``sync_agent_default_skills`` fills from an agent's declared ``skills:``.
A skill the agent invented must remain something the user can disable in
Settings → Agents; a skill written to the declared tier could not be removed.

A skill created mid-run is NOT usable in that same run: the agent's skill
directory is composed when its filesystem is built at run start. The return
message says so rather than letting the model assume otherwise and retry.
"""
from __future__ import annotations

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from core.logging import get_logger
from runtime.skill_registry import (
    SkillNameConflict,
    SkillValidationError,
    add_custom_to_user,
    assign_user_skill_to_agent,
)
from schema import CustomSkillCreate, SkillFile

logger = get_logger(__name__)

_MAX_DESCRIPTION = 300
_SKILL_ENTRY_FILE = "SKILL.md"


class _SkillFileArg(BaseModel):
    """One extra file in the skill folder, beside the generated SKILL.md."""

    path: str = Field(
        description="Path relative to the skill root, '/'-separated, e.g. "
        "'references/api.md' or 'scripts/fetch.py'. No leading slash, no '..'."
    )
    content: str = Field(description="The file's text content.")


class _CreateSkillArgs(BaseModel):
    name: str = Field(
        description="Short kebab-case identifier for the skill, e.g. "
        "'quarterly-report' or 'pdf-invoice-parser'. Must be unique within the "
        "user's skill pool."
    )
    description: str = Field(
        description="One line describing when this skill should be used. This is "
        "what you and the user see in the skill list, so make it self-contained."
    )
    instructions: str = Field(
        description="The full SKILL.md body: the procedure, conventions and "
        "gotchas needed to perform this capability well. Write it for a future "
        "reader who has none of the current conversation's context."
    )
    files: list[_SkillFileArg] = Field(
        default_factory=list,
        description="Optional extra files for the skill folder, each with a "
        "'path' relative to the skill root (e.g. 'references/api.md' or "
        "'scripts/fetch.py') and its text 'content'. Use these for material "
        "that would bloat SKILL.md — reference notes, templates, helper "
        "scripts — and point to them from SKILL.md so a reader knows they "
        "exist. Do not include SKILL.md here; it is written from "
        "'instructions'.",
    )


def build_create_skill_tool(*, user_id: str, agent_slug: str) -> StructuredTool:
    """Return a ``create_skill`` tool bound to this run's (user, agent)."""

    def _create_skill(
        name: str,
        description: str,
        instructions: str,
        files: list[_SkillFileArg] | None = None,
    ) -> str:
        name = name.strip()
        description = description.strip()[:_MAX_DESCRIPTION]
        instructions = instructions.strip()
        if not name:
            return "Could not create the skill: 'name' is required."
        if not description or not instructions:
            return (
                "Could not create the skill: both 'description' and "
                "'instructions' are required."
            )

        # SKILL.md is always generated from `instructions` — the registry wraps
        # it with canonical frontmatter built from name + description, so the
        # body is passed unwrapped. Any SKILL.md the model tried to pass in
        # `files` is dropped rather than fought over: two entry files would fail
        # the registry's "exactly one SKILL.md" check with a confusing error.
        extra = [f for f in (files or []) if f.path.strip().lower() != _SKILL_ENTRY_FILE.lower()]
        payload = CustomSkillCreate(
            name=name,
            description=description,
            files=[
                SkillFile(path=_SKILL_ENTRY_FILE, content=instructions),
                *(SkillFile(path=f.path.strip(), content=f.content) for f in extra),
            ],
        )

        try:
            # Stamped as agent-authored so the user can always tell what their
            # agent wrote from what they uploaded themselves.
            entry = add_custom_to_user(user_id, payload, created_by_agent=agent_slug)
        except SkillNameConflict as exc:
            # Expected and actionable — the model should pick another name
            # rather than treat this as a failure of the tool.
            return f"A skill by that name already exists: {exc}. Choose a different name."
        except SkillValidationError as exc:
            return f"Could not create the skill: {exc}"
        except OSError as exc:
            logger.warning(
                "create_skill_tool_write_failed",
                "Failed to write a new custom skill",
                agent_slug=agent_slug,
                failure_reason=type(exc).__name__,
            )
            return "Could not create the skill right now."

        skill_name = entry.name
        try:
            assign_user_skill_to_agent(
                user_id=user_id, agent_slug=agent_slug, skill_name=skill_name
            )
        except (SkillNameConflict, SkillValidationError, OSError) as exc:
            # The pool write already succeeded, so report the partial outcome
            # honestly instead of implying nothing happened — the user can
            # enable it by hand in Settings → Agents.
            logger.warning(
                "create_skill_tool_assign_failed",
                "Created the skill but could not enable it for this agent",
                agent_slug=agent_slug,
                skill_name=skill_name,
                failure_reason=type(exc).__name__,
            )
            return (
                f"Created skill '{skill_name}' in the user's skill pool, but could "
                "not enable it for you automatically. The user can enable it in "
                "Settings → Agents."
            )

        logger.info(
            "skill_created",
            "Created a custom skill and enabled it for this agent",
            agent_slug=agent_slug,
            skill_name=skill_name,
        )
        file_note = f" with {len(extra)} extra file(s)" if extra else ""
        return (
            f"Created skill '{skill_name}'{file_note} and enabled it for you. It is not loaded "
            "in this conversation — it becomes available from the user's next "
            "message. The user can review or disable it in Settings → Agents."
        )

    return StructuredTool.from_function(
        func=_create_skill,
        name="create_skill",
        description=(
            "Author a NEW reusable skill and add it to this user's skill pool, "
            "then enable it for yourself. A skill is a folder: a SKILL.md "
            "procedure plus optional supporting files (reference notes, "
            "templates, helper scripts) you pass in 'files' by relative path. "
            "Use this ONLY when the user explicitly asks you to remember how to "
            "do something as a reusable capability, or clearly agrees to it. Do "
            "NOT create a skill just because a task felt repeatable: an unasked-for "
            "skill clutters the user's pool with near-duplicates. Prefer updating "
            "your memory with `remember` for facts; a skill is for procedures."
        ),
        args_schema=_CreateSkillArgs,
    )
