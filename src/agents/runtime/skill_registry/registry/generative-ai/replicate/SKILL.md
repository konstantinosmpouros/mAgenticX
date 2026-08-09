---
name: replicate
description: Discover, compare, and run AI models using Replicate's API
---

## Docs

- Reference docs: https://replicate.com/docs/llms.txt
- HTTP API schema: https://api.replicate.com/openapi.json
- MCP server: https://mcp.replicate.com
- Set an `Accept: text/markdown` header when requesting docs pages to get a Markdown response.

## Choosing models

- Use the search and collections APIs to find and compare models
- Use official models because they:
  - are always running
  - have stable API interfaces
  - have predictable output pricing
  - are maintained by Replicate staff
- If you must use a community model, be aware that it can take a long time to boot.
- You can create always-on deployments of community models, but you pay for model uptime.

## Running models

Models take time to run. There are three ways to run a model via API and get its output:

1. Create a prediction, store its id from the response, and poll until completion.
2. Set a `Prefer: wait` header when creating a prediction for a blocking synchronous response. Only recommended for very fast models.
3. Set an HTTPS webhook URL when creating a prediction, and Replicate will POST to that URL when the prediction completes.

- Use the "POST /v1/predictions" endpoint to run models, as it supports both official and community models.
- Every model has its own OpenAPI schema. Always fetch and check model schemas to make sure you're setting valid inputs.
- Use HTTPS URLs for file inputs whenever possible. You can also send base64-encoded files, but they should be avoided.
- Fire off multiple predictions concurrently. Don't wait for one to finish before starting the next.
- Output file URLs expire after 1 hour, so back them up if you need to keep them using a service like Cloudflare R2.
- Webhooks are a good mechanism for receiving and storing prediction output.