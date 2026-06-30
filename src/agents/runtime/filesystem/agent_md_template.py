"""Standard scaffold seeded into every (user, agent) ``AGENTS.md`` on first contact.

``AGENTS.md`` is this agent's **memory index** for one user. The deepagents
MemoryMiddleware loads it into the system prompt at the start of every
conversation, so it must stay compact: each saved memory contributes one short
summary line plus a pointer to a detail file under ``entries/<name>.yml`` that
the agent reads on demand (the skills progressive-disclosure pattern). The
``remember`` tool maintains both the index line and the yml — the user never
edits this directly. Memory is per-(user, agent), so it never bleeds across
agents. Once seeded the template is never overwritten — only the agent's own
``remember`` calls (and edits) modify it.
"""
from __future__ import annotations


AGENTS_MD_TEMPLATE = """\
# Agent Memory

This is your long-term memory for this user, persisted across every
conversation you have with them. Each line under **Memories** is a short
summary of one durable fact plus a pointer to its detail file in `entries/`.
Read the linked `entries/<name>.yml` with `read_file` when an entry looks
relevant to the current task — the summaries here are deliberately terse.

To save something, call the `remember` tool (it writes the `entries/<name>.yml`
and keeps the index below in sync). Save only durable, reusable facts —
preferences, recurring projects, key people, decisions, important dates — never
transient chatter. Re-`remember` with the same name to update an entry.

## Memories
<!-- The remember tool maintains one line per memory below this header. -->
"""
