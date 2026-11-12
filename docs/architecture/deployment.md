# Deployment — GitHub CD to Dennis

Production runs on **Dennis** (Oracle Cloud ARM64 VM, Docker Swarm), and every application release reaches it the same way: the image tags in [`magenticx/docker-compose-denis.yaml`](../../magenticx/docker-compose-denis.yaml) are the release, and [`.github/workflows/pipeline.yml`](../../.github/workflows/pipeline.yml) turns them into running services in two jobs: **`ci`** tests, then builds and publishes the images; **`cd`** only deploys. A release starts when a push to `main` changes `docker-compose-denis.yaml` (merging a pull request included), or when the repository owner clicks **Actions → CI/CD → Run workflow** on `main`; once the tests are green, the image steps of `ci` build each new tag natively on an ARM64 GitHub runner (one step per service), scan it, and publishes it to the **GitHub Container Registry** (`ghcr.io`, private packages). Only when every image is published does `cd` run: it runs in the GitHub environment **`production`** (= Dennis), calls a **Portainer stack webhook** — Portainer, which manages the stack, pulls `main` from the public repository itself and runs the Swarm rolling update — and watches the public site until the new versions answer. This pipeline never connects to Dennis over SSH, and Portainer stays the one thing that deploys, so the stack remains fully Portainer-managed. The webhook URL can do exactly one thing — redeploy what `main` already holds — which is why it is the trigger rather than a Portainer API key, which would be admin over the whole VM.

---

## Services Involved

```mermaid
flowchart LR
    You["push to main changing docker-compose-denis.yaml<br/>(or Run workflow)"] --> GHA["GitHub Actions<br/>pipeline.yml: ci → cd"]
    GHA -->|"docker push (GITHUB_TOKEN)"| GHCR["ghcr.io<br/>private packages"]
    GHA -->|"POST webhook (HTTPS via Cloudflare → NPM)"| Portainer["Portainer on Dennis"]
    Portainer -->|"git pull main"| GitHub["github.com repo (public)"]
    Portainer -->|"docker stack deploy --with-registry-auth"| Swarm["Swarm stack 'magenticx'"]
    Swarm -->|"pull images (read:packages token)"| GHCR
    GHA -->|"poll /api/health + /version.txt"| Site["agents.magenticx.com"]
```

---

## A Release — Full Sequence

The workflow has two jobs. **`ci`** is one job with a step per service: it runs on every push and pull request (on `ubuntu-24.04-arm`, since the images are built there), works out whether the change touched `docker-compose-denis.yaml`, tests every service, and — only when every test is green and the yml changed — runs one image step per service: it **publishes** the new tags (build, scan, push) for a push to `main` or a manual run, and **checks** them (build + scan, nothing pushed) for a pull request. **`cd`** deploys and builds nothing: it runs only after `ci` has published — never for a pull request — and tells Portainer to deploy.

```mermaid
sequenceDiagram
    participant Y as You
    participant CI as ci (arm64)
    participant G as GHCR
    participant CD as cd
    participant PT as Portainer (Dennis)
    participant S as Swarm

    Y->>CI: push to main changing the yml (or Run workflow)
    CI->>CI: tests green
    CI->>CI: refuse unless the repository owner started the run
    loop one step per service
        CI->>G: manifest inspect <tag>
        alt tag already published
            G-->>CI: exists → skip (never overwritten)
        else new tag
            CI->>CI: docker build --platform linux/arm64 --build-arg APP_VERSION=<tag>
            CI->>CI: Trivy: fixable CRITICAL? → job fails, nothing pushed, nothing deployed
            CI->>G: docker push
        end
    end
    CI->>G: anonymous pull of every image must be refused (private)
    CI-->>CD: every image published
    CD->>CD: refuse unless the repository owner started the run
    CD->>PT: POST stack webhook
    PT->>PT: git pull main
    PT->>S: stack deploy (new tags → Swarm pulls them)
    S->>S: rolling update, start-first; unhealthy → automatic rollback
    loop every 20 s, up to 15 min
        CD->>S: GET /api/health (.version) + /version.txt
    end
    CD-->>CD: green when both report the compose tags
```

---

## Phase 1 — Trigger: the yml changed

`docker-compose-denis.yaml` is the release, so a change to it is what starts the image steps of `ci` (and after them `cd`). The `ci` job works that out with `git diff` over the push range (`before..sha`) or the pull request's range (`base..merge`) — GitHub's push payload for Actions carries no file lists — and sets `release=true|false` for the image steps (and `deploy` for `cd`). A manual run always counts as a release.

| Event | `ci`'s image steps / `cd` do |
| --- | --- |
| Push to `main` that changed the yml (merging a PR included) | **publish** — `ci` builds and pushes, then `cd` deploys and verifies. Automatic |
| **Run workflow** on `main` | **publish** — whether or not the yml changed (without a new tag it changes nothing) |
| Pull request that changes the yml | **check** — `ci` builds + scans each new tag; nothing pushed, `cd` does not run |
| Anything else (docs-only push, PR not touching the yml, Run workflow on another branch) | nothing — CI only |

A pull request never publishes: Portainer only ever deploys `main`, so its images could not go live before the merge anyway, and publishing would permanently take the tag (tags are never overwritten) with code that is not merged yet. The merge is a push to `main`, and that releases. A publish run **fails closed** unless the repository owner (`github.triggering_actor`) pushed or started it, so a collaborator given write access later still cannot ship. One `ci` run per branch at a time (`ci-<ref>`, so two releases never build the same tag at once) and one deploy at a time (`deploy-production`); a PR's run is superseded by the PR's next push. GitHub keeps only the newest *waiting* run of a group, so if a release push is still waiting when another push to `main` lands, it is cancelled — re-run it with **Run workflow**.

---

## Phase 2 — Build: one step per service

Each service is one step running [`.github/scripts/release_image.sh`](../../.github/scripts/release_image.sh) on `ubuntu-24.04-arm` (native ARM64 — no QEMU; free for a public repository). It reads the service's tag from the compose file and asks GHCR whether it already exists. **Tags are immutable**: an existing tag is never rebuilt or pushed again, so a tag always names the same bytes, a re-run is harmless, and rolling back to an old tag is always possible. If the registry answer is ambiguous (network trouble rather than "not found"), the step fails instead of guessing, because a wrong guess would overwrite a published tag. Any failed step stops the job, and `cd` needs `ci`, so a half-built release never deploys.

The tag is baked in as `APP_VERSION`: the Python services stamp it on every log line (`"version"`), the bridge reports it on `/health`, and the UI serves it as `/version.txt`. A Trivy scan rejects any image with a **fixable** CRITICAL vulnerability — the image is never pushed. After the builds, every image named in the compose file is pulled with **no credentials**; if that works the image is public, and the job fails before deploying.

| Key fact | Value / detail |
| --- | --- |
| Image name | `ghcr.io/konstantinosmpouros/magenticx_<service>:vX.Y.Z` — prefixed like OrthodoxAI's `orthodoxai_<service>`, since GHCR packages share one account-wide namespace |
| Push credential | the workflow's own `GITHUB_TOKEN` (`packages: write`) — nothing stored |
| Labels | `org.opencontainers.image.source` (links the package to this repo), `.revision` (commit), `.version` (tag) |
| Scanner | `ghcr.io/aquasecurity/trivy:0.75.0`, pinned by digest; `--severity CRITICAL --ignore-unfixed` |
| Third-party actions | only `actions/checkout`, pinned to a commit SHA — everything else is the runner's own `docker`, `curl`, `python3` |

---

## Phase 3 — Deploy and verify

The `cd` job builds nothing: it runs in the `production` environment and POSTs the webhook stored there as the environment secret `PORTAINER_WEBHOOK_URL`. Portainer pulls `main` and redeploys; Swarm resolves each tag to its digest and only restarts services whose image or spec actually changed. The webhook returns before Swarm finishes, and the old tasks keep answering until the new ones are healthy, so a plain 200 proves nothing: the job polls `https://agents.magenticx.com/api/health` (`version`) and `/version.txt` until they equal the `dialogue_bridge` and `agentic_ui` tags in the compose file, for up to 15 minutes. `agents` and `rag_service` are internal and not reachable from outside; they are guarded by their Swarm healthchecks and the automatic rollback.

| Key fact | Value / detail |
| --- | --- |
| Update order | `start-first` — the old task serves until the new one is healthy |
| Failed update | `failure_action: rollback` on all four app services — an image that never turns healthy reverts by itself |
| GitHub environment | `production`: deployment branches `main` only, no required reviewers, holds `PORTAINER_WEBHOOK_URL`. The sibling projects use the same environment name and rules |

---

## Day to Day

| You do | What happens |
| --- | --- |
| Open a pull request that bumps a tag in `docker-compose-denis.yaml` — **patch only** (`v1.21.14 → v1.21.15`) | `ci` **check**: the new image builds and passes the scan, nothing is published |
| Merge it (or push the bump straight to `main`) | `ci` tests and **publishes** the new tag, then `cd` has Portainer pull `main` and deploy, and goes green when the new versions answer |
| **Actions** → **CI/CD** → **Run workflow** → `main` | re-runs a release by hand (e.g. after a failed one) |
| **Roll back** | revert the tag in the compose file and push / merge — the old image is still in GHCR. For an emergency, Portainer → Services → *service* → **Rollback** |

---

## Setting Up the Stack in Portainer (runbook)

The stack moved from Docker Hub to this flow once, in 2026; Docker Hub is no longer used. These are the steps to set it up again, for example after rebuilding Dennis. Do them in order. The first run publishes the images; the stack is created in step 5.

**1. Run CD once.** **Actions** → **CI/CD** (left list) → **Run workflow** → Branch `main` → **Run workflow**. After the tests, the image steps of `ci` publish every tag GHCR doesn't have yet and the privacy check passes; `cd`'s webhook step then **fails on purpose** if `PORTAINER_WEBHOOK_URL` does not exist yet.

**2. Check the packages** at `github.com/konstantinosmpouros?tab=packages`: four `magenticx_*` packages, **Private**, each linked to `mAgenticX`.

**3. GitHub — a GHCR pull token for Dennis.** Avatar → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)** (fine-grained tokens cannot read GHCR):

| Field | Value |
| --- | --- |
| Note | `Dennis Portainer — GHCR pull` |
| Expiration | 1 year — record the date in [secrets.md § Expiry dates](secrets.md) |
| Scopes | **only** `read:packages` |
| | **Generate token** → copy it once |

**4. Portainer — registry.** **Registries** → **Add registry** → **Custom registry**:

| Field | Value |
| --- | --- |
| Name | `ghcr` |
| Registry URL | `ghcr.io` |
| Authentication | ☑ — Username `konstantinosmpouros`, Password = the token from step 3 |
| | **Add registry** |

**5. Portainer — the stack.** If a `magenticx` stack already exists, back up both databases first (on Dennis), then delete it and wait until its networks are gone (`sudo docker network ls | grep magenticx_` prints nothing — deploying earlier fails with "network already exists"). External secrets, external networks (`proxy`, `mcp_gateway`, `sandbox`) and named volumes (`chat_convs`, `vectorstore`, `magenticx_data`) stay.

```bash
PG=$(sudo docker ps -q -f name=magenticx_chat_postgres)
sudo docker exec "$PG" pg_dump -U admin -d chat_db -Fc > ~/chat_db_$(date +%F).dump
sudo docker exec "$PG" pg_dump -U admin -d agent_runtime -Fc > ~/agent_runtime_$(date +%F).dump
```

**Stacks** → **Add stack**:

| Field | Value |
| --- | --- |
| Name | `magenticx` — **the same name**, so the existing volumes and secrets re-attach |
| Build method | **Repository** |
| Authentication | off — the repository is public |
| Repository URL | `https://github.com/konstantinosmpouros/magenticx` |
| Repository reference | `refs/heads/main` |
| Compose path | `magenticx/docker-compose-denis.yaml` |
| GitOps updates | ☑ → Mechanism **Webhook** → **copy the webhook URL** |
| Re-pull image / Force redeployment | leave **off** — Business Edition only, and not needed: every release is a new tag (so the service spec changes and Swarm pulls it) and a new commit (so Portainer has something to deploy) |
| Skip TLS Verification | **off** |
| Environment variables | none |
| | **Deploy the stack** |

Labels can differ slightly between Portainer versions. If GitOps updates offers only **Polling**, stop there — the `cd` job assumes a webhook and needs adjusting first.

**6. Verify:** `sudo docker service ls` shows every `magenticx_*` service `1/1`; `https://agents.magenticx.com/api/health` returns the `dialogue_bridge` tag as `"version"`; `https://agents.magenticx.com/version.txt` returns the `agentic_ui` tag; Microsoft sign-in works.

**7. GitHub — store the webhook and finish the run.** Repo → **Settings** → **Environments** → `production` (create it if missing: **Deployment branches and tags** → **Selected branches** → `main`; no required reviewers) → **Environment secrets** → **Add environment secret**: Name `PORTAINER_WEBHOOK_URL`, Value = the URL from step 5 → **Add secret**. Then open the run from step 1 → **Re-run jobs** → **Re-run failed jobs**. Only `cd` re-runs (the images are published), the webhook redeploys (a no-op now) and the job goes green — the pipeline is proven end to end.

---

## Sharp Edges and Behavioral Notes

- **No tag bump, no release** — a code change without a tag bump is never built (the existing tag is skipped). A Run workflow then only redeploys what is already there. Bump the tag in the same change as the code.
- **The repository is public, the images are not, and every release proves it** — anyone can read the code and the compose file, but the images exist only as private GHCR packages (the runner is a throwaway VM; Dennis keeps its pulled copies locally). The `Verify every image is private` step fails the release if any of them can be pulled anonymously — e.g. a new package that came out public, or someone flipped one in its settings. Nothing secret may ever go into the repository: secrets are Swarm secrets on Dennis or `production` environment secrets in GitHub.
- **Tags are never overwritten** — to rebuild a service, bump its tag. Deleting a package version in GHCR is the only way to reuse a tag; don't.
- **Portainer CE redeploys only on a new commit** — without the Business-only *Force redeployment*, a webhook call when `main` hasn't moved since the last deploy is a no-op. Harmless: a release always carries a new commit (the tag bump). It is also why tags must change per release — *Re-pull image* (Business) is what a reused tag would need.
- **The compose file is edited in git only** — a Git-based stack has no editor in Portainer. Stack environment variables set in Portainer survive redeploys; anything in the file comes from `main`.
- **A push that changes the yml goes straight to production** — the `production` environment deliberately has no required reviewers. The pull request's `ci` check is the review point: it proves the images build and pass the scan before you merge.
- **Destructive migrations run on the bridge's start** — read any new file under `core/database/migrations/versions/` before you push or merge the tag bump.
- **Credentials that expire** — the GHCR pull token (Swarm can no longer pull new images) and, if the stack still has one saved from when the repository was private, the repository read token (Portainer can no longer pull `main`, so redeploys fail; remove it rather than renew it). Running tasks keep running either way; rotate before the dates recorded in [secrets.md](secrets.md).
- **Cloudflare sits in front of both calls** — the webhook (`portainer.magenticx.com`) and the smoke check (`agents.magenticx.com`) go through Cloudflare. If Bot Fight Mode or "Under Attack" is ever enabled, GitHub's runners get challenged and the job fails; add a WAF skip rule for the webhook path rather than turning the protection off.
- **A leaked webhook URL** can only redeploy what `main` already holds. Still: regenerate it in Portainer (stack → GitOps → webhook) and update the `production` environment secret.
- **Still manual** — mTLS entrypoint scripts (bind-mounted files, staged rollout in CLAUDE.md § Internal mTLS), and creating or rotating Swarm secrets.
- **The siblings deploy themselves, from their own repositories.** Monitoring is the Swarm stack `monitoring`, released through its own Portainer webhook. The MCP gateway and the sandbox runner are plain Docker Compose projects (dind needs `privileged`, which Swarm ignores); their pipelines reach Dennis over Tailscale with a forced-command SSH key that can only run that project's deploy script. Nothing in this repository deploys them.
- **MCP and `execute` are set in the compose file, not in Portainer** — both are optional sibling projects (the code defaults leave them off), and `docker-compose-denis.yaml` turns both on: `MCP_GATEWAY_URL=http://mcp_gateway:8005/sse` for [mcp_gateway](https://github.com/konstantinosmpouros/mcp_gateway), and `SANDBOX_EXECUTION_ENABLED=true` + `SANDBOX_RUNNER_URL=https://sandbox_runner:8090` for [sandbox](https://github.com/konstantinosmpouros/sandbox) (see [sandboxed-execution.md](../flows/sandboxed-execution.md)). To run production without MCP, change that line to `- MCP_GATEWAY_URL=` and release: no gateway calls, an empty tool catalog, declared MCP tools listed unavailable. On but the gateway down: chats still run — each run waits up to `MCP_CONNECT_TIMEOUT_SECONDS` (default 10) and continues without MCP tools (`mcp_session_unavailable` in the agents logs) — while the tool catalog returns 502. The external `mcp_gateway` and `sandbox` overlay networks stay required either way: they were created once by hand and are shared with the siblings' composes. To run production without `execute`, set `SANDBOX_EXECUTION_ENABLED=false` and release.
- **Package name collisions** — GHCR packages live in the account namespace. The images are prefixed `magenticx_` so they cannot clash with OrthodoxAI's same-named services. A pre-existing package of the same name linked to a different repository makes the push fail with `denied` (never an overwrite).

---

## File Map

| Concept | File | What to look for |
| --- | --- | --- |
| CI + CD jobs | [.github/workflows/pipeline.yml](../../.github/workflows/pipeline.yml) | `ci` (its *Is this a release?* step, `RELEASE_MODE`, the owner check, one test step and one image step per service, the privacy check), `cd` (its `if:`, owner check, webhook, wait for live) |
| Build, scan, push one service | [.github/scripts/release_image.sh](../../.github/scripts/release_image.sh) | tag lookup, "already published?" check, Trivy gate |
| The release (tags + stack config) | [magenticx/docker-compose-denis.yaml](../../magenticx/docker-compose-denis.yaml) | `image: ghcr.io/...`, `deploy.update_config` / `rollback_config` |
| Version baked into images | `magenticx/<service>/Dockerfile` | `ARG APP_VERSION` |
| Bridge version on `/health` | [magenticx/dialogue_bridge/main.py](../../magenticx/dialogue_bridge/main.py) | `health()` |
| UI version file | [magenticx/agentic_ui/Dockerfile](../../magenticx/agentic_ui/Dockerfile) | `/usr/share/nginx/html/version.txt` |
| Deployment credentials | [docs/architecture/secrets.md](secrets.md) | § Deployment credentials |
