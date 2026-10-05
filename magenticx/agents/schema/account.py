"""Account deletion (plan 32): the bridge's purge calls into this service.

The bridge owns the deletion — the request, the grace period, the order of the
steps and their retries. This service only removes what it holds, when told,
and reports how much it removed.
"""
from typing import Annotated, List

from pydantic import BaseModel, Field, StringConstraints

# A checkpoint thread id as the bridge recorded it: a non-empty opaque token.
ThreadId = Annotated[str, StringConstraints(min_length=1, max_length=256)]


class PurgeThreadsRequest(BaseModel):
    """Bridge → agents: checkpoint threads of a user being purged.

    The bridge knows which threads belong to whom (``messages.checkpoint_thread_id``);
    this service only holds the threads. Bounded so one call stays one short job.
    """

    thread_ids: List[ThreadId] = Field(default_factory=list, max_length=500)


class PurgeThreadsResponse(BaseModel):
    deleted: int


class PurgeUserResponse(BaseModel):
    """What was removed, per store — the bridge records it in the deletion record."""

    agent_memories: int
    skill_pool: int
    skill_files: int
    agent_skills: int
    agent_definitions: int
    agent_definition_files: int
    workspace_removed: bool
