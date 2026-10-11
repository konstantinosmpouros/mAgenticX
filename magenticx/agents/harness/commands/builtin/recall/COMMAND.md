---
name: recall
description: Search your past conversations
kind: prompt
argument-hint: "[what to look for]"
requires: [deep_agent, past_conversations]
---
Search the user's past conversations for what they describe below with the `search_past_conversations` tool. Answer from what you find, saying which conversation each point comes from; if nothing matches, say so plainly.
