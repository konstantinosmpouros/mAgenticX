"""Single authority for every path on the agents filesystem.

Two planes under one root — the consolidated layout from
``plans/18-workspace-filesystem-consolidation.md``::

    $MAGENTICX_GLOBAL_ROOT/                         ← platform-owned, shared
        agents/<agent_slug>/                        agent definition
            agent.yaml · AGENT.md · subagents/
            skills/<skill_name>/                    DEFAULT skills (tier ①)
        skills/<category>/<skill_name>/SKILL.md     browsable catalogue

    $MAGENTICX_WORKSPACES_ROOT/users/<user_id>/     ← one user's everything
        custom_agents/<agent_slug>/agent.yaml       user-authored agent definitions
        agents/<agent_slug>/
            tool_prefs.json
            conversations/<conversation_id>/{input,output}

Both planes are here because the split between them is the point: the global
plane is **build-time** content — baked into the image, identical for every
user, never written at runtime — while the user plane holds only what a run
actually produces. Runtime content that used to sit in the user plane now lives
in ``agent_runtime`` instead: memory in ``agent_memories``, and the skill pool,
custom skill files and per-agent assignments in ``skill_pool`` / ``skill_files``
/ ``agent_skills``. Neither has a path here, which is why the user tree is as
thin as it looks.

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
    """Parent of this (user, agent) pair's conversations and tool preferences.
    Never itself mounted — the agent never sees this level."""
    return user_agents_root(user_id) / safe_segment(agent_slug)


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
    "agent_root",
    "conversation_input_root",
    "conversation_output_root",
    "conversation_root",
    "conversations_root",
    "global_agent_default_skills_root",
    "global_agent_dir",
    "global_agents_root",
    "global_root",
    "global_skills_root",
    "safe_segment",
    "user_agents_root",
    "user_custom_agent_dir",
    "user_custom_agents_root",
    "user_workspace",
    "users_root",
]
