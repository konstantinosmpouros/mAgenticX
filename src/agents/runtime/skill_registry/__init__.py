"""Skill registry subsystem.

Owns the two skills_registry tiers on disk:

- **Global registry** at ``$SKILLS_REGISTRY_GLOBAL_ROOT`` (admin-curated,
  read-only at runtime). Seeded from the image on every boot via
  ``seed_global_registry``; indexed by ``manifest.json`` written by
  ``global_manifest.rebuild_global_manifest`` in the FastAPI lifespan.
- **Per-user registry** at ``$SKILLS_REGISTRY_USERS_ROOT/<user_id>/``
  (user-mutable). Phase B adds ``user_registry`` here; this module is the
  shared home so all skill-registry filesystem helpers live together.

The runtime ``CompositeBackend`` still reads skills from the per-(user, agent)
copy under ``$AGENTS_FILESYSTEM_ROOT/<user_id>/agents/<slug>/skills/`` —
that's not part of this subsystem (see ``runtime.filesystem``).
"""
from runtime.skill_registry.global_manifest import (
    get_global_manifest,
    is_global_skill,
    rebuild_global_manifest,
)
from runtime.skill_registry.seed_global_registry import seed_global_registry
from runtime.skill_registry.user_registry import (
    sync_agent_default_skills,
    SkillNameConflict,
    SkillValidationError,
    add_custom_to_user,
    add_global_to_user,
    assign_user_skill_to_agent,
    ensure_user_registry,
    get_user_skill_detail,
    list_user_skill_names,
    list_user_skills,
    read_user_manifest,
    reconcile_all_user_manifests,
    reconcile_user_manifest,
    remove_from_user,
    resolve_skill_path,
)

__all__ = [
    "get_global_manifest",
    "is_global_skill",
    "rebuild_global_manifest",
    "seed_global_registry",
    "SkillNameConflict",
    "SkillValidationError",
    "add_custom_to_user",
    "add_global_to_user",
    "assign_user_skill_to_agent",
    "ensure_user_registry",
    "get_user_skill_detail",
    "list_user_skill_names",
    "list_user_skills",
    "read_user_manifest",
    "reconcile_all_user_manifests",
    "reconcile_user_manifest",
    "remove_from_user",
    "resolve_skill_path",
    "sync_agent_default_skills",
]