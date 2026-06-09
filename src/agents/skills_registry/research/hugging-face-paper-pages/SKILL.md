---
name: hugging-face-paper-pages
description: Look up and read Hugging Face paper pages in markdown, and use the papers API for structured metadata such as authors, linked models/datasets/spaces, Github repo and project page. Use when the user shares a Hugging Face paper page URL, an arXiv URL or ID, or asks to summarize, explain, or analyze an AI research paper.
---

# Hugging Face Paper Pages

Look up AI research papers on Hugging Face paper pages (hf.co/papers) by fetching the content as markdown, or get structured metadata such as authors, linked models/datasets/spaces, Github repo and project page.

## When to Use

- User shares a Hugging Face paper page URL (e.g. `https://huggingface.co/papers/2602.08025`)
- User shares a Hugging Face markdown paper page URL (e.g. `https://huggingface.co/papers/2602.08025.md`)
- User shares an arXiv URL (e.g. `https://arxiv.org/abs/2602.08025` or  `https://arxiv.org/pdf/2602.08025`)
- User mentions a arXiv ID (e.g. `2602.08025`)
- User asks you to summarize, explain, or analyze an AI research paper

## Workflow

First, parse the paper ID from whatever the user provides:

| Input | Paper ID |
| --- | --- |
| `https://huggingface.co/papers/2602.08025` | `2602.08025` |
| `https://huggingface.co/papers/2602.08025.md` | `2602.08025` |
| `https://arxiv.org/abs/2602.08025` | `2602.08025` |
| `https://arxiv.org/pdf/2602.08025` | `2602.08025` |
| `2602.08025v1` | `2602.08025v1` |
| `2602.08025` | `2602.08025` |


### Step 1: Fetch the paper page as markdown

Prefer the direct markdown endpoint:

```bash
curl -s "https://huggingface.co/papers/{PAPER_ID}.md"
```

This should return the Hugging Face paper page as markdown. This relies on the HTML version of the paper at https://arxiv.org/html/{PAPER_ID}.

There are 2 exceptions:
- If the HTML version of the paper does not exist on arXiv, then the content falls back to the HTML of the Hugging Face paper page.
- If it results in a 404, it means the paper is not yet indexed on hf.co/papers. See [Error handling](#error-handling) for info.

Alternatively, you can request markdown from the normal paper page URL, like so:

```bash
curl -s -H "Accept: text/markdown" "https://huggingface.co/papers/{PAPER_ID}"
```

### Step 2: Use the papers API for structured metadata

Fetch the paper metadata as JSON using the Hugging Face REST API:

```bash
curl -s "https://huggingface.co/api/papers/{PAPER_ID}"
```

This returns structured metadata that can include:

- authors (names and Hugging Face usernames, in case they have claimed the papers)
- linked models, datasets, and Spaces
- media URLs
- summary (abstract) and AI-generated summary
- project page and GitHub repository
- organization and engagement metadata

API docs are listed in the Hugging Face OpenAPI papers section:

- `https://huggingface.co/spaces/huggingface/openapi#tag/papers`

### Step 3: Fallback if needed

If the Hugging Face paper page does not contain enough detail for the user's question:

- Check the regular paper page at `https://huggingface.co/papers/{PAPER_ID}`
- Fall back to the arXiv page or PDF for the original source:
  - `https://arxiv.org/abs/{PAPER_ID}`
  - `https://arxiv.org/pdf/{PAPER_ID}`

## Error Handling

- **404 on `https://huggingface.co/papers/{PAPER_ID}`**: the paper is not indexed on Hugging Face paper pages yet.
- **404 on `.md` endpoint**: the paper page may not be available yet on Hugging Face
- **404 on `/api/papers/{PAPER_ID}`**: the paper may not be indexed in the API yet
- **Paper ID not found**: verify the extracted arXiv ID, including any version suffix

## Notes

- No authentication is required for public paper pages.
- Prefer the `.md` endpoint for reliable machine-readable output.
- Prefer `/api/papers/{PAPER_ID}` when you need structured JSON fields instead of page markdown.
