# MCP Gateway

Wrapper around the `docker/mcp-gateway` image that serves a curated Model Context Protocol catalog over SSE for the agents service.

## What it does

- Hosts the MCP tool catalog on `http://mcp_gateway:8005/sse` (SSE transport) so the agents service can discover tools via `MCP_TOOLS_HTTP_URL`.
- Loads server definitions from `catalog.yaml` and limits the active set with the `--servers` flag passed in Compose (currently `tavily` by default).
- Injects secrets from `mcp_secret.env` as a Docker secret (`/run/secrets/mcp_secret`) for catalog entries that need API keys.

## Files

- `catalog.yaml` – Docker MCP catalog used by the gateway; edit to add/remove servers or tweak metadata.
- `mcp_secret.env` – key/value pairs for MCP server credentials (e.g. `tavily.api_token=...`). Update this before running the gateway.

## Running

- Docker Compose starts the container with `--transport=sse --port=8005 --catalog=./app/catalog.yaml --servers=tavily --secrets=/run/secrets/mcp_secret` and mounts the Docker socket for servers that require it.
- Agents use `http://mcp_gateway:8005/sse`; adjust `MCP_TOOLS_HTTP_URL` in the agents service if you change the port or transport.
