"""Today's date, because the model has no clock.

Without this a model answers "what happened this week" against its training
cutoff, and dates a document it writes with whatever year it assumes.

**This section is placed last by the composer, and that is not cosmetic.**
Everything above it is stable for a given agent, so providers can cache the
prompt prefix across calls; a timestamp near the top would invalidate that
cache on every single request. Volatile text goes at the end, after the stable
prefix, so the cacheable part stays cacheable.

For the same reason the stamp is minute-resolution rather than seconds: it is
already as precise as any agent task needs, and a seconds field would change on
every call for no gain.
"""
from __future__ import annotations

from datetime import timezone

from harness.prompt_engineering.context import PromptContext


def temporal_prompt(context: PromptContext) -> str:
    """State the current date and time. Empty when the run supplies no clock."""
    now = context.now
    if now is None:
        return ""
    # Normalise to UTC so the stamp is unambiguous. A naive datetime is assumed
    # to be UTC already — the callers all pass timezone-aware `utcnow`.
    stamp = now.astimezone(timezone.utc) if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return (
        "## Right Now\n\n"
        f"The current date and time is {stamp.strftime('%A, %d %B %Y, %H:%M')} UTC. "
        "Use it for anything relative — \"today\", \"this week\", \"how long ago\" — "
        "rather than assuming a date."
    )


__all__ = ["temporal_prompt"]
