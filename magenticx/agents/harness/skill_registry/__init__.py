"""Skill registry subsystem — a user's skill pool, and where its skills come from.

Every skill a user holds is a row in ``agent_runtime`` (:mod:`.store`), and the
``/skills/`` and ``/default_skills/`` mounts are virtual routes over it. A pool
entry is one of:

* ``custom`` — authored by the user (or by an agent through ``create_skill``).
* ``remote`` — added from an allowlisted remote source (plan 30). The catalogue
  those come from is indexed daily by :mod:`.remote`, and its content is fetched
  — pinned and verified — only when someone adds it.
* ``global`` — **legacy**: a reference into the bundled catalogue plan 30
  deleted. Still readable from the volume so nothing a user holds breaks; no
  code path can create one.

A platform agent's own bundled ``skills/`` folder is a different thing (tier ①
of that agent) and is not part of this subsystem.
"""
from harness.skill_registry.remote import (
    RemoteSkillRefused,
    RemoteSkillUnavailable,
    run_remote_skill_sync_loop,
)
from harness.skill_registry.store import SkillStore
from harness.skill_registry.user_registry import (
    RemoteSkillsDisabled,
    SkillNameConflict,
    SkillValidationError,
    add_custom_to_user,
    add_remote_to_user,
    assign_user_skill_to_agent,
    get_user_skill_detail,
    list_remote_sources,
    list_user_agent_skills,
    list_user_skill_names,
    list_user_skills,
    remove_from_user,
    search_catalogue,
    unassign_user_skill_from_agent,
)

__all__ = [
    "RemoteSkillRefused",
    "RemoteSkillUnavailable",
    "RemoteSkillsDisabled",
    "SkillNameConflict",
    "SkillStore",
    "SkillValidationError",
    "add_custom_to_user",
    "add_remote_to_user",
    "assign_user_skill_to_agent",
    "get_user_skill_detail",
    "list_remote_sources",
    "list_user_agent_skills",
    "list_user_skill_names",
    "list_user_skills",
    "remove_from_user",
    "run_remote_skill_sync_loop",
    "search_catalogue",
    "unassign_user_skill_from_agent",
]
