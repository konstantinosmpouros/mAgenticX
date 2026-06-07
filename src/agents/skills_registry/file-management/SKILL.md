---
name: file-management
description: Rules for managing the persistent file store — naming, deduplication, retrieval, and cleanup.
---

# File Management

Rules for managing the persistent store:

1. **Check before creating** — run `ls` or `glob` at the start of every task to avoid duplicating existing work.
2. **Overwrite intentionally** — only overwrite an existing file when explicitly asked to update it.
3. **Descriptive names** — filenames must clearly describe the content. Avoid generic names like `output.md` or `result.txt`.
4. **Retrieve on request** — when the user asks about past work, use `glob` with a relevant pattern, then `read_file` to load and present the content.
5. **Clean up** — do not accumulate temporary or intermediate files; only persist final outputs.
