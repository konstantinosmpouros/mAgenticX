"""Reasoning effort on the run context: how hard the model thinks on one turn.

The user picks a level per message in the composer; ``messages.effort`` keeps it
on the user message. Every run starts from a user message (new, send, edit,
retry, a queued send), so the run context is built from that row and nothing
else: a retry reuses the same message and therefore the same effort, and the
``/resume`` legs of a paused run ride the same shared config block.

The bridge only validates the word (``schema.base.EffortLevel``) and carries it.
The agents service decides whether the agent's model supports it and maps it
onto the provider's knob.
"""
from __future__ import annotations

from typing import Any, get_args

from core.database import MessageTable
from schema import EffortLevel

#: Every level the bridge accepts, in order from least to most thinking.
EFFORT_LEVELS: tuple[str, ...] = get_args(EffortLevel)


def effort_context(user_message: MessageTable | None) -> dict[str, Any]:
    """The run context's ``effort`` entry for the turn ``user_message`` starts, or ``{}``.

    ``{"effort": "<level>"}`` only when the message carries a known level. No
    key at all otherwise, so a run without an effort sends exactly the config
    it sent before the feature existed. A stored value outside the known levels
    (which the schema never lets in) is dropped, not forwarded: fail closed.
    """
    effort = getattr(user_message, "effort", None)
    if not isinstance(effort, str) or effort not in EFFORT_LEVELS:
        return {}
    return {"effort": effort}
