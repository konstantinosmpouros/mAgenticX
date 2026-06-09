"""Per-user, per-agent filesystem provisioner.

Owns the lifecycle of ``<filesystem_root>/<user_id>/...`` — the directory
tree that backs each user's shared ``AGENT.md`` memory and the per-agent
``skills/`` directory. The presence of a directory under
``<filesystem_root>/<user_id>/agents/<agent_slug>/skills/<skill_name>/``
*is* the "this skill is enabled for this user-agent pair" record — there is
no database table mirroring the on-disk state.

Layout (three structurally-isolated mounts the agent sees as siblings):

    <filesystem_root>/<user_id>/
    ├── memory/
    │   └── AGENT.md                   ← CompositeBackend route /memories/
    └── agents/
        └── <agent_slug>/
            ├── skills/                ← CompositeBackend route /skills/
            │   └── <skill_name>/SKILL.md
            └── <conversation_id>/     ← CompositeBackend route /conversation/
                └── <session files>

Each mount lives in a distinct, non-overlapping subtree so no
``FilesystemBackend`` can resolve into another's space. In particular:

* The ``/conversation/`` mount is bound to a *single* conversation's
  directory — files the agent writes in one chat are invisible to its
  next chat. Cross-conversation persistence is the job of
  ``/memories/AGENT.md``, which the agent edits explicitly.
* The ``/skills/`` mount sees only the assigned-skill directories — not
  the conversation work area, not the global registry.
* Other deep agents for the same user live at ``agents/<other_slug>/``,
  which is not mounted into this agent's view.

Two jobs:
    1. Idempotently create the parent tree the first time a (user, agent) is
       seen (``ensure_user_agent_filesystem``).
    2. Read the current assigned-skills set for a (user, agent) pair
       (``list_enabled_skills``).

Writes to the skills directory are owned by
``runtime.skill_registry.user_registry.assign_user_skill_to_agent`` (which
resolves the source folder via the user's manifest) and the cascade in
``remove_from_user``. The provisioner only ensures the parent directory
tree exists; the registry layer owns the skill set inside it.

All ID segments are validated with ``_safe_segment`` before they become
path components, defending against path-traversal injected through the
``user_id`` or ``agent_slug`` values themselves.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import List

from core.settings import settings
from observability import get_logger
from runtime.filesystem.agent_md_template import AGENT_MD_TEMPLATE

logger = get_logger(__name__)


def _safe_segment(value: str) -> str:
    """Reject IDs that could break out of their intended directory.

    UUIDs from the bridge are safe by construction, but ``user_id`` /
    ``agent_slug`` are inputs to a path operation — validating them is
    cheap defense in depth against any future caller that supplies a
    different ID shape.
    """
    if (
        not value
        or "/" in value
        or "\\" in value
        or ".." in value
        or value.startswith(".")
    ):
        raise ValueError(f"Illegal path segment: {value!r}")
    return value


def user_root(user_id: str) -> Path:
    """The parent of both the memory and agents trees.

    Not used as a FilesystemBackend root anywhere — exposed for callers
    that need to enumerate a user's siblings (e.g. cleanup tasks).
    """
    return settings.filesystem.user_root / _safe_segment(user_id)


def memory_root(user_id: str) -> Path:
    """The ``/memories/`` mount root for this user.

    Contains only the shared ``AGENT.md`` and any future user-level
    cross-agent memory. Structurally isolated from ``agent_root`` — they
    are siblings, not parent/child.
    """
    return user_root(user_id) / "memory"


def agent_root(user_id: str, agent_slug: str) -> Path:
    """Parent of the agent's ``skills/`` directory and every conversation dir.

    Not itself mounted — the agent never sees this level directly. Used
    internally to compute ``skills_root`` and ``conversation_root`` and by
    the Phase 2 bridge endpoints when copying skills from the registry.
    """
    return user_root(user_id) / "agents" / _safe_segment(agent_slug)


def skills_root(user_id: str, agent_slug: str) -> Path:
    """The ``/skills/`` mount root — enabled-skill directories live here."""
    return agent_root(user_id, agent_slug) / "skills"


def conversation_root(user_id: str, agent_slug: str, conversation_id: str) -> Path:
    """The ``/conversation/`` mount root for one specific conversation.

    Per-conversation isolation: files the agent writes in conversation A
    are not visible in conversation B. Cross-conversation persistence
    goes through ``/memories/AGENT.md`` instead.
    """
    return agent_root(user_id, agent_slug) / _safe_segment(conversation_id)


def ensure_user_agent_filesystem(
    *,
    user_id: str,
    agent_slug: str,
    conversation_id: str | None = None,
) -> Path:
    """Idempotent. Returns the user-level path.

    Provisions:

    - ``<filesystem_root>/<user_id>/`` on first contact.
    - ``<user_id>/memory/`` + seeds ``AGENT.md`` from the standard template
      if it doesn't exist; never overwrites an existing file (the agent's
      edits are sacred).
    - ``<user_id>/agents/<agent_slug>/skills/`` on first contact (empty —
      assignments are owned by the skill-registry layer).
    - ``<user_id>/agents/<agent_slug>/<conversation_id>/`` when
      ``conversation_id`` is supplied (agent invocation path). Bridge skill
      CRUD endpoints don't pass it.
    """
    root = user_root(user_id)
    root.mkdir(parents=True, exist_ok=True)

    mem = memory_root(user_id)
    mem.mkdir(parents=True, exist_ok=True)

    agent_md = mem / "AGENT.md"
    if not agent_md.exists():
        agent_md.write_text(AGENT_MD_TEMPLATE, encoding="utf-8")
        logger.info(
            "agent_md_template_seeded",
            "Seeded AGENT.md from template for new user",
            user_id=user_id,
            path=str(agent_md),
        )

    skills_dir = skills_root(user_id, agent_slug)
    skills_dir.mkdir(parents=True, exist_ok=True)

    if conversation_id is not None:
        conv_dir = conversation_root(user_id, agent_slug, conversation_id)
        conv_dir.mkdir(parents=True, exist_ok=True)

    return root


def list_enabled_skills(user_id: str, agent_slug: str) -> List[str]:
    """Return the sorted list of skill names currently assigned to the pair.

    Source of truth is the filesystem — ``os.listdir`` on the skills
    directory. Returns an empty list if the directory doesn't exist yet
    (the user hasn't assigned any skill to this agent yet).
    """
    skills_dir = agent_root(user_id, agent_slug) / "skills"
    if not skills_dir.is_dir():
        return []
    return sorted(entry.name for entry in skills_dir.iterdir() if entry.is_dir())


def disable_skill(*, user_id: str, agent_slug: str, skill_name: str) -> None:
    """Remove the user-agent's copy of ``skill_name``.

    Idempotent: removing a non-existent skill is a no-op.

    NOTE: kept here (not moved to ``runtime.skill_registry``) because it
    only touches the per-(user, agent) filesystem and is the inverse of
    ``assign_user_skill_to_agent`` — symmetric ops live with the dir tree
    they mutate. The Phase B remove-from-pool path uses an in-line
    ``shutil.rmtree`` cascade instead of calling this so the cascade can
    iterate over every agent without an extra dependency layer.
    """
    target = agent_root(user_id, agent_slug) / "skills" / _safe_segment(skill_name)
    if not target.exists():
        logger.info(
            "skill_already_disabled",
            "Skill not assigned — disable is a no-op",
            user_id=user_id,
            agent_slug=agent_slug,
            skill_name=skill_name,
        )
        return

    shutil.rmtree(target)
    logger.info(
        "skill_disabled",
        "Skill assignment removed for user-agent pair",
        user_id=user_id,
        agent_slug=agent_slug,
        skill_name=skill_name,
    )
