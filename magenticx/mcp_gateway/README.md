# MCP Gateway

Wrapper around the `docker/mcp-gateway` image that serves a curated Model Context Protocol catalog over SSE for the agents service.

**This is an optional, opt-in add-on.** The core stack (`magenticx/docker-compose.yaml`) runs without it: the agents service has MCP off unless `MCP_GATEWAY_URL` is set, and then runs use each agent's own tools and the tool catalog is empty. Production (`docker-compose-denis*.yaml`) sets the URL and runs the gateway.

## What it does

- Hosts the MCP tool catalog on `http://mcp_gateway:8005/sse` (SSE transport) so the agents service can discover tools via `MCP_GATEWAY_URL`.
- Loads server definitions from `mcp_catalog.yaml` and limits the active set with the `--servers` flag passed in Compose (currently `tavily,arxiv-mcp-server`).
- Injects secrets from `mcp_secret.env` as a Docker secret (`/app/secrets/mcp_secret.env`) for catalog entries that need API keys.
- Passes server-specific config from `mcp_config.yaml` (e.g., the `arxiv-mcp-server` storage path) into the gateway.

## Files

- `mcp_catalog.yaml` – Docker MCP catalog used by the gateway; edit to add/remove servers or tweak metadata. Compose mounts this read-write if you need to iterate locally.
- `mcp_config.yaml` – optional per-server configuration (e.g., `arxiv-mcp-server.storage_path`).
- `mcp_secret.env` – key/value pairs for MCP server credentials (e.g. `tavily.api_token=...`). Copy `mcp_secret.example.env` to `mcp_secret.env` and fill it in.

## Running

### Turning MCP on locally

`magenticx/docker-compose-mcp.yaml` is its own compose project (`magenticx-mcp`) and joins the `mcp_net` network as **external** — `docker-compose.yaml` creates that network, so start the core stack first.

1. In `magenticx/.env`, set `MCP_GATEWAY_URL=http://mcp_gateway:8005/sse` (the core compose passes `${MCP_GATEWAY_URL-}` to agents; unset = MCP off).
2. In `magenticx/mcp_gateway/mcp_secret.env`, put `tavily.api_token=...`.
3. Start the core stack, then the gateway:

   ```bash
   docker compose -f magenticx/docker-compose.yaml up -d
   docker compose -f magenticx/docker-compose-mcp.yaml up -d
   ```

4. Recreate `agents` so it picks up the URL: `docker compose -f magenticx/docker-compose.yaml up -d --force-recreate agents`.

To turn MCP off again, unset `MCP_GATEWAY_URL` and recreate `agents`; stopping the gateway alone leaves MCP on but unreachable, so each run waits up to `MCP_CONNECT_TIMEOUT_SECONDS` (default 10) before continuing without MCP tools, and the tool catalog returns 502.

### Details

- Docker Compose starts the container privileged (dind) with `--transport=sse --port=8005 --servers=tavily,arxiv-mcp-server --catalog=./app/mcp_catalog.yaml --config=./app/mcp_config.yaml --secrets=/app/secrets/mcp_secret.env`.
- Agents use `http://mcp_gateway:8005/sse`; adjust `MCP_GATEWAY_URL` in the agents service if you change the port or transport.
- To enable more MCP servers, add them to `mcp_catalog.yaml`, supply any required credentials in `mcp_secret.env`, and append their ids to the `--servers` flag in `magenticx/docker-compose-mcp.yaml` (and `docker-compose-denis-mcp.yaml` for production).

## Security — trust boundary

The catalog is a **trust boundary**: every active MCP server runs as a container the gateway spawns, and its tool definitions are ingested wholesale by the agents service. Treat changes here like code, and review them as such.

- **Only the `--servers` allow-list is active.** `mcp_catalog.yaml` is the full upstream Docker catalog, but the gateway only runs the ids in `--servers` (currently `tavily,arxiv-mcp-server`). Adding an id there is a trust decision — do not enable a server you have not vetted.
- **Active server images are pinned by digest** (not floating tags), so a mutated upstream tag cannot be pulled silently:
  - `tavily` → `mcp/tavily@sha256:2aa224792bf91c2e2c959275bf6f81f4e8310593022cd72ed4049e52af3f1be9`
  - `arxiv-mcp-server` → `mcp/arxiv-mcp-server@sha256:6dc6bba6dfed97f4ad6eb8d23a5c98ef5b7fa6184937d54b2d675801cd9dd29e`
  - When enabling a new server, pin its image by digest the same way before adding it to `--servers`.
- **`privileged: true` is required, not incidental.** The `dind` gateway variant boots an inner `dockerd` to isolate the spawned MCP-server containers from the host daemon; Docker Swarm strips the mount-namespace capabilities `dind` needs, which is why the gateway runs as plain `docker compose` (not in the swarm stack). Container-escape-to-host risk is bounded by network isolation: the gateway sits only on the `mcp_gateway` overlay with no published host ports.
- **`/run` is a tmpfs, so the gateway survives reboots.** A host reboot kills the container mid-flight and Docker *restarts* (not re-creates) a plain-compose container, keeping its filesystem — including the inner dockerd's PID files. On restart containerd found its old PID (`failed to save daemon pid to disk: process with PID … is still running`), dockerd never started, and the gateway looped on *Waiting for dockerd…* with port 8005 closed: every run using MCP tools failed (today such a run carries on without its MCP tools instead — MCP is optional). This took Dennis's MCP tools down from the unattended kernel-update reboot of 2026-10-02 until a manual `--force-recreate`. With `/run` in memory every start is clean (in this image `/var/run` is a symlink to `/run`). Verified by killing and restarting the container twice: it serves again within seconds.
- **Residual (accepted):** the `dind` image cannot terminate TLS, so the `agents → mcp_gateway` hop is plaintext HTTP on the overlay (host-allowlisted + internal-trust header, but not encrypted). Revisit with a TLS-terminating sidecar / mTLS, and explore rootless-dind, if the gateway ever supports it.
- `mcp_secret.env` holds live credentials (e.g. `tavily.api_token`) and is gitignored — never commit it; copy `mcp_secret.example.env` and fill it in locally / on the VM only.
