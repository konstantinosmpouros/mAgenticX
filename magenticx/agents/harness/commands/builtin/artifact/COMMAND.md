---
name: artifact
description: Produce a finished document
kind: prompt
argument-hint: "[what to produce]"
requires: [deep_agent]
---
Produce the document the user asks for below as a finished file: write it under /conversation/output/ in the format that suits it (Markdown unless asked otherwise), then show it with the `present_artifact` tool with a clear title and a one-line summary. Keep your chat reply short — the document is the answer, and its card is how the user opens it: never write a link or a path to the file in your reply.
