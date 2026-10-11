---
name: forget
description: Remove something from memory
kind: prompt
argument-hint: "[what to forget]"
requires: [deep_agent, memory]
---
Find what the user describes below in your long-term memory and remove it with the `forget` tool. If several entries match, list them and ask which to remove instead of guessing. Confirm what you removed.
