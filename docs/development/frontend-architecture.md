# Frontend architecture (agentic_ui)

`agentic_ui` is organised **feature-first**: code is grouped by *what it does for
the user* (a feature/domain), not by *what kind of file it is*. A feature owns its
components, hooks, and handlers together; only genuinely cross-cutting code lives
in a shared layer. This replaced the earlier layer-first layout (`components/`,
`hooks/`, `handlers/`, `runtime/`), where a single `components/chat/` folder had
become a catch-all for ~10 unrelated features and nothing told you, per page,
what belonged to it.

The organising rule — and the answer to "shared or dedicated?":

> Used by **≥2 features** → it is **shared** (`shared/`). Used by **exactly one**
> feature → it lives **inside that feature** (dedicated). Don't pre-share; promote
> a module to `shared/` the moment a *second* feature imports it, and move it then.

## Directory layout

```text
src/
  main.tsx  App.tsx  error_boundary.tsx   # composition root (routing + providers)
  index.css  App.css  vite-env.d.ts

  pages/                     # one file per route — composes a feature, wires routing
    ChatPage.tsx             #   the persistent workspace shell (ChatShell) + Outlet
    ChatView.tsx             #   "/" and "/c/:id"
    TasksView.tsx            #   "/tasks"
    Login.tsx  SharedConvPage.tsx
    TermsAndConditions.tsx  PrivacyPolicy.tsx
    NotFound.tsx  ErrorPage.tsx  Test.tsx

  features/                  # one folder per feature; owns components/ hooks/ handlers/
    chat/          # conversation rendering + chat handlers/hooks + sidebar
      components/  #   ChatBody, ChatMessage, ChatInputBar, ChatHeader, ChatSidebar,
                   #   ConversationUsagePanel, AgentRunTimeline, HitlInputTakeover,
                   #   message_parts/*
      hooks/       #   useChatEffects, useActiveRunBranchSnap, useConversationRail,
                   #   useKeyboardShortcuts
      handlers/    #   conversations, messages, shortcuts, ui
    inference/     # the AG-UI run engine: agui, timeline, inference, hitl(+context),
                   #   useInferenceRuns, useRunTimeline, inferenceErrors, index (barrel)
    tasks/         # ScheduledTasksPage, scheduled_tasks_parts/*, useScheduledTasks
    settings/      # ProfilePanel, profile_parts/* (Account/DataControls/Personalization/
                   #   Shortcuts/Help/Mcp/Skills/Memories tabs), useProfilePanel,
                   #   useToolStatus, useSkills, useMemories, preferences handler
    sharing/       # SharePanel + share handler
    reporting/     # ReportPanel + report handler
    search/        # SearchPanel + search handler
    voice/         # VoiceModeBody + useChatVoiceMode + useRealtimeVoiceSession + voice handler
    attachments/   # AttachmentPreviewPanel + attachment_preview_parts/* + attachment handler
    auth/          # useSessionEffects + auth handler (Login page stays in pages/)
    catalog/       # agents handler (agent/tool discovery)

  shared/                    # cross-cutting, feature-agnostic (imports NOTHING from features)
    ui/                      # design system — shadcn base + ai-elements + react_bits + shadcn-io
    lib/                     # api, http, schemas, types, consts, utils + persistence
                             #   (authStorage, uiStateStorage, cookieConsentStorage), shortcuts
    stores/                  # workspaceStore (Zustand)
    hooks/                   # use-mobile, use-toast (framework-generic)

  handlers/index.ts          # TRANSITIONAL aggregator — see "Known transitional state"
```

## Layering rules

1. **Dependency direction is one-way:** `pages → features → shared`. `shared/`
   never imports from `features/`; features never import from `pages/`.
2. **`shared/` is feature-agnostic.** If you want to import a feature's type into
   `shared/`, either the type belongs in `shared/` or the dependency is inverted.
3. **Pages are thin** — compose a feature and wire routing. No `fetch`, no business
   logic. (The chat shell, `pages/ChatPage.tsx`, is the one exception still being
   unwound — see below.)
4. **Colocation + promote-on-second-use.** One consumer = dedicated (lives in the
   feature); a second consumer = move it to `shared/`.
5. **`@/` is the only alias**, mapped to `src/` (vite + tsconfig). Imports read
   `@/features/<f>/…` and `@/shared/…`. Prefer absolute `@/` imports over deep
   relative chains.

## Shared vs dedicated (the current verdict)

- **Shared** (`shared/`): the design system (`shared/ui`), the data-contract +
  transport layer (`shared/lib`: `api`/`http`/`schemas`/`types`), utils/consts,
  persistence, `workspaceStore`, and the framework-generic hooks (`use-mobile`,
  `use-toast`). The one cross-feature *component* dependency is the chat message
  renderer (`features/chat/components/message_parts/Content`), consumed by
  `features/sharing` (SharePanel) and the public-share page.
- **Dedicated**: everything under a `features/<feature>/` folder is used by exactly
  that feature. This is what makes "what does `/tasks` own?" answerable — it's
  `features/tasks/`, nothing else.

## Known transitional state (intentional, tracked)

Two follow-ups remain; both are isolated and do not block the structure:

1. **`src/handlers/index.ts` is a transitional aggregator.** The handler *modules*
   now live in their features (`features/<f>/handlers/*`); this barrel only
   re-exports them so the still-monolithic shell's single `@/handlers` import keeps
   working. It disappears when the shell is thinned (below).
2. **`pages/ChatPage.tsx` (the workspace shell / `ChatShell`) is still a large
   component.** Thinning it into an `app/WorkspaceShell` that reads the Zustand
   store + a services context, and switching it to per-feature imports, is the
   next step. It is deliberately deferred (highest coupling) and tracked separately.

Also pending (low priority): per-feature `index.ts` **barrels** as the public
import surface, then routing cross-feature imports through them instead of deep
paths.

## Adding to the frontend

- New endpoint/contract → `shared/lib/` (`api.ts` + a schema in `schemas.ts`). See
  [dialogue-bridge-reference.md] and the API-contract notes.
- New feature → create `features/<feature>/{components,hooks,handlers}/`, keep it
  self-contained, and only reach into `shared/` (or another feature's public
  surface) — never the reverse.
- New shared primitive → `shared/ui` (shadcn) via `npx shadcn@latest add` (the
  `components.json` aliases point `ui`/`lib`/`utils`/`hooks` at `shared/`).
- A component/hook/handler used by a second feature → move it to `shared/`.
