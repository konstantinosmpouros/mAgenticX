# Configuration — Every Environment Variable, Per Service

Each Python service is configured entirely through environment variables read by **Pydantic `BaseSettings`** classes in its `core/settings.py`; the infrastructure services (Postgres, Redis, Chroma, nginx) are configured by image env vars and command flags. The sibling projects — the MCP gateway, the sandbox runner and the monitoring stack — are configured in their own repositories. This document is the exhaustive reference for *how much you can tune each service without touching code* — every var, its default, and what it does. For the inverse — the short list of *what each service cannot boot without* — see its companion, [service-startup.md](service-startup.md). Defaults shown are the **in-code defaults**; the production compose overrides only a handful (mostly URLs, TLS paths, `LOG_FORMAT=json`, and `*_FILE` secret pointers). Settings are **case-insensitive**, load from `magenticx/.env` in local dev, and ignore unknown vars (`extra="ignore"`). Anything backed by a secret follows the `<NAME>_FILE` indirection documented in [secrets.md](secrets.md).

---

## Services Involved

```mermaid
flowchart LR
    Env[".env / compose env / Swarm secret files"] --> S1["dialogue_bridge<br/>core/settings.py"]
    Env --> S2["agents<br/>core/settings.py"]
    Env --> S3["rag_service<br/>core/settings.py"]
    Env --> S4["infra: postgres · redis · chroma<br/>nginx"]
    EP["entrypoint-*.sh"] -->|"REQUIRE_TLS / REQUIRE_MTLS"| S1 & S2 & S3 & S4
```

## How to read these tables

- **Env var** is the exact name to set (in `.env`, the compose `environment:` list, or Portainer's env dropdown for non-secrets).
- **Default** is what you get if the var is unset. `—` means required (no default; startup fails if missing). `(secret)` means it resolves via `*_FILE` or the plain var per [secrets.md](secrets.md).
- A few vars accept **alias names** (shown as `A` / `B`) via Pydantic `AliasChoices` — either works.
- **CSV** vars accept a comma-separated string (e.g. `a,b,c`).
- Validated bounds, where they exist, are noted — out-of-range values raise at startup.

---

## dialogue_bridge

The BFF. The richest configuration surface — 19 settings groups.

### App & lifecycle

| Env var | Default | What it does |
| --- | --- | --- |
| `APP_ENV` / `ENV` | `development` | Environment name. **Anything other than `development`/`test` makes `SESSION_TOKEN_SECRET` mandatory, refuses the dev file signer (`SESSION_SIGNING_BACKEND=file`)** and disables dev secret fallbacks. **Dennis sets `APP_ENV=production` explicitly** — unset means `development`, which silently switches all of this off. |
| `APP_VERSION` / `IMAGE_TAG` | `unknown` | Version string stamped onto every log line. |
| `LOG_SERVICE_NAME` | `dialogue_bridge` | `service` field in logs. |
| `RUN_MIGRATIONS_ON_STARTUP` | `true` | Run `alembic upgrade head` in the lifespan before serving. Set `false` as the emergency knob if a bad migration is keeping the container down. |

### Database (`DatabaseSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | — | `postgresql+asyncpg://…` URL. Password may be omitted and spliced in from the secret. |
| `DATABASE_PASSWORD_FILE` | (secret) | File-backed DB password, spliced into a password-less `DATABASE_URL`. An inline password in the URL always wins (local dev). |
| `DATABASE_ECHO` | `false` | SQLAlchemy statement echo. |
| `DATABASE_POOL_PRE_PING` | `true` | Validate pooled connections before use. |
| `DATABASE_POOL_RECYCLE` | `1800` | Recycle connections older than N seconds. |
| `DATABASE_POOL_SIZE` | `5` | Base async pool size. |
| `DATABASE_MAX_OVERFLOW` | `20` | Extra connections allowed above pool size under load. |

### Session & cookies (`SessionSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `SESSION_COOKIE_SECURE` | `true` | `Secure` flag on auth cookies. With this on **and** no domain set, cookie names get the `__Host-` prefix. |
| `SESSION_COOKIE_SAMESITE` | `lax` | `SameSite` policy. |
| `SESSION_COOKIE_DOMAIN` | `None` | Cookie domain; `None` ⇒ host-locked (`__Host-` names). |
| `SESSION_COOKIE_NAME` | auto | Access-cookie name; defaults to `__Host-mx_session` (host-locked) or `mx_session`. |
| `SESSION_REFRESH_COOKIE_NAME` | auto | Refresh-cookie name; `__Host-mx_refresh` / `mx_refresh`. |
| `SESSION_CSRF_COOKIE_NAME` | auto | CSRF-cookie name; `__Host-mx_csrf` / `mx_csrf`. |
| `SESSION_CSRF_HEADER_NAME` | `X-CSRF-Token` | Header the SPA echoes the CSRF token in. |
| `SESSION_TOKEN_SECRET` | (secret) | General-purpose HMAC key (DOCX-preview tokens). Required outside dev/test; dev generates a random one. |

### Session signing (`SigningSettings`)

Who signs session JWTs and which public keys verify them. Production signs with an **HSM-protected RSA key in OCI KMS**; local dev signs with a file key. Verification never makes a network call — every accepted public key is a file loaded at boot. The bridge **refuses to start** if this is incomplete, in every environment. See [authentication-and-session.md § Phase 3](../flows/authentication-and-session.md#phase-3--token-minting-kms-signed-jwts).

| Env var | Default | What it does |
| --- | --- | --- |
| `SESSION_SIGNING_BACKEND` | `kms` | `kms` (production) or `file` (local dev only — refused unless `APP_ENV` is `development`/`test`). |
| `SESSION_SIGNING_ACTIVE_KID` | `100` | `kid` stamped on newly minted tokens. 1 … 100000. |
| `SESSION_SIGNING_KEYS` | `None` | `kid:key_version_ocid,…` — the KMS key versions the bridge may sign with. Must include the active kid. Required for `kms`. |
| `SESSION_SIGNING_LEGACY_KIDS` | `None` | Comma list of **verify-only** kids: public keys of a retired signing key whose private half is no longer reachable, so tokens it signed keep verifying until they age out. Each needs its `<kid>.pem`; none may be the active kid or a `SESSION_SIGNING_KEYS` kid. Unset on Dennis — its last use, the pre-plan-29 key `1`, was removed on 2026-10-10. |
| `SESSION_SIGNING_PUBLIC_KEYS_DIR` | `/app/signing_keys` | Directory of `<kid>.pem` public keys; every accepted kid needs one. Bind-mounted on Dennis from `/opt/magenticx/dialogue_bridge/signing_keys/`. |
| `SESSION_SIGNING_PRIVATE_KEY_FILE` | (secret) | `file` backend only: the unencrypted PEM private key. |
| `OCI_KMS_CRYPTO_ENDPOINT` | `None` | The crypto endpoint of the OCI KMS "vault" holding the key (`https://…-crypto.kms.<region>.oraclecloud.com`). Must be `https://`. OCI calls a KMS key container a *vault* — unrelated to the HashiCorp Vault this platform no longer uses. |
| `OCI_KMS_KEY_ID` | `None` | OCID of the HSM signing key. |
| `OCI_USER_OCID` / `OCI_TENANCY_OCID` / `OCI_API_KEY_FINGERPRINT` / `OCI_REGION` | `None` | Identity of the dedicated signing principal. |
| `OCI_API_PRIVATE_KEY_FILE` | (secret) | That principal's API key (Swarm secret `magenticx_oci_signer_key`). |
| `OCI_KMS_CONNECT_TIMEOUT_SECONDS` / `OCI_KMS_READ_TIMEOUT_SECONDS` | `5.0` / `10.0` | Per-call KMS timeouts. 0.5 … 60. The SDK does not retry `sign`, by design. |

### JWT (`JWTSettings`)

| Env var | Default | What it does | Bounds |
| --- | --- | --- | --- |
| `JWT_ISSUER` | `magenticx-bridge` | `iss` claim. | — |
| `JWT_AUDIENCE` | `magenticx` | `aud` claim. | — |
| `JWT_ACCESS_TTL_SECONDS` | `28800` (8h) | Access-token lifetime. | 60 … 86400 |
| `JWT_REFRESH_IDLE_TTL_SECONDS` | `1036800` (12d) | Rolling idle window — refresh `exp` slides forward by this on each refresh. Being idle longer than this logs the user out. | 300 … 2592000 |
| `JWT_REFRESH_ABSOLUTE_TTL_SECONDS` | `1728000` (20d) | Hard cap from original login — the refresh `exp` never exceeds `lat + this`, forcing a full re-auth. | 3600 … 15552000 |
| `JWT_REFRESH_REUSE_GRACE_SECONDS` | `30` | Grace during which the just-rotated-from refresh `jti` is still accepted (avoids false reuse-detection on a retried/concurrent refresh). | 0 … 300 |
| `JWT_LEEWAY_SECONDS` | `30` | Clock-skew leeway on verification. | 0 … 300 |

### Microsoft Entra ID / OIDC (`EntraSettings`)

**The only way to sign in** (plan 29 removed username/password). `ENTRA_TENANT_ID` + `ENTRA_CLIENT_ID` + `ENTRA_CLIENT_SECRET` are **mandatory in every environment**: the bridge refuses to start without all three, because it would otherwise serve a login page with no way in. Local dev uses the same app registration with `http://localhost:8050/api/v1/auth/oidc/callback` added to its redirect URIs.

| Env var | Default | What it does |
| --- | --- | --- |
| `ENTRA_TENANT_ID` | `None` | Directory (tenant) id. |
| `ENTRA_CLIENT_ID` | `None` | Application (client) id of the app registration. |
| `ENTRA_CLIENT_SECRET` | (secret) | Client secret (file-backed via `ENTRA_CLIENT_SECRET_FILE` / Swarm secret in prod). **Expires** — an expired secret is a full new-login outage; its date is recorded in [secrets.md](secrets.md). |
| `ENTRA_REDIRECT_URI` | `None` | Exact registered callback URL, e.g. `http://localhost:8050/api/v1/auth/oidc/callback`. Falls back to forwarded-origin derivation if unset. |
| `ENTRA_ALLOWED_GROUP_IDS` | `None` | Comma-separated Entra security-group Object IDs allowed to sign in. Empty = no restriction (enforced fail-closed). |
| `ENTRA_POST_LOGIN_REDIRECT` | `/` | SPA path to land on after a successful SSO login. |
| `ENTRA_LOGIN_ERROR_REDIRECT` | `/login` | SPA path (with an `?sso=<reason>` query) to bounce to when SSO is denied/fails. |
| `ENTRA_AUTHORITY_HOST` | `https://login.microsoftonline.com` | Entra authority host (override for sovereign clouds). |

### Internal TLS client (`TlsSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `INTERNAL_CA_CERT_PATH` | `None` | CA used to verify peer services (and Postgres `verify-full`). |
| `INTERNAL_CLIENT_CERT_PATH` | `None` | This service's client cert, presented for mTLS to `agents`. (Wrapped in `SecretStr` so the path can't leak in a settings dump.) |
| `INTERNAL_CLIENT_KEY_PATH` | `None` | Matching client key. |

### Upstream, inference, rate limits

| Env var | Default | What it does |
| --- | --- | --- |
| `AGENTS_SERVICE_URL` | `https://agents:8003` | Base URL of the agents service. |
| `INFERENCE_TOOL_RESULT_MAX_CHARS` | `16000` | Cap on stored `TOOL_CALL_RESULT` content in the event log; oversized results are truncated and flagged. |
| `INFERENCE_WS_SUBSCRIBE_TIMEOUT_SECONDS` | `10.0` | Timeout waiting to subscribe to a run's Redis stream. |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `15` | Login attempts per window (per resolved client IP). Covers `POST /login` (including `?park=true`, the add-account path) and `GET /oidc/login`, so a single user adding an account spends more than one attempt; shared NAT/proxy egress IPs spend several. |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` | Auth rate-limit window. |
| `INFERENCE_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Inference starts per window (per user). |
| `INFERENCE_RATE_LIMIT_WINDOW_SECONDS` | `60` | Inference rate-limit window. |
| `SPEECH_RATE_LIMIT_MAX_ATTEMPTS` | `20` | Speech calls (dictation, read-aloud, previews) per window (per user). |
| `SPEECH_RATE_LIMIT_WINDOW_SECONDS` | `60` | Speech rate-limit window. |
| `VOICE_SESSION_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `15` / `60` | Realtime voice session creation (paid OpenAI Realtime) per user. |
| `EXPORT_PDF_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Conversation PDF exports (CPU-heavy render) per user. |
| `SHARE_CREATE_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Share-link creation (mints public tokens) per user. |
| `SKILL_UPLOAD_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Custom-skill uploads (agents-service disk writes) per user. |
| `SKILL_CATALOGUE_SEARCH_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `60` / `60` | Skill catalogue searches per verified session (the search runs as the user types, debounced). |
| `EXPORT_TOKEN_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Data-export download tokens per user (the export itself is bounded by the cooldown column). |
| `ACCOUNT_DELETION_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `3600` | Requesting or cancelling an account deletion, per user. |
| `COMMANDS_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `120` / `60` | The composer's slash-command menu (`GET /v1/commands/{user}/{agent}`), per user. |
| `PROFILE_UPDATE_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `20` / `3600` | Changing the display name or photo in Edit profile, per user. |
| `AVATAR_MAX_UPLOAD_BYTES` | `5242880` | Largest photo upload accepted; refused while reading, before decoding. |
| `AVATAR_READ_CHUNK_BYTES` | `65536` | Chunk size the upload is read in. |
| `AVATAR_MAX_PIXELS` | `40000000` | Largest image (width × height, from its header) the decoder will touch. |
| `AVATAR_SIZE_PX` | `256` | Side of the square WebP that is stored. |
| `SKILL_REMOTE_ADD_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Remote-skill Adds per user — each can make the agents service download a skill, so the Add route cannot be used as a fetch amplifier. |
| `AGENT_IMPORT_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Agent-builder imports per user (`POST /v1/agents/{user_id}/custom/import`): each unpacks an upload in memory and has the agents service parse it. |
| `AGENT_TRIAL_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `30` / `60` | Agent-builder "Try it" messages per user (`POST /v1/agents/{user_id}/custom/try`, plan 40): each starts a run and carries the whole draft. Its own bucket, so trying a draft never uses up chat starts. |
| `WORKFLOW_READ_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `60` / `60` | Workflows (plan 38), per user: reading definitions, run lists, run detail and opening a run's event stream. |
| `WORKFLOW_MUTATE_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `20` / `60` | Workflows, per user: create, save, delete a definition; cancel a run. |
| `WORKFLOW_BUILDER_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `120` / `60` | Workflows: the node catalog and live validation, called while editing. No `{user_id}` in their path, so keyed on the verified session. |
| `WORKFLOW_RUN_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `6` / `60` | Workflows, per user: starting or resuming a run — each spends work on the user's behalf, so the tightest bucket. |
| `MESSAGE_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `30` / `60` | Message creation (attachment/blob growth) per user. |
| `SUGGESTIONS_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Starter-suggestion generation (LLM-backed) per user. |
| `COMPACTION_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `600` | Compacting a conversation from the context ring, or undoing it (plan 34), per user, after auth — each compaction is a summary call over most of the conversation. |
| `USAGE_ANALYTICS_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `60` / `60` | Every Settings → Usage read (plan 33), per user, after auth. Generous for browsing; one conversation's page can count older answers from their event logs. |
| `REFRESH_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `10` / `60` | Session refresh (OCI KMS mint) per client IP. |
| `WS_CONNECT_RATE_LIMIT_MAX_ATTEMPTS` / `_WINDOW_SECONDS` | `20` / `60` | Run-stream WebSocket handshakes per user (enforced in-route; close code `4429`). |
| `USER_RATE_LIMIT_MAX_CALLS` | `300` | App-wide aggregate budget per verified user (per-IP fallback) per window. |
| `USER_RATE_LIMIT_WINDOW_SECONDS` | `60` | Budget window. |
| `INFERENCE_MAX_ACTIVE_RUNS_PER_USER` | `5` | Concurrent in-flight runs per user. |

Every per-user limit (keyed on the path's `{user_id}`) is declared as an endpoint parameter **after** the auth and CSRF dependencies, never in `dependencies=[...]` on the route or router — FastAPI solves those first, which would let an anonymous caller drain any user's budget by naming them in the URL. `tests/dialogue_bridge/test_rate_limit_order.py` checks every route. The login/refresh limits (per IP) and the catalogue search (per verified session) stay route-level, because they must apply before authentication.

All rate limits are counted in **Redis** via `fastapi-redis-sdk` (they survive restarts and hold across replicas) and **fail open** on a Redis outage. The SDK's own `REDIS_*` env settings are **not** read from the environment — `core/cache/integration.py` primes them programmatically from the values above plus the Redis section below (so the file-backed password and internal CA are honored), then scrubs the password back out of the process env.

### Model pricing (`PricingSettings`)

The Usage tab's cost figures (plan 41, see [usage-analytics](../flows/usage-analytics.md#pricing)). The default price table lives in `utils/model_pricing.py`; these variables only override it.

| Env var | Default | What it does |
| --- | --- | --- |
| `MODEL_PRICES_JSON` | empty (defaults only) | JSON object `{model: prices}` merged over the defaults, USD per 1M tokens. An entry replaces that model's whole default, adds a new model, or — with `null` — removes a default price (the model becomes "unpriced"). |
| `MODEL_PRICES_JSON_FILE` | unset | Path to a file holding the same JSON (the repo's `*_FILE` convention); wins over `MODEL_PRICES_JSON` when set and non-empty. |

```json
{
  "gpt-4.1": {"input": 2.00, "cached_input": 0.50, "output": 8.00},
  "my-proxy:custom-model": {"input": 1.00, "output": 4.00},
  "gpt-6-luna": {
    "input": 0.10, "cached_input": 0.01, "output": 0.50,
    "long_context": {"above_input_tokens": 272000, "input": 0.20, "cached_input": 0.02, "output": 0.75}
  },
  "o3-mini": null
}
```

`input` and `output` are required; `cached_input` defaults to `input`; `long_context` replaces all three prices for a call whose input exceeds `above_input_tokens` (a positive integer). Prices must be non-negative numbers, and unknown keys are refused (a typo such as `"ouput"` must not price at zero). The table is parsed when `utils.model_pricing` is imported at startup: **bad JSON or a bad entry stops the bridge**. A model name is matched exactly, then without a `provider:` prefix, then without a `-YYYY-MM-DD` suffix. Changing a price never re-prices stored answers. The defaults are estimates — verify them against your invoice.

### Redis (`RedisSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `REDIS_URL` | `redis://redis:6379/0` | Stream backend (prod uses `rediss://`). |
| `REDIS_PASSWORD` | (secret) | Redis AUTH password. |
| `REDIS_STREAM_MAXLEN` | `20000` | Max entries per per-run event stream (approx-trimmed). |
| `REDIS_STREAM_TERMINAL_TTL_SECONDS` | `3600` | TTL on a stream after the run reaches a terminal state. |
| `REDIS_STREAM_READ_BLOCK_MS` | `30000` | Blocking-read timeout when tailing a stream. |

### Data export (`ExportSettings`)

See [data-export](../flows/data-export.md). The archive is streamed, so these bound what is in flight, not its size.

| Env var | Default | What it does |
| --- | --- | --- |
| `DATA_EXPORT_ENABLED` | `true` | Kill switch: `false` stops new exports (status reports it, the token is refused) without a release. Set in neither compose. |
| `EXPORT_COOLDOWN_MINUTES` | `10080` | One export per user per window (a week), enforced on `users.last_export_at`; 1–43200 (30 days). |
| `EXPORT_MAX_CONCURRENT` | `2` | Exports at once across the service (1–4), one per user. |
| `EXPORT_PAGE_ROWS` | `50` | Rows per keyset page (1–500). |
| `EXPORT_CHUNK_BYTES` | `1048576` | Bytes per attachment slice (64 KiB – 8 MiB). |
| `EXPORT_MAX_SECONDS` | `21600` | Absolute ceiling on one export (600–86400) — a backstop; the stall timeout is what ends a dead download. |
| `EXPORT_STALL_SECONDS` | `300` | A download whose client accepts nothing for this long is ended, freeing its slot and cooldown (30–3600). |
| `EXPORT_MAX_BYTES_PER_SECOND` | `26214400` | Speed cap for one export (~200 Mbit/s; 1 MiB – 1 GiB). |
| `EXPORT_TOKEN_TTL_SECONDS` | `60` | Lifetime of the one-time download token. |

### Account deletion (`AccountDeletionSettings`)

See [account-deletion](../flows/account-deletion.md). The batch and rate bounds are what keep a purge of a very large account from locking tables or saturating a disk the other stacks share; none of them limits the account's size.

| Env var | Default | What it does |
| --- | --- | --- |
| `ACCOUNT_DELETION_ENABLED` | `true` | Kill switch: `false` refuses new requests and pauses the purger. Set in neither compose. |
| `ACCOUNT_DELETION_GRACE_DAYS` | `14` | Days from the request to the purge; signing in during them can cancel (1–30, never 0). |
| `ACCOUNT_DELETION_REAUTH_MAX_AGE_SECONDS` | `600` | A request needs a Microsoft sign-in at most this old (60–3600). |
| `ACCOUNT_PURGE_INTERVAL_SECONDS` | `300` | How often the purger looks for a due deletion. |
| `ACCOUNT_PURGE_CONVERSATION_BATCH` | `25` | Conversations per purge round. |
| `ACCOUNT_PURGE_MESSAGE_BATCH` | `1000` | Messages per delete transaction. |
| `ACCOUNT_PURGE_BLOB_BATCH` / `_BLOB_BATCH_BYTES` | `20` / `67108864` | Attachment blobs per transaction — at most this many and this many bytes (always at least one). |
| `ACCOUNT_PURGE_MAX_BYTES_PER_SECOND` | `33554432` | Ceiling on attachment bytes deleted per second — and so on the WAL written (1 MiB – 1 GiB). |
| `ACCOUNT_PURGE_THREAD_BATCH` | `200` | Checkpoint thread ids per call to the agents service. |
| `ACCOUNT_PURGE_RETRY_MAX_SECONDS` | `3600` | Ceiling for the back-off after a failed purge step. |

### Attachments, speech, share, generation

| Env var | Default | What it does |
| --- | --- | --- |
| `ATTACHMENT_MAX_SIZE_BYTES` | `26214400` (25 MB) | Max single-attachment size. |
| `ATTACHMENT_MAX_TOTAL_BYTES` | `26214400` (25 MB) | Max combined size per message. |
| `ATTACHMENT_MAX_PER_MESSAGE` | `10` | Max attachments per message. |
| `ATTACHMENT_DOCX_PREVIEW_TOKEN_TTL_SECONDS` | `60` | Lifetime of a signed DOCX-preview token. |
| `ATTACHMENT_INLINE_CACHE_MAX_AGE_SECONDS` | `300` | `Cache-Control max-age` on inline attachment responses. |
| `ATTACHMENT_STREAM_CHUNK_BYTES` | `524288` (512 KB) | Chunk size when streaming a blob. |
| `OUTPUT_CAPTURE_BATCH_FILES` | `20` | Presented files fetched per request for the run-end snapshot (≤ 20, the agents service's per-request cap). |
| `SPEECH_DICTATION_MAX_BYTES` | `26214400` (25 MB) | Max dictation upload. |
| `SPEECH_DICTATION_READ_CHUNK_BYTES` | `1048576` (1 MB) | Read-chunk size for dictation. |
| `SPEECH_READ_ALOUD_MAX_CHARS` | `2000` | Max characters per read-aloud request. |
| `MAX_PINNED_CONVERSATIONS` | `30` | Pins per user (1–100). The UI loads every pin in one page, whose ceiling is 100. |
| `SHARE_DEFAULT_TTL_DAYS` | `30` | Default share-link lifetime. |
| `SHARE_MAX_TTL_DAYS` | `365` | Max share-link lifetime. |
| `GENERATION_TITLE_MAX_LEN` | `120` | Max generated title length. |
| `GENERATION_TITLE_MIN_CANDIDATES` | `3` | Min title candidates the bridge expects from agents. |
| `GENERATION_SUGGESTION_MAX_LEN` | `160` | Max suggestion length. |
| `GENERATION_SUGGESTION_MIN_CANDIDATES` | `6` | Min suggestion candidates expected. |
| `GENERATION_SUGGESTION_COUNT` | `10` | Suggestions requested. |
| `GENERATION_SUGGESTION_RECENT_CONTEXT_COUNT` | `8` | Recent messages fed as suggestion context. |

### Agent-builder "Try it" (`AgentTrialSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `AGENT_TRIAL_DRAFT_TTL_SECONDS` | `7200` | Lifetime of a trial run's draft in Redis (`trial:draft:{run_id}`). The run reads it once at start and drops it. |
| `AGENT_TRIAL_CONVERSATION_TTL_HOURS` | `24` | A trial conversation nobody Reset is deleted this long after it started (with its agents-service threads and files). |
| `AGENT_TRIAL_SWEEP_INTERVAL_SECONDS` | `3600` | How often the trial sweeper looks for expired trials. |
| `AGENT_TRIAL_SWEEP_BATCH_SIZE` | `50` | Trials deleted per sweep transaction; a full batch looks again at once. |

### Workflow runs (`WorkflowSettings`)

Plan 38, Step 1: the bridge's side of running a workflow (the agents service owns the engine; its caps are code constants). See [workflows](../flows/workflows.md).

| Env var | Default | What it does |
| --- | --- | --- |
| `WORKFLOW_APPROVAL_TTL_HOURS` | `24` (1–720) | A run paused on an approval longer than this is failed as expired, freeing the workflow's live slot. |
| `WORKFLOW_RUN_STREAM_IDLE_TIMEOUT_SECONDS` | `900` (60–86400) | A leg that has persisted nothing for this long is failed by the watchdog; also the read timeout on the agents stream. |
| `WORKFLOW_RUN_STREAM_MAX_SECONDS` | `3600` (60–86400) | Wall-clock ceiling on one leg (the start, or one resume). |
| `WORKFLOW_RUN_WATCHDOG_INTERVAL_SECONDS` | `60` (5–3600) | How often the watchdog looks for stalled legs and expired approvals. |
| `WORKFLOW_MAX_RUNS_PER_WORKFLOW` | `200` | Runs kept per workflow; the oldest finished ones are pruned on each start (a live run never is). |
| `WORKFLOW_MAX_ACTIVE_RUNS_PER_USER` | `5` (1–100) | Runs a user may have `queued` or `running` at once (429 past it); `waiting` runs hold no connection and are not counted. |
| `WORKFLOW_RUN_MAX_EVENTS` | `20000` | Events stored per run; past it one truncation marker, then only `RUN_*` and the approval interrupt. |
| `WORKFLOW_RUN_MAX_EVENT_BYTES` | `65536` | One event's serialised size; larger is stored as a marker with a preview of half this. |
| `WORKFLOW_RUN_MAX_INPUT_BYTES` | `65536` | A run's `inputs`, serialised (422 past it). |
| `WORKFLOW_MAX_SPEC_BYTES` | `524288` | A spec forwarded to the agents service (create / update / validate); the engine's own cap is 256 KiB. |
| `WORKFLOW_RUN_PERSIST_BATCH` | `50` | Events written per transaction. |
| `WORKFLOW_RUN_PERSIST_INTERVAL_MS` | `250` | Longest an event waits in the buffer before it is persisted and published live. |
| `WORKFLOW_RUNS_PAGE_SIZE` | `20` | Runs per page of the run list. |
| `WORKFLOW_RUN_STREAM_HEARTBEAT_SECONDS` | `15` | Keep-alive comment on an idle live event stream. |

### Voice (`VoiceSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | Realtime model for voice mode. |
| `REALTIME_DEFAULT_VOICE` | `alloy` | Default TTS voice (lowercased). |
| `REALTIME_SUPPORTED_VOICES` | `alloy,ash,ballad,coral,echo,sage,shimmer,verse,marin,cedar` | CSV allow-list of selectable voices. |
| `VOICE_MODE_DEFAULT_LANGUAGE` | `english` | Language voice mode *opens* in when the user has no preference. Not a lock — the model switches to whatever the user actually speaks. |
| `VOICE_MODE_SUPPORTED_LANGUAGES` | 18 languages (`english,greek,spanish,…`) | CSV allow-list for the opening language. An allow-list because the value is interpolated into the model's system instruction. Keep in sync with `VOICE_MODE_LANGUAGES` in the frontend. |

### HTTP timeouts (`HttpTimeoutSettings`)

Per-destination `httpx` timeouts, in seconds. Each destination has four knobs: `*_CONNECT_SECONDS`, `*_READ_SECONDS`, `*_WRITE_SECONDS`, `*_POOL_SECONDS`.

| Destination prefix | connect / read / write / pool defaults |
| --- | --- |
| `HTTP_AGENTS_` | 10 / 30 / 30 / 10 |
| `HTTP_GENERATION_` | 10 / 120 / 120 / 10 |
| `HTTP_SKILLS_` | 10 / 15 / 10 / 10 |
| `HTTP_VOICE_` | 15 / 75 / 75 / 15 |
| `HTTP_INFERENCE_` | 30 / 180 / 180 / 30 |

`HTTP_COMPACTION_READ_SECONDS` (default `240`) is the read timeout of a manual compaction (plan 34): one summary call over most of the conversation while the user waits, bounded below nginx's 300 s on `/api/` so the browser always gets the bridge's own answer. Connect/write/pool follow `HTTP_INFERENCE_`.

`HTTP_SKILLS_REMOTE_ADD_READ_SECONDS` (default `75`) overrides only the read timeout for adding a remote skill: the agents service may download and verify up to 128 files before answering and caps that at 60 s, so the bridge waits just past it. That call is never retried.

### Proxy trust & logging

| Env var | Default | What it does |
| --- | --- | --- |
| `TRUSTED_PROXY_HEADER_NAME` | `X-Internal-Proxy-Secret` | Header carrying the internal-caller secret. |
| `TRUSTED_PROXY_SECRET` | (secret) | **Required — the service refuses to start without it.** |
| `LOG_LEVEL` | `INFO` | Root log level (uppercased). `uvicorn.access`/`httpx` are pinned to `WARNING`. |
| `LOG_FORMAT` | `console` | `console` (dev) or `json` (prod — set in the production compose so Loki/Alloy can parse). |
| `LOG_TIMEZONE` / `TZ` | `Europe/Athens` | Timestamp timezone. |
| `LOG_REDACTION_SECRET` | (secret) | Shared HMAC key for the `client_ip` hash. Dev falls back to a random per-process key. |

### CORS (`CorsSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | `localhost:8080/8050` + `127.0.0.1:8080/8050` (CSV) | Allowed browser origins, for CORS **and** the WebSocket `Origin` check. **Cannot contain `*` while credentials are on**, and outside `APP_ENV=development`/`test` only `https` origins on public hosts (the localhost defaults raise at startup). Dennis sets `https://agents.magenticx.com`. |
| `CORS_ALLOW_CREDENTIALS` | `true` | Allow cookies on cross-origin requests. |
| `CORS_ALLOW_METHODS` | `GET,POST,PUT,PATCH,DELETE` (CSV) | Allowed methods. |
| `CORS_ALLOW_HEADERS` | auto | Defaults to `Accept, Content-Type, Authorization, Range, If-Range, <csrf header>` if unset. |
| `CORS_EXPOSE_HEADERS` | `Content-Disposition,Content-Length,Content-Range,Accept-Ranges` (CSV) | Headers exposed to the browser (needed for download/range). |
| `CORS_MAX_AGE_SECONDS` | `600` | Preflight cache duration. |

---

## agents

LangGraph + DeepAgents runtime. Configuration splits into runtime infra, the durable checkpointer, per-workflow model selection, and the deep-agent filesystem.

### App, API keys, RAG, MCP

| Env var | Default | What it does |
| --- | --- | --- |
| `LOG_SERVICE_NAME` | `agents` | `service` field in logs. |
| `APP_ENV` / `ENV` | `development` | Environment name. |
| `APP_VERSION` / `IMAGE_TAG` | `unknown` | Version stamped on logs. |
| `OPENAI_API_KEY` | (secret) | OpenAI key for all LLM, STT/TTS, and realtime calls. |
| `ANTHROPIC_API_KEY` | (secret, optional) | Anthropic key; `None` if unset. |
| `RAG_BASE_URL` | `https://rag_service:8001` | rag_service base URL. |
| `RAG_REQUEST_TIMEOUT_SECONDS` | `30` | Read timeout for rag calls. |
| `RAG_CONNECT_TIMEOUT_SECONDS` | `15` | Connect timeout for rag calls. |
| `MCP_GATEWAY_URL` | `""` (MCP off) | MCP gateway SSE endpoint (plaintext — the dind gateway can't terminate TLS). **Empty = MCP off**: runs use the agent's own tools only, `GET /tools` returns `[]`, and declared MCP tools list as unavailable. Local passes `${MCP_GATEWAY_URL:-}` — empty unless `magenticx/.env` sets `http://mcp_gateway:8005/sse`, because the gateway is a sibling project ([mcp_gateway](https://github.com/konstantinosmpouros/mcp_gateway)) that may not be running; `docker-compose-denis.yaml` sets it. |
| `MCP_CONNECT_TIMEOUT_SECONDS` | `10` | Deadline (0 < x ≤ 120) for connecting to the gateway **plus** the MCP handshake, for both run sessions and catalog fetches. A run whose gateway misses it carries on without MCP tools (`mcp_session_unavailable`); a failed catalog fetch is not retried for 30 s. The deadline is lifted once the session is up. |
| `LANGFUSE_BASE_URL` | `""` (tracing off) | Langfuse's internal URL, `http://langfuse-web:3000` on the `langfuse` network — never the public host. Tracing is on only with this **and** both keys set. Both composes set it (local: `${LANGFUSE_BASE_URL:-http://langfuse-web:3000}`, so `LANGFUSE_BASE_URL=` in `.env` turns it off). See [observability.md § Agent traces](../development/observability.md#agent-traces--langfuse-a-sibling-project-opt-in). |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | (secret, optional) | Keys of the Langfuse project `magenticx`, via `*_FILE`. An unreadable key file turns tracing off instead of stopping the service. |
| `LANGFUSE_SAMPLE_RATE` | `1.0` | Share of runs traced (0–1). |
| `LANGFUSE_TIMEOUT_SECONDS` | `5` | Per export request (1–30); exports run in a background thread either way. |
| `MCP_MANIFEST_CACHE_ENABLED` | `true` | Cache the MCP tool manifest for the catalog / Agents tab instead of refetching it per listing. Runs never use it — each run loads the live tools from its own session. |

### Internal TLS client

| Env var | Default | What it does |
| --- | --- | --- |
| `INTERNAL_CA_CERT_PATH` | `None` | CA to verify rag_service (and to enable Postgres TLS on the checkpointer URL). |
| `INTERNAL_CLIENT_CERT_PATH` | `None` | Client cert presented for mTLS to rag_service. |
| `INTERNAL_CLIENT_KEY_PATH` | `None` | Matching client key. |

### Durable checkpointer (`CheckpointerSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `AGENT_RUNTIME_DATABASE_URL` | `postgresql://admin:admin@chat_postgres:5432/agent_runtime` | psycopg3 conninfo for the LangGraph `AsyncPostgresSaver`. **Raw `postgresql://` (not `+asyncpg`).** TLS is auto-appended (`sslmode=verify-full&sslrootcert=…`) when `INTERNAL_CA_CERT_PATH` is set and the URL has no `sslmode`. |
| `AGENT_RUNTIME_DATABASE_PASSWORD_FILE` | (secret) | Password spliced into a password-less conninfo (prod). Inline `admin:admin` (dev) wins. |
| `AGENT_RUNTIME_POOL_MIN_SIZE` | `2` | Min checkpointer pool connections. |
| `AGENT_RUNTIME_POOL_MAX_SIZE` | `20` | Max checkpointer pool connections. |
| `AGENT_RUNTIME_POOL_MAX_IDLE` | `300` | Idle-connection reap (seconds). |
| `AGENT_RUNTIME_POOL_TIMEOUT` | `30.0` | Wait for a pool connection (seconds). |
| `AGENT_RUNTIME_SETUP_ON_STARTUP` | `true` | Run `AsyncPostgresSaver.setup()` (idempotent DDL) on boot. Emergency opt-out, mirrors the bridge's migration knob. |
| `LANGGRAPH_STRICT_MSGPACK` | `true` | Strict msgpack deserialization allow-list — blocks the `JsonPlusSerializer` RCE class (CVE-2025-64439). Exported into the env LangGraph reads. **Leave on.** |
| `LANGGRAPH_AES_KEY` | (secret, optional) | AES key for `EncryptedSerializer` (at-rest checkpoint encryption) — and, through the same cipher, for conversation file bytes (plan 36). Empty ⇒ no encryption of either. |

### Proxy trust, logging & redaction

| Env var | Default | What it does |
| --- | --- | --- |
| `TRUSTED_PROXY_HEADER_NAME` | `X-Internal-Proxy-Secret` | Header carrying the internal-caller secret. |
| `TRUSTED_PROXY_SECRET` | (secret) | **Required — refuses to start without it.** |
| `LOG_LEVEL` | `INFO` | Root log level. |
| `LOG_FORMAT` | `console` | `console` / `json` (production sets `json`). |
| `LOG_TIMEZONE` / `TZ` | `Europe/Athens` | Timestamp timezone. |
| `LOG_REDACTION_SECRET` | (secret) | `client_ip` hash key. Falls back to `SESSION_TOKEN_SECRET`, then a random per-process key. |

### Agent registry & generation

| Env var | Default | What it does |
| --- | --- | --- |
| `DISABLED_AGENT_SLUGS` | (empty, CSV) | Agent slugs to hide from discovery (normalized lowercase, de-duped). |
| `ALLOWED_AGENT_MODELS` | `gpt-6-luna`, `gpt-5`, `gpt-4o`, `gpt-4o-mini` (all `openai:`) | The platform's models, `provider:model` → facts, as JSON — see **Models** below. |
| `TITLE_CANDIDATE_COUNT` | `4` | Title candidates generated. |
| `TITLE_MIN_CANDIDATES` | `3` | Min acceptable title candidates. |
| `TITLE_MAX_LEN` | `120` | Max title length. |
| `TITLE_TEMPERATURE` | `1.0` | Title-generation temperature. |
| `TITLE_MAX_TOKENS` | `128` | Title-generation token cap. |
| `SUGGESTION_COUNT` | `10` | Suggestions generated. |
| `SUGGESTION_MAX_LEN` | `160` | Max suggestion length. |
| `SUGGESTION_TEMPERATURE` | `0.8` | Suggestion temperature. |
| `SUGGESTION_MAX_TOKENS` | `320` | Suggestion token cap. |

### Runtime models & realtime voice (`RuntimeModelsSettings`, `RealtimeSettings`)

| Env var | Default | What it does |
| --- | --- | --- |
| `TITLE_MODEL` | `openai:gpt-4o-2024-08-06` | Model for title generation. |
| `SUGGESTIONS_MODEL` | `openai:gpt-4o-2024-08-06` | Model for follow-up suggestions. |
| `OPENAI_STT_MODEL` | `gpt-4o-transcribe` | Dictation (speech-to-text) model. |
| `READ_ALOUD_MODEL` | `gpt-4o-mini-tts` | Read-aloud (TTS) model. |
| `READ_ALOUD_FORMAT` | `mp3` | Read-aloud audio format. |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | Realtime voice model. |
| `REALTIME_SUPPORTED_VOICES` | `alloy,ash,ballad,coral,echo,sage,shimmer,verse,marin,cedar` (CSV) | Realtime voice allow-list. |
| `OPENAI_REALTIME_API_URL` | `https://api.openai.com/v1/realtime/calls` | Realtime API endpoint. |
| `REALTIME_CONNECT_TIMEOUT_SECONDS` | `15.0` | Realtime connect timeout. |
| `REALTIME_READ_TIMEOUT_SECONDS` | `60.0` | Realtime read timeout. |
| `REALTIME_WRITE_TIMEOUT_SECONDS` | `60.0` | Realtime write timeout. |
| `REALTIME_POOL_TIMEOUT_SECONDS` | `15.0` | Realtime pool timeout. |
| `REALTIME_ERROR_BODY_MAX_CHARS` | `1000` | Max chars of an upstream error body surfaced. |

### Workflow agents — model & retrieval selection

Each built-in workflow agent picks its models per node. All accept `openai:<model>` (or `anthropic:<model>`) strings.

**HR** (`HR_*`): `HR_COLLECTION_NAME=hr_policies_v4`, `HR_RETRIEVE_TOP_K=2`, plus `HR_ANALYSIS_MODEL`, `HR_SIMPLE_GENERATION_MODEL`, `HR_QUERY_REFLECTIVE_MODEL`, `HR_QUERY_NO_REFLECTIVE_MODEL`, `HR_DOC_RANKING_MODEL`, `HR_SUMMARIZATION_MODEL`, `HR_COMPLEX_GENERATION_MODEL`, `HR_REFLECTION_MODEL` (defaults mix `gpt-4o-2024-08-06`, `gpt-5-2025-08-07`, `o3-mini`, `gpt-4.1-2025-04-14`).

**Orthodox** (`ORTHODOX_*`): `ORTHODOX_COLLECTION_NAME=athanasios-muthlinaios`, `ORTHODOX_RETRIEVE_TOP_K=10`, plus the same model-node set (defaults mix `gpt-4o-2024-08-06`, `o3-mini`, `o4-mini`, `gpt-5-2025-08-07`).

**Retail** (`RETAIL_*`): `RETAIL_TABLE_NAME="Financial Sample"` (the DuckDB source table; the runtime table name is normalized from it), `RETAIL_SCHEMA_TIMEOUT_SECONDS=30`, `RETAIL_QUERY_CONNECT_TIMEOUT_SECONDS=10`, `RETAIL_QUERY_TIMEOUT_SECONDS=30`, plus `RETAIL_ANALYSIS_MODEL`, `RETAIL_SIMPLE_GENERATION_MODEL`, `RETAIL_SQL_GENERATION_MODEL`, `RETAIL_SQL_ERROR_GENERATION_MODEL`, `RETAIL_ANSWER_GENERATION_MODEL`.

**Omni deep agent** (`OMNI_*`): `OMNI_MAIN_MODEL`, `OMNI_RESEARCHER_MODEL` and `OMNI_WRITER_MODEL` all default to `openai:gpt-6-luna`.

**Models** (`ALLOWED_AGENT_MODELS`): the one list of the platform's models, each `provider:model` key with what to know about it (`ModelInfo`). The order is the builder's.

```json
{
  "openai:gpt-6-luna":  {"reasoning": true,  "context_window": 1050000},
  "openai:gpt-5":       {"reasoning": true},
  "openai:gpt-4o":      {"reasoning": false},
  "openai:gpt-4o-mini": {"reasoning": false}
}
```

| Fact | Used for | Unset |
| --- | --- | --- |
| *(the key)* | The only models a user-authored agent or a workflow LLM node may select (built-ins are not constrained by it) | — |
| `reasoning` | Asked for its reasoning summary (**Reasoning summaries** below); a non-reasoning model would reject that parameter | The pinned `langchain-openai`'s table decides (gpt-5, o3, o4-mini → yes; gpt-4o, gpt-4.1 → no; unknown → no) |
| `context_window` | Compaction and the composer's context ring; registered through deepagents' `ProviderProfile` before an agent builds its model (`DeepAgent.register_model_windows`) | The table's window; a model newer than it (gpt-6-luna) then has none |

A model newer than the pinned `langchain-openai` needs both facts stated. An unknown fact is refused at startup. A bare list (`["openai:a", "openai:b"]`, or `openai:a,openai:b`) still works, every fact then unset.

**Reasoning summaries** (`REASONING_SUMMARY`, default `auto`; `concise` / `detailed` / `off`): deep agents ask every OpenAI reasoning model in the tree for its summary of its reasoning, which streams into the chat's CoT as thoughts and shows in Langfuse. `off` asks for none — OpenAI may require a verified organization for summaries. Which models reason: their `reasoning` in `ALLOWED_AGENT_MODELS`, else the table (see **Models** above). See `harness/models/reasoning_summary.py`.

### Deep-agent filesystem, conversation files & summarization

| Env var | Default | What it does |
| --- | --- | --- |
| `MAGENTICX_GLOBAL_ROOT` | `/var/magenticx/global` | The global plane on the `magenticx_data` volume: built-in agent definitions and the skills catalogue (build-time content). |
| `CONVERSATION_FILE_MAX_BYTES` | `104857600` (100 MB) | Largest single conversation file (plan 36). A technical safety limit — one file is held in memory to encrypt and write it — not a quota: there is none, and no TTL. An over-cap `write_file`/`edit_file` returns an error the model can act on. |
| `CONVERSATION_INPUT_CACHE_BYTES` | `134217728` (128 MB) | Process-wide cache of upload bytes read from the bridge for `/conversation/input/`, keyed by content hash. `0` disables it. |
| `BRIDGE_CONVERSATIONS_PATH` | `/v1/internal/conversations` | The bridge's internal routes behind `/conversation/input/` (on `DIALOGUE_BRIDGE_URL`). |
| `VIEW_IMAGE_MAX_BYTES` | `10485760` (10 MB) | Largest image `view_image` will hand to the model. Unlike the AG-UI preview bounds this caps the **model's** copy, so it guards context cost rather than display size. |
| `OUTPUT_MAX_FILE_BYTES` / `OUTPUT_MAX_FILES` | `26214400` (25 MB) / `20` | Caps on the presented-file read the bridge snapshots at run end: larger files are reported missing, more paths per request is a 422. |
| `SANDBOX_EXECUTION_ENABLED` | `false` | Fail-closed kill switch for sandboxed command execution: while false, workspace assembly refuses to mint a sandbox-capable default backend, which is exactly what would make deepagents expose its `execute` tool. Both composes turn it on (local `${SANDBOX_EXECUTION_ENABLED:-true}`, Dennis `true`); set it `false` and release to remove `execute`. See [sandboxed-execution.md](../flows/sandboxed-execution.md). |
| `SANDBOX_RUNNER_URL` | `""` (no `execute`) | The sandbox runner's base URL (sibling project [sandbox](https://github.com/konstantinosmpouros/sandbox)). `execute` exists only when this is set **and** `SANDBOX_EXECUTION_ENABLED` is true. Locally `${SANDBOX_RUNNER_URL:-}`; set `http://sandbox_runner:8090` in `magenticx/.env` when the runner runs. `docker-compose-denis.yaml` sets `https://sandbox_runner:8090` (mTLS over the `sandbox` overlay). |
| `SANDBOX_RUNNER_TIMEOUT_SECONDS` | `330` | HTTP read timeout for one `execute` call (0 < x ≤ 3600). Must exceed the runner's own 300 s wall-clock kill, so a slow command comes back as the runner's `timeout` result rather than a client error. |
| `SANDBOX_RUNNER_CONNECT_TIMEOUT_SECONDS` | `10` | Connect timeout to the runner (0 < x ≤ 120). |
| `SUMMARIZATION_TRIGGER_FRACTION` | `0.95` | Compact automatically when the context reaches this fraction of a model's window (models with a known window — see **Models**, `context_window`). |
| `SUMMARIZATION_KEEP_FRACTION` | `0.30` | Only bounds deepagents' overflow clipping: every compaction, automatic or manual, folds everything before the latest question. |
| `SUMMARIZATION_TRIGGER_TOKENS` | `200000` | Fallback token trigger for profile-less models. |
| `SUMMARIZATION_KEEP_MESSAGES` | `20` | Fallback recent-message retention. |
| `SUMMARIZATION_MANUAL_MIN_FRACTION` | `0.05` | A **manual** compaction (the composer's context ring, plan 34) is allowed once the context passes this fraction of the window. The UI applies the same 5% (`MANUAL_COMPACTION_MIN_PERCENT`). |

### Model-call rate-limit retry (`RateLimitRetrySettings`)

`RetryOnRateLimitMiddleware` (`harness/middlewares/rate_limit.py`), guaranteed outermost on every deep agent and declared sub-agent, waits out a provider 429 instead of failing the run. The OpenAI client's own short retries rarely outlast a per-minute token quota.

| Env var | Default | What it does |
| --- | --- | --- |
| `MODEL_RATE_LIMIT_RETRY_ATTEMPTS` | `4` (1–10) | Attempts in all, the first included. |
| `MODEL_RATE_LIMIT_RETRY_DELAY_SECONDS` | `15.0` | Wait before each retry; a larger numeric `Retry-After` from the provider wins. |
| `MODEL_RATE_LIMIT_RETRY_MAX_DELAY_SECONDS` | `120.0` | Cap on any single wait. |

A 429 with code `insufficient_quota` (the account is out of credit) is never retried. Re-issuing is safe, because a 429 is refused before any token streams. Each retry logs `model_call_rate_limited`. The run emits nothing while it waits, but the bridge's stream keeps heartbeating.

### Remote skill sources (`RemoteSkillsSettings`)

The skill catalogue is the allowlisted remote sources, indexed daily (see [remote-skills](../flows/remote-skills.md)). The **sources themselves are not configurable** — the allowlist is security policy and lives in code (`harness/skill_registry/remote/sources.py`), because an env-editable source URL would be an SSRF lever.

| Env var | Default | What it does |
| --- | --- | --- |
| `REMOTE_SKILLS_ENABLED` | `true` | The kill switch. `false` → no sync loop, no outbound request, an empty catalogue search, and Add answers 503. Skills users already added keep working. |
| `REMOTE_SKILLS_SYNC_INTERVAL_HOURS` | `24` | Sync cadence (jittered ±10 %; bounded 1–168). |
| `REMOTE_SKILLS_SYNC_INITIAL_DELAY_SECONDS` | `120` | First pass after boot, so it never competes with startup. |
| `REMOTE_SKILLS_FETCH_CONCURRENCY` | `8` | Parallel file reads per sync or Add (bounded 1–16). |
| `REMOTE_SKILLS_CONNECT_TIMEOUT_SECONDS` / `_READ_TIMEOUT_SECONDS` | `10` / `30` | Per-request timeouts on every outbound call. |
| `REMOTE_SKILLS_ADD_TIMEOUT_SECONDS` | `60` | Wall-clock ceiling on one Add's download and verification. |

No GitHub token: the design spends at most four REST calls a day (the branch head is read from git's `info/refs`, which costs no quota), far inside the anonymous allowance.

---

## rag_service

The generic retrieval backend — the smallest surface (5 vars beyond TLS).

| Env var | Default | What it does |
| --- | --- | --- |
| `ENVIRONMENT` | `development` | Environment name (note: this service uses `ENVIRONMENT`, not `APP_ENV`/`ENV`). |
| `LOG_LEVEL` | `INFO` | Log level. |
| `LOG_FORMAT` | `console` | `console` / `json` (production sets `json`). |
| `LOG_REDACTION_SECRET` / `LOG_REDACTION_SECRET_FILE` | (secret) | `client_ip` hash key; random per-process fallback if unset. |
| `RAG_HOST` | `vectordb` | ChromaDB host. |
| `RAG_PORT` | `8000` | ChromaDB port. |
| `OPENAI_API_KEY` / `OPENAI_API_KEY_FILE` | (secret) | Key for embedding queries. |
| `TRUSTED_PROXY_HEADER_NAME` | `X-Internal-Proxy-Secret` | Internal-caller header. |
| `TRUSTED_PROXY_SECRET` / `TRUSTED_PROXY_SECRET_FILE` | (secret) | **Required — refuses to start without it.** |

---

## Infrastructure services

These have no `settings.py`; they are configured by image env vars and command flags in the compose files.

### vectordb (`chromadb/chroma:0.6.3`)

| Env var | Value | What it does |
| --- | --- | --- |
| `IS_PERSISTENT` | `TRUE` | Persist to disk (the `vectorstore` volume). |
| `PERSIST_DIRECTORY` | `/chroma/chroma` | On-disk path. |
| `ANONYMIZED_TELEMETRY` | `FALSE` | Disable Chroma telemetry. |

The `command:` references `CHROMA_WORKERS`, `CHROMA_HOST_ADDR`, `CHROMA_HOST_PORT`, `CHROMA_LOG_CONFIG`, `CHROMA_TIMEOUT_KEEP_ALIVE` — these are **chroma-image env vars defaulted by the image** (passed literally via `$$`), not values we set.

### chat_postgres (`postgres:16.3`)

| Env var | Value | What it does |
| --- | --- | --- |
| `POSTGRES_USER` | `admin` | Superuser created on first init. |
| `POSTGRES_PASSWORD_FILE` | `/run/secrets/postgres_password` | Password (first-init only — see [secrets.md](secrets.md)). |
| `POSTGRES_DB` | `chat_db` | Initial database (the bridge's). The agents `agent_runtime` DB is created out-of-band on the same instance. |

TLS is added by `entrypoint-postgres-tls.sh` (honors `REQUIRE_TLS`).

### redis (`redis:7.4-alpine`)

Configured entirely by **command flags**, no env vars: password from `/run/secrets/redis_password`, `--tls-port 6379` (plain port disabled), `--tls-auth-clients no` (password-over-TLS, not mTLS), `--maxmemory 256mb`, `--maxmemory-policy allkeys-lru`, `--save "" --appendonly no` (ephemeral — streams only). TLS is hardwired in the command, so there is no `REQUIRE_TLS` toggle here.

### agentic_ui (nginx)

| Env var | Default / value | What it does |
| --- | --- | --- |
| `BFF_BASE_URL` | `https://dialogue_bridge:8002` | Upstream the nginx `/api/` proxy forwards to (substituted into `nginx.conf.template`). |
| `TRUSTED_PROXY_SECRET` | (from secret via shim) | Injected as the internal-caller header on proxied requests. |
| `REQUIRE_TLS` | `true` | Fail-closed HTTPS (via `entrypoint-nginx-tls.sh`). |

### Sibling projects

The MCP gateway, the sandbox runner and the monitoring stack are separate repositories and are configured there: [mcp_gateway](https://github.com/konstantinosmpouros/mcp_gateway), [sandbox](https://github.com/konstantinosmpouros/sandbox), [monitoring](https://github.com/konstantinosmpouros/monitoring). mAgenticX only points at the first two, through `MCP_GATEWAY_URL` and `SANDBOX_RUNNER_URL` on agents (above). Monitoring needs nothing from it except `LOG_FORMAT=json`.

---

## Deploy-time safety toggles (cross-service)

These flip behavior at boot; all are **fail-closed by default** (secure unless explicitly disabled).

| Env var | Default | Services | Effect when `true` (default) | Set `false` to… |
| --- | --- | --- | --- | --- |
| `REQUIRE_TLS` | `true` | bridge, agents, rag, postgres, nginx | Refuse to start if cert/key (or CA for nginx) is missing/unreadable. | Allow plaintext fallback (emergency only). |
| `REQUIRE_MTLS` | `true` | bridge, agents, rag (uvicorn) | Require + verify a CA-signed **client** cert (`--ssl-cert-reqs 2`). | One-way TLS (server-auth only) — the lever for the zero-downtime mTLS rollout. |
| `RUN_MIGRATIONS_ON_STARTUP` | `true` | bridge | Run `alembic upgrade head` before serving. | Boot without migrating (to run alembic by hand). |
| `AGENT_RUNTIME_SETUP_ON_STARTUP` | `true` | agents | Run checkpointer `setup()` DDL on boot. | Skip DDL (DB already set up / debugging). |
| `LANGGRAPH_STRICT_MSGPACK` | `true` | agents | Block the msgpack RCE deserialization class. | **Don't** — only to debug a serialization issue. |

---

## Sharp Edges and Behavioral Notes

- **Prod must set `APP_ENV=production` explicitly.** The default is `development`, so leaving it unset does *not* mean production — it switches off every production-only check (mandatory `SESSION_TOKEN_SECRET`, refusing the dev file signer, no random dev-secret fallbacks). Dennis ran unset for a long time on the mistaken belief that unset meant "not development"; plan 29 added `APP_ENV=production` to its compose.
- **`TRUSTED_PROXY_SECRET` is a hard start gate** on all three Python services — a `model_validator` raises if it's empty. This is the single most common "service won't boot" cause after a secret rename.
- **`*_FILE` unreadable is fail-loud; `*_FILE` unset is a silent fallback.** A set-but-unreadable secret path raises at startup (so a permission slip is loud), but an *unset* `*_FILE` quietly falls back to the plain env var — which is exactly what local `.env` dev relies on.
- **`LOG_FORMAT` defaults to `console`.** Prod must run `json` (the production compose sets it on all three) or Alloy can't extract the `level` label and the Loki dashboards/error alerts break.
- **The redaction secret only affects `client_ip`** now (`user_id`/`session_id` are logged raw to match the DB — see [observability.md](../development/observability.md)). Without the shared secret, `client_ip` correlation degrades to per-process; it never leaks the raw IP.
- **JWT TTLs and CORS are validated.** Out-of-range JWT durations raise; `CORS_ALLOWED_ORIGINS` containing `*` with credentials on raises, and so does a non-`https` or loopback origin outside development/test. These are startup failures, not silent clamps.
- **Cookie names auto-prefix `__Host-`** when `SESSION_COOKIE_SECURE=true` and no `SESSION_COOKIE_DOMAIN` is set. Set a domain only if you genuinely need cross-subdomain cookies — it drops the `__Host-` hardening.
- **agents reads two databases.** `DATABASE_*` (bridge) and `AGENT_RUNTIME_DATABASE_*` (agents checkpointer) are different DBs on the same Postgres instance, and the latter is a **raw psycopg** conninfo (`postgresql://`), not the bridge's `postgresql+asyncpg://`.
- **A bad `MODEL_PRICES_JSON` is a start failure**, not a silent fallback to the defaults: the bridge refuses to boot rather than price every answer wrong.
- **rag_service is the odd one out** — it uses `ENVIRONMENT` (not `APP_ENV`/`ENV`) and keeps `LOG_LEVEL`/`LOG_FORMAT` on `AppSettings`, while the bridge/agents keep them on a `LoggingSettings` group. Same vars, slightly different internal shape.

---

## File Map

| Concept | File | What to look for |
| --- | --- | --- |
| bridge settings | [magenticx/dialogue_bridge/core/settings.py](../../magenticx/dialogue_bridge/core/settings.py) | every `*Settings` class + `validation_alias` |
| agents settings | [magenticx/agents/core/settings.py](../../magenticx/agents/core/settings.py) | checkpointer, workflows, deep-agents, filesystem, `RateLimitRetrySettings` |
| model price table | [magenticx/dialogue_bridge/utils/model_pricing.py](../../magenticx/dialogue_bridge/utils/model_pricing.py) | `DEFAULT_PRICES`, `parse_price_table()`, `call_cost_micros()` |
| rag settings | [magenticx/rag_service/core/settings.py](../../magenticx/rag_service/core/settings.py) | `AppSettings`, `RagSettings`, `ProxySettings` |
| TLS toggles | [magenticx/tls/entrypoint-tls.sh](../../magenticx/tls/entrypoint-tls.sh) | `REQUIRE_TLS`, `REQUIRE_MTLS` |
| nginx env substitution | [magenticx/agentic_ui/nginx.conf.template](../../magenticx/agentic_ui/nginx.conf.template) | `BFF_BASE_URL`, `TRUSTED_PROXY_SECRET` |
| core stack compose | [magenticx/docker-compose-denis.yaml](../../magenticx/docker-compose-denis.yaml) | per-service `environment:` overrides |
| secret delivery | [docs/architecture/secrets.md](secrets.md) | which var is backed by which secret |

### Multi-account sign-in (dialogue_bridge)

| Variable | Default | Purpose |
| --- | --- | --- |
| `MULTI_ACCOUNT_ENABLED` | `true` | Master switch for several signed-in accounts per browser. Set `false` to remove the surface entirely — every `/v1/auth/accounts*` route then 404s. It does keep more live refresh tokens in one browser (blast radius of a stolen session goes from one account to N), bounded by the cap, at-rest encryption and per-switch rotation. |
| `PARKED_TOKEN_KEY` | *derived* | AES-GCM key encrypting parked refresh tokens at rest — **at least** 32 bytes, base64 or hex (more is fine: `openssl rand -base64 64` is condensed with HKDF; less is refused rather than stretched). Set it explicitly in production — on Dennis as the Swarm secret `magenticx_parked_token_key` via `PARKED_TOKEN_KEY_FILE` — so it rotates independently. When unset it is derived from `SESSION_TOKEN_SECRET` (HKDF, fixed info label), so local dev needs no extra variable. **Never falls back to plaintext:** with neither this nor `SESSION_TOKEN_SECRET` present, boot fails closed. Note the derived path ties the two together — rotating `SESSION_TOKEN_SECRET` signs every parked account out. |
| `MAX_PARKED_ACCOUNTS` | `2` | Hard ceiling on accounts signed in **in total** (the active one plus the parked ones). A security bound, not a UI limit — each parked entry is a live bearer credential. Checked *before* authenticating on the add-account path; asking for one more surfaces the "log out of one to continue" dialog. |
| `SESSION_DEVICE_COOKIE_NAME` | `__Host-mx_device` / `mx_device` | Cookie holding the opaque parked-session index id. Follows the same `__Host-` rule as the session cookies. |

See [authentication-and-session § Phase 10](../flows/authentication-and-session.md) for the flow and threat model.

### AG-UI image previews (`agents`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGUI_IMAGE_PREVIEW_MAX_EDGE` | `512` | Longest edge, in px, of the thumbnail that replaces an image in a tool result |
| `AGUI_IMAGE_PREVIEW_MAX_BYTES` | `49152` | Hard ceiling on the encoded thumbnail; over it the image is reported as omitted rather than shipped |

The model always receives the full image — these bound only what the event
stream carries. See [agui-protocol](../development/agui-protocol.md#image-results).
