"""Per-user / per-(user, agent) / per-conversation filesystem subsystem.

Owns the directory tree under ``<filesystem_root>/<user_id>/...`` that backs
each user's shared ``AGENT.md`` memory, the per-agent enabled-skills set,
and each conversation's working area. See ``provisioner`` for the full
layout doc.

Re-exports the public surface so the bridge / agents-service / runtime can
import from ``runtime.filesystem`` rather than reaching into ``provisioner``
directly.
"""
from runtime.filesystem.agent_md_template import AGENT_MD_TEMPLATE
from runtime.filesystem.provisioner import (
    agent_root,
    conversation_input_root,
    conversation_output_root,
    conversation_root,
    delete_conversation_files,
    disable_skill,
    ensure_user_agent_filesystem,
    list_enabled_skills,
    memory_root,
    seed_input_files,
    skills_root,
    user_root,
)

__all__ = [
    "AGENT_MD_TEMPLATE",
    "agent_root",
    "conversation_input_root",
    "conversation_output_root",
    "conversation_root",
    "delete_conversation_files",
    "disable_skill",
    "ensure_user_agent_filesystem",
    "list_enabled_skills",
    "memory_root",
    "seed_input_files",
    "skills_root",
    "user_root",
]
