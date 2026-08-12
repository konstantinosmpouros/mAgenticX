"""Single authority for every path on the agents filesystem.

Two planes under one root — the consolidated layout from
``docs/plans/18-workspace-filesystem-consolidation.md``::

    $MAGENTICX_GLOBAL_ROOT/                         ← platform-owned, shared
        agents/<agent_slug>/                        agent definition
            agent.yaml · AGENT.md · subagents/
            skills/<skill_name>/                    DEFAULT skills (tier ①)
        skills/<category>/<skill_name>/SKILL.md     browsable catalogue

    $MAGENTICX_WORKSPACES_ROOT/users/<user_id>/     ← one user's everything
        skills/
            manifest.json                           the user's pool
            custom/<skill_name>/SKILL.md            user-authored skills
        custom_agents/<agent_slug>/agent.yaml       user-authored agent definitions
        agents/<agent_slug>/
            memory/{AGENTS.md, entries/*.yml}
            skills/<skill_name>/                    ADDED skills (tier ②, copied from pool)
            default_skills/<skill_name>/            tier ① for user-authored agents
            tool_prefs.json
            conversations/<conversation_id>/{input,output}

Why this module exists: the same user's data used to be split across three
volumes with path construction scattered over the provisioner, the skill
registry, the seeder and the retention sweeper. Every path now derives from
exactly two settings, so a future re-shape (adding a workspace tier, an org
tier) is one edit here rather than a hunt.

``users/`` is an explicit segment under the workspaces root so that
``workspaces/orgs/<org_id>/`` and per-workspace subtrees can be added later
without moving user data.
"""
from __future__ import annotations

from pathlib import Path

from core.settings import settings

# One conversation's working dir sits under this parent, making "is this a
# conversation directory?" structural instead of a name denylist — the retention
# sweeper used to skip `memory`/`skills` by name, which broke every time a new
# sibling was added under the agent root.
CONVERSATIONS_DIRNAME = "conversations"
# Named so callers can recognise a *definition* path without a magic string
# (e.g. a declarative agent deciding whether it is user-authored or platform).
CUSTOM_AGENTS_DIRNAME = "custom_agents"


def safe_segment(value: str) -> str:
    """Reject IDs that could break out of their intended directory.

    UUIDs from the bridge are safe by construction, but ``user_id`` /
    ``agent_slug`` / ``conversation_id`` are inputs to a path operation —
    validating them is cheap defense in depth against any future caller that
    supplies a different ID shape. Matters more now that users are siblings
    under one root: a traversal bug crosses a tenant boundary rather than
    landing on a different volume.
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


# ---------------------------------------------------------------------------
# Global plane
# ---------------------------------------------------------------------------
def global_root() -> Path:
    """Root of the shared plane (definitions + catalogues)."""
    return settings.filesystem.global_root


def global_agents_root() -> Path:
    """Where built-in agent definitions are seeded from the image."""
    return global_root() / "agents"


def global_agent_dir(agent_slug: str) -> Path:
    """One platform agent's definition folder."""
    return global_agents_root() / safe_segment(agent_slug)


def global_agent_default_skills_root(agent_slug: str) -> Path:
    """Tier ① skills a platform agent ships with — mounted read-only, never
    copied into a user's tree, so a user cannot disable them."""
    return global_agent_dir(agent_slug) / "skills"


def global_skills_root() -> Path:
    """The admin-curated skills catalogue (``<category>/<skill>/SKILL.md``)."""
    return global_root() / "skills"


# ---------------------------------------------------------------------------
# Per-user workspace
# ---------------------------------------------------------------------------
def users_root() -> Path:
    """Parent of every user workspace. The retention sweeper's scan root."""
    return settings.filesystem.workspaces_root / "users"


def user_workspace(user_id: str) -> Path:
    """One user's entire tree — pool, custom agents, per-agent state."""
    return users_root() / safe_segment(user_id)


def user_skills_pool_root(user_id: str) -> Path:
    """The user's skill pool (``manifest.json`` + ``custom/``)."""
    return user_workspace(user_id) / "skills"


def user_manifest_path(user_id: str) -> Path:
    """The authoritative list of skills in this user's pool."""
    return user_skills_pool_root(user_id) / "manifest.json"


def user_custom_skills_root(user_id: str) -> Path:
    """Folders backing ``type="custom"`` pool entries. ``type="global"``
    entries are references and have no folder here."""
    return user_skills_pool_root(user_id) / "custom"


def user_custom_skill_dir(user_id: str, skill_name: str) -> Path:
    return user_custom_skills_root(user_id) / safe_segment(skill_name)


def user_custom_agents_root(user_id: str) -> Path:
    """Where a user's own ``agent.yaml`` definitions live.

    Deliberately separate from
    ``agents/`` — that holds per-agent *state* for every agent the user talks
    to, platform or custom, while this holds *definitions* the user owns. The
    split mirrors the global plane, where ``global/agents/<slug>/`` is a
    definition and the user's state lives elsewhere.
    """
    return user_workspace(user_id) / CUSTOM_AGENTS_DIRNAME


def user_custom_agent_dir(user_id: str, agent_slug: str) -> Path:
    return user_custom_agents_root(user_id) / safe_segment(agent_slug)


# ---------------------------------------------------------------------------
# Per-(user, agent) state
# ---------------------------------------------------------------------------
def user_agents_root(user_id: str) -> Path:
    return user_workspace(user_id) / "agents"


def agent_root(user_id: str, agent_slug: str) -> Path:
    """Parent of this (user, agent) pair's memory, skills and conversations.
    Never itself mounted — the agent never sees this level."""
    return user_agents_root(user_id) / safe_segment(agent_slug)


def memory_root(user_id: str, agent_slug: str) -> Path:
    return agent_root(user_id, agent_slug) / "memory"


def memory_entries_root(user_id: str, agent_slug: str) -> Path:
    return memory_root(user_id, agent_slug) / "entries"


def memory_index_path(user_id: str, agent_slug: str) -> Path:
    return memory_root(user_id, agent_slug) / "AGENTS.md"


def agent_skills_root(user_id: str, agent_slug: str) -> Path:
    """Tier ② — skills the user added to this agent, copied from their pool.
    Directory presence is the "enabled" record; there is no DB mirror."""
    return agent_root(user_id, agent_slug) / "skills"


def agent_default_skills_root(user_id: str, agent_slug: str) -> Path:
    """Tier ① for a *user-authored* agent: resolved from the user's own pool
    when they save the agent. Platform agents use
    :func:`global_agent_default_skills_root` instead."""
    return agent_root(user_id, agent_slug) / "default_skills"


def agent_tool_prefs_path(user_id: str, agent_slug: str) -> Path:
    """Per-(user, agent) tool overrides (``disabledTools`` + ``enabledTools``)."""
    return agent_root(user_id, agent_slug) / "tool_prefs.json"


def conversations_root(user_id: str, agent_slug: str) -> Path:
    return agent_root(user_id, agent_slug) / CONVERSATIONS_DIRNAME


def conversation_root(user_id: str, agent_slug: str, conversation_id: str) -> Path:
    return conversations_root(user_id, agent_slug) / safe_segment(conversation_id)


def conversation_input_root(user_id: str, agent_slug: str, conversation_id: str) -> Path:
    return conversation_root(user_id, agent_slug, conversation_id) / "input"


def conversation_output_root(user_id: str, agent_slug: str, conversation_id: str) -> Path:
    return conversation_root(user_id, agent_slug, conversation_id) / "output"


__all__ = [
    "CONVERSATIONS_DIRNAME",
    "CUSTOM_AGENTS_DIRNAME",
    "safe_segment",
    "global_root",
    "global_agents_root",
    "global_agent_dir",
    "global_agent_default_skills_root",
    "global_skills_root",
    "users_root",
    "user_workspace",
    "user_skills_pool_root",
    "user_manifest_path",
    "user_custom_skills_root",
    "user_custom_skill_dir",
    "user_custom_agents_root",
    "user_custom_agent_dir",
    "user_agents_root",
    "agent_root",
    "memory_root",
    "memory_entries_root",
    "memory_index_path",
    "agent_skills_root",
    "agent_default_skills_root",
    "agent_tool_prefs_path",
    "conversations_root",
    "conversation_root",
    "conversation_input_root",
    "conversation_output_root",
]
