"""A conversation's files, stored in ``agent_runtime`` (plan 43).

Everything a conversation owns used to be a directory on the agents volume; it
is now rows, and lives exactly as long as the conversation:

* ``store`` — the tables: content-addressed, encrypted blobs per user, and
  the conversation's paths that name them. Forks copy paths, never bytes.
* ``inputs`` — ``/conversation/input/``, a read-only view of the uploads the
  bridge holds in ``chat_db``. Nothing is copied.
* ``files`` — one run's view of both; ``backend`` — that view as the
  deepagents filesystem behind ``/conversation/``, ``/large_tool_results/``
  and ``/conversation_history/``.
* ``paths`` — the one normaliser every path goes through; ``cipher`` — the
  checkpointer's AES key and cipher, reused for the bytes.
"""
from harness.conversation_files.backend import ConversationFilesBackend
from harness.conversation_files.files import ConversationFiles
from harness.conversation_files.inputs import InputsUnavailable
from harness.conversation_files.store import ConversationFileStore

__all__ = [
    "ConversationFileStore",
    "ConversationFiles",
    "ConversationFilesBackend",
    "InputsUnavailable",
]
