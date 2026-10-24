"""The agents filesystem: the global plane on disk and the run's mount table.

``layout`` is the single authority for *where* the platform's build-time
content lives (agent definitions, the skills catalogue). ``workspace``
assembles what a deep agent sees — virtual routes over ``agent_runtime``
(memory, skills, the conversation's files) and the image folders — and the
write-deny ladder that goes with it. Nothing a user or a run produces is a
directory any more; see :mod:`harness.conversation_files`.
"""
from harness.filesystem import layout
from harness.filesystem.workspace import (
    WORKSPACE_WRITE_DENY,
    build_workspace_backend,
    workspace_write_deny,
)

__all__ = [
    "WORKSPACE_WRITE_DENY",
    "build_workspace_backend",
    "layout",
    "workspace_write_deny",
]
