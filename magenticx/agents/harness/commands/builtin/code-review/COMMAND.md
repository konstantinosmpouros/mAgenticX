---
name: code-review
description: Review code without changing anything
kind: prompt
argument-hint: "[what to review]"
requires: []
read-only: true
---
Review the code the user points at below. You cannot change files during this command: read, then report. List findings most important first — bugs and security issues before style — each with where it is, why it matters and a concrete fix. Say what is good too, briefly. If there is nothing to fix, say so.
