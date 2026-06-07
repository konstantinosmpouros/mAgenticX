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
* The ``/skills/`` mount sees only the enabled-skill directories — not
  the conversation work area, not the central registry.
* Other deep agents for the same user live at ``agents/<other_slug>/``,
  which is not mounted into this agent's view.

Three jobs:
    1. Idempotently create the parent tree the first time a (user, agent) is
       seen (``ensure_user_agent_filesystem``).
    2. Read the current enabled-skills set for a (user, agent) pair
       (``list_enabled_skills``).
    3. Mutate that set by copying from / removing under the registry
       (``enable_skill``, ``disable_skill``).

All ID segments are validated with ``_safe_segment`` before they become
path components, defending against path-traversal injected through the
``user_id`` or ``agent_slug`` values themselves.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Iterable, List

from core.settings import settings
from observability import get_logger
from runtime.agent_md_template import AGENT_MD_TEMPLATE

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


def _registry_skill_dir(skill_name: str) -> Path:
    return settings.filesystem.skills_registry_root / _safe_segment(skill_name)


def is_registry_skill(skill_name: str) -> bool:
    """True iff the named skill exists in the central registry."""
    try:
        return _registry_skill_dir(skill_name).is_dir()
    except ValueError:
        return False


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
    default_skills: Iterable[str] | None = None,
) -> Path:
    """Idempotent. Returns the user-level path.

    Provisions:

    - ``<filesystem_root>/<user_id>/`` on first contact.
    - ``<user_id>/memory/`` + seeds ``AGENT.md`` from the standard template
      if it doesn't exist; never overwrites an existing file (the agent's
      edits are sacred).
    - ``<user_id>/agents/<agent_slug>/skills/`` on first contact. On the
      very first run for a (user, agent) pair, copies ``default_skills``
      from the registry into ``skills/`` so a brand-new agent isn't
      unusable on its first conversation. Subsequent calls leave existing
      content alone — Phase 2 mutation endpoints own the skill set from
      then on.
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

    agent_dir = agent_root(user_id, agent_slug)
    is_first_run = not agent_dir.exists()
    skills_dir = skills_root(user_id, agent_slug)
    skills_dir.mkdir(parents=True, exist_ok=True)

    if is_first_run and default_skills:
        seeded: list[str] = []
        for skill_name in default_skills:
            try:
                enable_skill(user_id=user_id, agent_slug=agent_slug, skill_name=skill_name)
                seeded.append(skill_name)
            except FileNotFoundError:
                logger.warning(
                    "default_skill_missing_from_registry",
                    "Default skill is not present in the registry; skipped seeding",
                    user_id=user_id,
                    agent_slug=agent_slug,
                    skill_name=skill_name,
                )
        if seeded:
            logger.info(
                "default_skills_seeded",
                "Seeded default skills for first-time (user, agent) pair",
                user_id=user_id,
                agent_slug=agent_slug,
                skills=seeded,
            )

    if conversation_id is not None:
        conv_dir = conversation_root(user_id, agent_slug, conversation_id)
        conv_dir.mkdir(parents=True, exist_ok=True)

    return root


def list_enabled_skills(user_id: str, agent_slug: str) -> List[str]:
    """Return the sorted list of skill names currently enabled for the pair.

    Source of truth is the filesystem — ``os.listdir`` on the skills
    directory. Returns an empty list if the directory doesn't exist yet
    (the user hasn't run the agent for the first time).
    """
    skills_dir = agent_root(user_id, agent_slug) / "skills"
    if not skills_dir.is_dir():
        return []
    return sorted(entry.name for entry in skills_dir.iterdir() if entry.is_dir())


def enable_skill(*, user_id: str, agent_slug: str, skill_name: str) -> None:
    """Copy ``<registry>/<skill_name>/`` into the user-agent's skills dir.

    Idempotent: re-enabling an already-present skill is a no-op. Raises
    :class:`FileNotFoundError` when ``skill_name`` is not in the registry.
    """
    src = _registry_skill_dir(skill_name)
    if not src.is_dir():
        raise FileNotFoundError(f"Skill not found in registry: {skill_name}")

    dest_parent = agent_root(user_id, agent_slug) / "skills"
    dest_parent.mkdir(parents=True, exist_ok=True)
    dest = dest_parent / _safe_segment(skill_name)
    if dest.exists():
        logger.info(
            "skill_already_enabled",
            "Skill already enabled — no-op",
            user_id=user_id,
            agent_slug=agent_slug,
            skill_name=skill_name,
        )
        return

    shutil.copytree(src, dest)
    logger.info(
        "skill_enabled",
        "Skill enabled for user-agent pair",
        user_id=user_id,
        agent_slug=agent_slug,
        skill_name=skill_name,
    )


def disable_skill(*, user_id: str, agent_slug: str, skill_name: str) -> None:
    """Remove the user-agent's copy of ``skill_name``.

    Idempotent: removing a non-existent skill is a no-op.
    """
    target = agent_root(user_id, agent_slug) / "skills" / _safe_segment(skill_name)
    if not target.exists():
        logger.info(
            "skill_already_disabled",
            "Skill not enabled — disable is a no-op",
            user_id=user_id,
            agent_slug=agent_slug,
            skill_name=skill_name,
        )
        return

    shutil.rmtree(target)
    logger.info(
        "skill_disabled",
        "Skill disabled for user-agent pair",
        user_id=user_id,
        agent_slug=agent_slug,
        skill_name=skill_name,
    )
