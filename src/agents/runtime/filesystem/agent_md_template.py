"""Standard scaffold seeded into every user's AGENT.md on first contact.

The deepagents MemoryMiddleware loads /memories/AGENT.md into the system
prompt at the start of every conversation, so this file is durable cross-
agent memory shared by every deep agent the user interacts with. The user
never edits it directly — agents do, via the `edit_file` tool, as the user
shares facts that should outlive the current conversation.

The template gives the model clear structure to fill in (and signals what
belongs where) instead of confronting it with an empty file. Once seeded,
it is never overwritten — only the agent's own edits modify it.
"""
from __future__ import annotations


AGENT_MD_TEMPLATE = """\
# User Memory

This file is your persistent memory shared across every deep agent this user
interacts with. Treat it as durable, cross-conversation context. Update it via
the `edit_file` tool whenever the user shares facts that should outlive the
current conversation (preferences, recurring projects, important dates, people
they reference often, communication style).

Keep entries concise. Prefer bullet points over prose. Remove or rewrite stale
items rather than appending forever — this file is read into the system prompt
at the start of every conversation, so its length matters.

## About the User
<!-- Name, role, pronouns, time zone, language preferences. Fill in only what
the user has actually told you. Do not guess. -->

## Preferences
<!-- Communication style (concise vs detailed), tone, formatting preferences,
tools they prefer, things they explicitly asked not to do. -->

## Ongoing Context
<!-- Projects in progress, recurring topics, key people / teams the user works
with. Update when the situation changes; remove when no longer relevant. -->

## Notes
<!-- Anything the user explicitly asked to be remembered that doesn't fit
above. Date entries with absolute dates (YYYY-MM-DD) so they age gracefully. -->
"""
