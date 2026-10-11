---
name: create-skill
description: Turn what you did here into a reusable skill
kind: prompt
argument-hint: "[skill name]"
requires: [deep_agent]
---
Turn the way this conversation's task was done into a reusable skill with the `create_skill` tool: a name (use the user's below if given), a description that says when to use it, and clear step-by-step instructions that work without this conversation. Leave out anything specific to this one case.
