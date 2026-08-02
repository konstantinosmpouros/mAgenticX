"""Per-user / per-(user, agent) / per-conversation filesystem subsystem.

Owns the directory tree under ``<filesystem_root>/<user_id>/...`` that backs
each user's shared ``AGENT.md`` memory, the per-agent enabled-skills set,
and each conversation's working area. See ``provisioner`` for the full
layout doc.

Re-exports the public surface so the bridge / agents-service / runtime can
import from ``runtime.filesystem`` rather than reaching into ``provisioner``
directly.
"""
from runtime.filesystem.agent_md_template import AGENTS_MD_TEMPLATE
from runtime.filesystem.provisioner import (
    agent_root,
    conversation_input_root,
    conversation_output_root,
    conversation_root,
    delete_conversation_files,
    disable_skill,
    ensure_user_agent_filesystem,
    list_enabled_skills,
    memory_entries_root,
    memory_index_path,
    memory_root,
    read_output_files,
    resolve_output_file,
    seed_input_files,
    skills_root,
    user_root,
)
from runtime.filesystem.memory import (
    MEMORIES_HEADER,
    delete_memory,
    index_line,
    index_line_pattern,
    list_memories,
    read_memory,
)
from runtime.filesystem.retention import (
    run_workspace_retention_loop,
    sweep_workspace_retention_once,
)
from runtime.filesystem.workspace import (
    WORKSPACE_WRITE_DENY,
    build_workspace_backend,
)

__all__ = [
    "AGENTS_MD_TEMPLATE",
    "MEMORIES_HEADER",
    "WORKSPACE_WRITE_DENY",
    "agent_root",
    "build_workspace_backend",
    "delete_memory",
    "index_line",
    "index_line_pattern",
    "list_memories",
    "read_memory",
    "conversation_input_root",
    "conversation_output_root",
    "conversation_root",
    "delete_conversation_files",
    "disable_skill",
    "ensure_user_agent_filesystem",
    "list_enabled_skills",
    "memory_entries_root",
    "memory_index_path",
    "memory_root",
    "read_output_files",
    "resolve_output_file",
    "run_workspace_retention_loop",
    "seed_input_files",
    "skills_root",
    "sweep_workspace_retention_once",
    "user_root",
]
