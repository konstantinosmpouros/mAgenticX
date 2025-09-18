# Agentic UI

## Overview

Front-end for the mAgenticX platform. A Vite + React 18 single-page app renders the multi-agent chat experience, subscribes to AG-UI SSE streams coming from the dialogue bridge, and visualises reasoning steps, tool calls, and attachments in real time.

## Responsibilities

- Authenticate users and list available agents via the dialogue bridge APIs.
- Provide a chat-first UX with support for multiple conversations, agent selection, message threading, and AG-UI thought visualisation.
- Handle uploads for files and images, display rendered previews, and surface server-side validation errors.
- Stream conversation updates from `/inference/stream` endpoints and render incremental content using the AG-UI protocol components.

## Key Technologies

- React 18 + TypeScript bundled with Vite.
- Component system built with `shadcn/ui` (Radix primitives) and Tailwind CSS utility styling.
- `@ag-ui/core` for decoding and presenting AG-UI protocol frames.
- `@tanstack/react-query` for data fetching and caching.
- `react-hook-form`, `zod`, and Tailwind for form validation and layout.
- Nginx (multi-stage Dockerfile) for serving the production build.

## Application Structure

```shell
src/
  components/
    handlers/      Stream handlers and message transforms
    layouts/       Chat shell, sidebars, and top-level scaffolding
    utils/         Shared widgets used across chat views
    ChatInterface.tsx
  hooks/           Custom hooks for responsive breakpoints and toasts
  lib/             API client, persistence helpers, shared types
  pages/           Route-level screens (landing, 404)
  App.tsx          Composition of providers and main layout
  main.tsx         Application bootstrap and render root
```

Refer to the component directories for concrete implementations such as the chat interface, agent picker, and SSE stream renderer.

## Environment Variables

- `BFF_HOST` and `BFF_PORT` are injected at build time (see Dockerfile) and tell the UI where the dialogue bridge lives (`dialogue_bridge:8002` by default when running inside compose).

## Local Development

```shell
cd src/agentic_ui
npm install
npm run dev
```

The dev server runs on port `5173` by default. Configure a `.env` file or Vite env vars (`VITE_BFF_URL`, etc.) if you need to override backend locations during local work.

## Production Build

```shell
npm run build
npm run preview   # optional smoke test of the static build
```

The Dockerfile performs a multi-stage build (`node:20-alpine` builder -> `nginx:1.25-alpine`) and copies the compiled `/dist` assets into Nginx. Custom `nginx.conf` enables history fallback for `react-router`.

## Service Interactions

- Consumes the `dialogue_bridge` HTTP APIs for authentication, conversation CRUD, and SSE streaming.
- Indirectly reaches the `agents` service through the dialogue bridge proxy; AG-UI event decoding ensures thought and tool steps render correctly in the front end.
