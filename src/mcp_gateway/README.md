# MCP Gateway

Wrapper around the `docker/mcp-gateway` image that serves a curated Model Context Protocol catalog over SSE for the agents service.

## What it does

- Hosts the MCP tool catalog on `http://mcp_gateway:8005/sse` (SSE transport) so the agents service can discover tools via `MCP_GATEWAY_URL`.
- Loads server definitions from `mcp_catalog.yaml` and limits the active set with the `--servers` flag passed in Compose (currently `tavily,arxiv-mcp-server`).
- Injects secrets from `mcp_secret.env` as a Docker secret (`/app/secrets/mcp_secret.env`) for catalog entries that need API keys.
- Passes server-specific config from `mcp_config.yaml` (e.g., the `arxiv-mcp-server` storage path) into the gateway.

## Files

- `mcp_catalog.yaml` – Docker MCP catalog used by the gateway; edit to add/remove servers or tweak metadata. Compose mounts this read-write if you need to iterate locally.
- `mcp_config.yaml` – optional per-server configuration (e.g., `arxiv-mcp-server.storage_path`).
- `mcp_secret.env` – key/value pairs for MCP server credentials (e.g. `tavily.api_token=...`). `mcp_sercret.example.env` is a typoed sample to copy from—rename it to `mcp_secret.env` when filling in secrets.

## Running

- Docker Compose starts the container with `--transport=sse --port=8005 --servers=tavily,arxiv-mcp-server --catalog=./app/mcp_catalog.yaml --config=./app/mcp_config.yaml --secrets=/app/secrets/mcp_secret.env` and mounts the Docker socket for servers that require it.
- Agents use `http://mcp_gateway:8005/sse`; adjust `MCP_GATEWAY_URL` in the agents service if you change the port or transport.
- To enable more MCP servers, add them to `mcp_catalog.yaml`, supply any required credentials in `mcp_secret.env`, and append their ids to the `--servers` flag in `src/docker-compose.yaml`.

## Security — trust boundary

The catalog is a **trust boundary**: every active MCP server runs as a container the gateway spawns, and its tool definitions are ingested wholesale by the agents service. Treat changes here like code, and review them as such.

- **Only the `--servers` allow-list is active.** `mcp_catalog.yaml` is the full upstream Docker catalog, but the gateway only runs the ids in `--servers` (currently `tavily,arxiv-mcp-server`). Adding an id there is a trust decision — do not enable a server you have not vetted.
- **Active server images are pinned by digest** (not floating tags), so a mutated upstream tag cannot be pulled silently:
  - `tavily` → `mcp/tavily@sha256:2aa224792bf91c2e2c959275bf6f81f4e8310593022cd72ed4049e52af3f1be9`
  - `arxiv-mcp-server` → `mcp/arxiv-mcp-server@sha256:6dc6bba6dfed97f4ad6eb8d23a5c98ef5b7fa6184937d54b2d675801cd9dd29e`
  - When enabling a new server, pin its image by digest the same way before adding it to `--servers`.
- **`privileged: true` is required, not incidental.** The `dind` gateway variant boots an inner `dockerd` to isolate the spawned MCP-server containers from the host daemon; Docker Swarm strips the mount-namespace capabilities `dind` needs, which is why the gateway runs as plain `docker compose` (not in the swarm stack). Container-escape-to-host risk is bounded by network isolation: the gateway sits only on the `mcp_gateway` overlay with no published host ports.
- **Residual (accepted):** the `dind` image cannot terminate TLS, so the `agents → mcp_gateway` hop is plaintext HTTP on the overlay (host-allowlisted + internal-trust header, but not encrypted). Revisit with a TLS-terminating sidecar / mTLS, and explore rootless-dind, if the gateway ever supports it.
- `mcp_secret.env` holds live credentials (e.g. `tavily.api_token`) and is gitignored — never commit it; copy `mcp_secret.example.env` and fill it in locally / on the VM only.
