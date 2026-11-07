"""The agents filesystem: the global plane on disk and the run's mount table.

``layout`` is the single authority for *where* the platform's build-time
content lives (agent definitions, the skills catalogue). ``workspace``
assembles what a deep agent sees — virtual routes over ``agent_runtime``
(memory, skills, the conversation's files) and the image folders — and the
write-deny ladder that goes with it; ``middleware`` is the filesystem
middleware every stack runs those through. ``scratch_store`` /
``scratch_backend`` are the workspace's default route — one branch's scratch
files as rows, shared live by the orchestrator and its async tasks (plan 41) —
and ``scratch_migration`` the one-shot import of the old in-state scratch.
Nothing a user or a run produces is a directory any more; see
:mod:`harness.conversation_files`.
"""
from harness.filesystem import layout
from harness.filesystem.middleware import (
    FILESYSTEM_TOOLS,
    PlatformFilesystemMiddleware,
    filesystem_middleware,
)
from harness.filesystem.scratch_backend import (
    BranchScratchBackend,
    current_branch_thread_id,
    resolve_branch_thread_id,
)
from harness.filesystem.scratch_store import BranchScratchStore
from harness.filesystem.workspace import (
    WORKSPACE_WRITE_DENY,
    build_workspace_backend,
    workspace_write_deny,
)

__all__ = [
    "FILESYSTEM_TOOLS",
    "WORKSPACE_WRITE_DENY",
    "BranchScratchBackend",
    "BranchScratchStore",
    "PlatformFilesystemMiddleware",
    "build_workspace_backend",
    "current_branch_thread_id",
    "filesystem_middleware",
    "layout",
    "resolve_branch_thread_id",
    "workspace_write_deny",
]
