# Agentic UI

React + Vite 18 single-page app for the mAgenticX chat experience. It talks only to the dialogue bridge, streams AG-UI SSE frames, and renders agent thinking, tool calls, branches, and attachments in real time.

## What it does

- Authenticates against the bridge, keeps session cookies fresh, and persists the signed-in user locally.
- Renders the chat workspace with agent switching, paginated conversation history, private-mode toggles, branching, and message editing/retries.
- Validates and uploads attachments (per-file, aggregate, and base64-inflated payload size) against the 600 MB proxy cap before posting to the bridge.
- Streams inference over SSE and paints thinking/tool frames incrementally, including branch-aware `messagePath` replies from the bridge.
- Provides voice dictation in the composer (WebAudio -> `/api/users/{userId}/dictation/transcribe` -> transcript dropped into the draft).
- Surfaces the MCP tool catalog and per-user tool disablement in the profile panel; preferences are saved through the bridge and respected when sending inference configs.
- Persists lightweight UI state (agents, tools, conversation summaries, sidebar tab, selected agent, private-mode toggle) in IndexedDB for fast reloads.

## Code map

- `src/components/ChatPage.tsx` (exports `ChatInterface`) orchestrates the layout, state, streaming lifecycle, UI snapshot persistence, and handler wiring.
- `src/components/chat/` holds the UI surfaces (header, sidebar, profile panel with MCP tools, message body, input bar with recorder).
- `src/components/handlers/` are domain-specific state machines for auth/session refresh, roster + tools fetch, conversations + pagination, inference streaming (SSE parsing and retries), attachments, preferences, branching, and UI affordances like sticky bars.
- `src/lib/api.ts` wraps every bridge endpoint (auth/session, agents, tools, preferences, dictation, conversations, attachments, inference) with credentialed fetch helpers and SSE parsing.
- `src/lib/uploadGuards.ts`, `src/lib/utils.ts`, `src/lib/authStorage.ts`, and `src/lib/uiStateStorage.ts` cover client-side validation (size limits aligned with Nginx), persistence, and utility helpers.
- `nginx.conf`, Tailwind config, and the Dockerfile live here for production builds; the Nginx config bumps `client_max_body_size` and keeps SSE unbuffered.

## API expectations

- The dev server runs on `http://localhost:8080`; `/api/*` must be proxied to the dialogue bridge (Compose already routes to `dialogue_bridge:8002`).
- Voice dictation uses the bridge proxy for `/users/{userId}/dictation/transcribe` and expects `gpt-4o-transcribe` on the agents service.
- MCP tool discovery/preferences use `/api/tools` and `/api/users/{userId}/preferences`, then annotate inference requests with the enabled tools list.
- Nginx disables response buffering for `/api/*` so SSE frames and attachment downloads remain streaming; keep `client_max_body_size 600M` in sync with `PROXY_LIMIT_MB` in `uploadGuards.ts`.

## Development

```shell
cd src/agentic_ui
npm install
npm run dev
```

## Build & Deploy

```shell
npm run build
npm run preview   # static preview of the built assets
```

The Dockerfile produces an nginx image; environment hints `BFF_HOST/BFF_PORT` are informational because the proxy target is baked into `nginx.conf`.

## Tooling

`npm run lint` runs ESLint; Tailwind + shadcn provide the design system components.
