# MCP Gateway

Wrapper around the `docker/mcp-gateway` image that serves a curated Model Context Protocol catalog over SSE for the agents service.

## What it does

- Hosts the MCP tool catalog on `http://mcp_gateway:8005/sse` (SSE transport) so the agents service can discover tools via `MCP_TOOLS_HTTP_URL`.
- Loads server definitions from `mcp_catalog.yaml` and limits the active set with the `--servers` flag passed in Compose (currently `tavily,arxiv-mcp-server`).
- Injects secrets from `mcp_secret.env` as a Docker secret (`/app/secrets/mcp_secret.env`) for catalog entries that need API keys.
- Passes server-specific config from `mcp_config.yaml` (e.g., the `arxiv-mcp-server` storage path) into the gateway.

## Files

- `mcp_catalog.yaml` – Docker MCP catalog used by the gateway; edit to add/remove servers or tweak metadata. Compose mounts this read-write if you need to iterate locally.
- `mcp_config.yaml` – optional per-server configuration (e.g., `arxiv-mcp-server.storage_path`).
- `mcp_secret.env` – key/value pairs for MCP server credentials (e.g. `tavily.api_token=...`). `mcp_sercret.example.env` is a typoed sample to copy from—rename it to `mcp_secret.env` when filling in secrets.

## Running

- Docker Compose starts the container with `--transport=sse --port=8005 --servers=tavily,arxiv-mcp-server --catalog=./app/mcp_catalog.yaml --config=./app/mcp_config.yaml --secrets=/app/secrets/mcp_secret.env` and mounts the Docker socket for servers that require it.
- Agents use `http://mcp_gateway:8005/sse`; adjust `MCP_TOOLS_HTTP_URL` in the agents service if you change the port or transport.
- To enable more MCP servers, add them to `mcp_catalog.yaml`, supply any required credentials in `mcp_secret.env`, and append their ids to the `--servers` flag in `src/docker-compose.yaml`.
