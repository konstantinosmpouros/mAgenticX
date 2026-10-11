---
name: remember
description: Save something to memory
kind: prompt
argument-hint: "[what to remember]"
requires: [deep_agent, memory]
---
Save what the user gives below to your long-term memory with the `remember` tool, as one clear, self-contained entry. If it updates something you already remember, update that entry instead of adding a second one. Then confirm in one sentence what you saved.
