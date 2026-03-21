---
name: writing
description: Workflow for producing and saving written output via the writer sub-agent.
---

# Writing

When producing written output:

1. **Delegate formatting** — send polished writing tasks to the `write` sub-agent. Pass it the raw material and clear instructions on tone, structure, and length.
2. **Save to store** — the writer sub-agent will save the document and return its filename. Confirm the filename to the user.
3. **Retrieve and revise** — if the user asks for edits, use `read_file` to load the existing document, then re-delegate with the revision instructions.
4. **Filename consistency** — use the naming convention from AGENT.md so files are easy to find later.
