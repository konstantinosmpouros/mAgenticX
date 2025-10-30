# Agentic UI

## Overview
The Agentic UI is a Vite + React 18 single-page application that renders the multi-agent chat experience. It consumes the dialogue bridge REST APIs, streams AG-UI events over SSE, and visualises agent thinking, tool calls, and attachments in real time.

## Experience Goals
The frontend focuses on keeping conversations fluid while exposing the reasoning steps taken by each agent. It balances productivity features—attachments, private mode, rapid agent switching—with clear status indicators so operators always understand what the system is doing.

## What Lives Here
This directory contains the full React codebase, build tooling, UI component primitives, and the Nginx configuration used for production deployments. Everything needed to develop, test, or ship the frontend sits within this folder.

## Responsibilities
- Handle user authentication, session refresh, and logout by calling the dialogue bridge endpoints and persisting session metadata locally.
- Present a conversations workspace with agent selection, conversation switching, private-mode toggles, and message threading.
- Upload, validate, and preview attachments (images and files) before submitting them to the bridge.
- Stream inference responses via AG-UI frames and render the assistant's thoughts, tool invocations, and final messages incrementally.

## Application Structure
- `src/components/ChatInterface.tsx` orchestrates the chat layout, sidebars, composer, and stream lifecycle.
- `src/components/handlers/` contains domain-specific state machines for auth, conversations, messages, attachments, and inference streaming.
- `src/components/layouts/` and `src/components/ui/` provide shell components built on Radix primitives and Tailwind CSS utilities.
- `src/lib/api.ts` wraps all REST and SSE calls, adds `credentials: "include"`, and maps JSON payloads into typed models.
- `src/lib/authStorage.ts` manages localStorage persistence of session data (user profile, selected agent, private-mode flag).
- `src/lib/uploadGuards.ts` enforces file-count and size checks that mirror the Nginx proxy limits, and `src/lib/utils.ts` provides helpers for base64 encoding and SSE parsing.
- `src/hooks/` hosts utilities for breakpoints, toasts, and client-side effects. Routing is handled by `react-router-dom` in `App.tsx`.

## Authentication & Session Handling
`lib/api.ts` exposes `authenticate`, `refreshSession`, and `logout` helpers that forward to `/api/authenticate` and `/api/session/refresh`. Responses are normalised into `AuthResponse` models and cached via `authStorage`. A global `mx:unauthorized` event triggers UI fallbacks when cookies expire.

## Conversations, Streaming, and State
`ChatInterface` composes handler hooks to load agents, fetch paginated conversations, and manage optimistic UI updates when messages are sent. `handlers/inference.ts` opens an SSE stream to `/api/users/{...}/inference/stream`, decodes AG-UI frames with `parseSSE`, and feeds them into the transcript. Thinking/tool/render events flow through dedicated handler modules so the UI can present nested timelines.

## Attachments
Users can drop multiple files per message. `uploadGuards` ensures per-file, aggregate, and base64-inflated payload limits match the 600 MB cap configured in `nginx.conf`. `convertFileAttachments` transforms `File` objects into `AttachmentIn` payloads (base64 blobs) before they are posted to the bridge. Image attachments are previewed inline while other files can be downloaded via signed URLs returned by the backend.

## Development Workflow
```shell
cd src/agentic_ui
npm install
npm run dev
```

The Vite dev server listens on `http://localhost:8080` (`vite.config.ts`). Because API calls target `/api/...`, configure a Vite proxy to the dialogue bridge (or run the UI inside Docker Compose where Nginx already forwards `/api` to `dialogue_bridge:8002`).

## Build & Deployment
```shell
npm run build
npm run preview   # optional static preview
```

The Dockerfile performs a two-stage build (`node:20-alpine` -> `nginx:1.25-alpine`). The custom `nginx.conf` increases `client_max_body_size`, disables response buffering for SSE, and proxies `/api/` requests to `dialogue_bridge:8002`. Environment variables `BFF_HOST` and `BFF_PORT` are passed through by compose for documentation purposes; current builds rely on the Nginx proxy target baked into the config.

## Tooling
- `npm run lint` runs ESLint over the codebase.
- Tailwind CSS with `shadcn/ui` components is used for styling; themes are toggled via `next-themes`.
- `lovable-tagger` is enabled in development mode for component tagging when working with AI-driven design tools.

Refer to the root `README.md` for stack-wide orchestration details and the dialogue bridge README for the backing APIs.
