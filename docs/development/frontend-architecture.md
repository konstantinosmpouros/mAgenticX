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
  index.css                  # entry point only — an ordered @import list, no rules
  vite-env.d.ts
  styles/                    # the actual CSS, split by domain
    theme/                                #   design tokens, one file per theme + themes.ts registry (see its README)
    base.css                              #   reset, body, shared transition utils
    voice-transitions.css                 #   the stacked chat/voice body panels
    composer.css  orb.css                 #   the composer's light; the AI orb (shared/ui/orb.tsx) per state
    skeleton.css  toast.css  markdown.css scrollbars.css  misc.css

  app/                       # the persistent workspace shell (App.tsx's layout route)
    WorkspaceShell.tsx       #   sidebar, search, profile/dialog modals, the <Outlet/> slot
    useChatWorkspace.tsx     #   builds the workspace bundle once per render
    workspaceContext.ts      #   the route views' accessor for that bundle (a React context)
    useIncognitoCard.ts

  pages/                     # one file per route — composes a feature, wires routing
    ChatView.tsx             #   "/" and "/c/:id"
    AutomationsView.tsx      #   "/automations" (?agent= / ?template= open the create form)
    LegacyTasksRedirect.tsx  #   "/tasks" → "/automations", query kept (one release)
    AgentsView.tsx           #   "/agents…" — layout over the chat; the agents pages render in its outlet
    Login.tsx  SharedConvPage.tsx
    TermsAndConditions.tsx  PrivacyPolicy.tsx
    NotFound.tsx  ErrorPage.tsx

  features/                  # one folder per feature; owns components/ hooks/ handlers/
    agents/        # the Agents section: gallery, agent page (Overview/Tools/Approvals/
                   #   Memory/History), the builder; pages/ (AgentsGallery, AgentPage,
                   #   AgentBuilderPage), hooks (useAgentTools, useMemories, …), lib/
    chat/          # conversation rendering + chat handlers/hooks + sidebar
      components/  #   ChatBody, ChatMessage, ChatInputBar, ChatHeader, ChatSidebar,
                   #   AgentRunTimeline, HitlInputTakeover, ComposerTaskNotices,
                   #   message_parts/* (incl. the async-task parts: TaskTreeCards,
                   #   TaskRefBlockView, TaskSettledMarker, TaskNoticeRow, MessageTaskTree,
                   #   TaskStopButton; TaskSidePanel in RunSidePanels; AnswerSourcesPanel)
      lib/         #   pure helpers, e.g. taskTreeAdapter (task tree → sub-agent cards),
                   #   sources (the citation source registry: durable + events + live,
                   #   plan 42), citationText (markers → [1] + "Sources:" for Copy),
                   #   answerSources (an answer's sources: pointed-at first, then More)
      hooks/       #   useChatEffects, useActiveRunBranchSnap, useConversationRail,
                   #   useKeyboardShortcuts, useTaskClock, useConversationSources,
                   #   useAnswerSources
      handlers/    #   conversations, messages, shortcuts, ui
    inference/     # the AG-UI run engine: agui, timeline, inference, hitl(+context),
                   #   useInferenceRuns, useRunTimeline, inferenceErrors, index (barrel);
                   #   async sub-agent tasks (plan 41): taskTree (the conversation-level
                   #   tree fold), useBackgroundTasks (tree + conversation channel + task
                   #   sockets + composer queue), backgroundTasks-context
    automations/   # the Automations page (plan 38): AutomationsPage, automations_parts/*
                   #   (AutomationCard, ScheduleForm, AutomationFormDialog, AutomationToolbar,
                   #   TemplateSection, TemplateCard, EmptyState, ErrorState), hooks/useAutomations,
                   #   lib/ (kinds registry, filters, templates, task status, routes, styles)
    settings/      # ProfilePanel (ChatGPT-taxonomy settings modal on the premium dark
                   #   shell), EditProfileDialog, ShortcutsPanel + HelpPanel (dedicated
                   #   modals, not settings tabs), profile_parts/* (General/Personalization
                   #   (+CustomInstructionsDialog)/Voice/Usage/Security/DataControls/Account
                   #   real tabs + ComingSoon stubs + Skills/Mcp workspace tabs),
                   #   useProfilePanel, useSkills, useUsageSummary, preferences handler
    sharing/       # SharePanel + share handler
    reporting/     # ReportPanel + report handler
    search/        # SearchPanel + search handler
    voice/         # VoiceModeBody + useChatVoiceMode + useRealtimeVoiceSession + voice handler
    attachments/   # AttachmentPreviewPanel + attachment_preview_parts/* + attachment handler
    auth/          # useSessionEffects + auth handler (Login page stays in pages/)
    catalog/       # agents handler (agent/tool discovery)

  shared/                    # cross-cutting, feature-agnostic (imports NOTHING from features)
    ui/                      # design system — shadcn base + ai-elements + react_bits + shadcn-io
                             #   (ai-elements/inline-citation: the citation pill + card, plan 42;
                             #   site-icon: a source's favicon from our own origin)
    lib/                     # api, http, schemas, types, consts, utils + persistence
                             #   (authStorage, uiStateStorage, cookieConsentStorage), shortcuts,
                             #   schedule + workflowSchedule (schedule wording / preview shared
                             #   by Automations → Schedules and the workflow builder),
                             #   citations + remarkCitations + citations-context (inline
                             #   citation markers, the remark plugin, the sources context),
                             #   siteIcons (favicon host + failed-host memo)
    stores/                  # workspaceStore (Zustand)
    hooks/                   # use-mobile, use-toast (framework-generic), useSessionUserId

```

## Layering rules

1. **Dependency direction is one-way:** `app/pages → features → shared`.
   `shared/` never imports from `features/`; features never import from `app/`
   or `pages/`. `app/` and `pages/` are the composition layer: the shell renders
   `ChatView`, and the route views read the shell's bundle through
   `app/workspaceContext`.
2. **`shared/` is feature-agnostic.** If you want to import a feature's type into
   `shared/`, either the type belongs in `shared/` or the dependency is inverted.
3. **Pages are thin** — compose a feature and wire routing. No `fetch`, no business
   logic. The shell's own wiring lives in `app/`, not in a page.
4. **Colocation + promote-on-second-use.** One consumer = dedicated (lives in the
   feature); a second consumer = move it to `shared/`.
5. **`@/` is the only alias**, mapped to `src/` (vite + tsconfig). Imports read
   `@/features/<f>/…` and `@/shared/…`. Prefer absolute `@/` imports over deep
   relative chains.
6. **Barrels are for outside consumers; inside a folder, deep-import the leaf.**
   `shared/lib/{api,types,consts}` are folders whose `index.ts` re-exports the
   domain modules, so all ~110 importing files keep a single stable import path.
   A module *within* one of those folders must import its sibling directly
   (`from "./agents"`), never `from "."` — a barrel self-import is a real cycle.
   Same rule across folders: `types/preferences.ts` reaches into
   `consts/personalization` (a leaf), not the `consts` barrel. This is what
   dissolved the pre-existing `types ↔ consts` cycle, which had been survivable
   only because both directions happened to be type-only and got erased.

## Shared vs dedicated (the current verdict)

- **Shared** (`shared/`): the design system (`shared/ui`), the data-contract +
  transport layer (`shared/lib`: `api`/`http`/`schemas`/`types`), utils/consts,
  persistence, `workspaceStore`, and the framework-generic hooks (`use-mobile`,
  `use-toast`). The one cross-feature *component* dependency is the chat message
  renderer (`features/chat/components/message_parts/Content`), consumed by
  `features/sharing` (SharePanel) and the public-share page.
- **Dedicated**: everything under a `features/<feature>/` folder is used by exactly
  that feature. This is what makes "what does `/automations` own?" answerable — it's
  `features/automations/`, nothing else.

## Inline citations (plan 42)

The answer's `[src:ID]` markers become citation pills. The pieces sit on both
sides of the `shared/` boundary, so the dependency direction holds:

| Piece | File | Role |
| --- | --- | --- |
| Marker grammar | `shared/lib/citations.ts` | The contract regex, id parsing, hostname, `hideUnclosedCitationMarker` (streaming), code-aware `replaceCitationMarkers` |
| Remark plugin | `shared/lib/remarkCitations.ts` | Marker → `mx-citation` element with `data-ids`; skips code, math, HTML, link text |
| Components | `shared/ui/ai-elements/inline-citation.tsx` | AI Elements' `InlineCitation` family on our `HoverCard`; `SourceCitation` resolves ids, drops unknown ones, renders nothing when none is known |
| Sources context | `shared/lib/citations-context.ts` | `CitationSourcesContext` (a `Map<id, CitationSource>`), read by the pill; empty outside a provider |
| Contract + API | `shared/lib/schemas.ts` (`CitationSourceSchema`, `ConversationSourcesSchema`), `types/citations.ts`, `api/citations.ts` (`getConversationSources`) | http(s) URLs only, capped text; a bad entry is dropped, never the list |
| Run fold | `features/inference/timeline.ts` | `SOURCES` events (top-level or in `SUBAGENT_EVENT`) → `RunTimeline.sources`; `collectRunSources(events)` reads a log without folding it |
| Registry | `features/chat/lib/sources.ts` + `hooks/useConversationSources.ts` | Durable list (TanStack Query; a share's frozen `sources` instead) + settled messages' events + background-task timelines + the live run; reloads when a run ends or a task notification arrives |
| Copy | `features/chat/lib/citationText.ts` | Markers → `[1]`, `[2]` by first appearance + a `Sources:` list; used by `ChatMessage`, `answerGroupText` and a sub-agent card's copy |
| Search step chips | `features/chat/components/message_parts/SourceCards.tsx` | A tool step whose `SOURCES` event names pages (`TimelineToolExecution.sources`, attached by `tool_call_id`) shows them as compact chips (`aria-label="Sources"` list): the site icon + the page title (truncated) or its host, the whole chip a safe link, full title + host in its tooltip — for any search tool. Its `TOOL_CALL_RESULT` arrives empty: the page contents never reach the browser |
| Site icon | `shared/ui/site-icon.tsx` + `shared/lib/siteIcons.ts` + `api/favicons.ts` (`faviconUrl`) + `shared/hooks/useSessionUserId.ts` | A 14–16px favicon from **our own origin only** (`GET /api/v1/favicons/{user_id}?host=…`, the bridge fetches and caches it; lazy, async, no referrer, decorative). User id from the workspace store (signed in, not pending deletion); no user (public share page) or a load error → the site's initial on a muted tile (drawn by CSS, so it never joins copied text). Failed hosts are remembered for the session. Used by the chips, the citation pill, the pill's card and the Sources panel |
| Answer Sources panel | `features/chat/lib/answerSources.ts` + `hooks/useAnswerSources.ts` + `message_parts/AnswerSourcesPanel.tsx` | "Sources" in an answer's More menu (`AIActionBar`, only when it has any) opens a right Sheet for the whole answer group: first the sources its members' `[src:…]` markers point at (first appearance, resolved via the registry, unknown ids dropped), no heading; then "More" — the rest of the union of the members' `SOURCES` events (+ the bar message's timeline), 8 shown, "N more" reveals the others. http(s) only, no repeats by id or URL |

The renderers opt in: `Response citations` (agent answers: `ContentBlockView`,
an AI `MessageContent`) and `MarkdownRenderer citations` (off by default, so an
attachment preview or a person's text is never rewritten). The provider sits in
`app/WorkspaceShell` (from `useChatWorkspace`) and on `pages/SharedConvPage`.

## Known transitional state

The former `pages/ChatPage.tsx` shell is gone: `App.tsx` mounts
`app/WorkspaceShell` as a layout route around `/`, `/c/:id`, `/automations` and
`/agents…`, so the shell never unmounts while the URL picks the view in its
`<Outlet/>`. The workspace bundle reaches the views through a React context
(`app/workspaceContext.ts`), not a store slice — the file's header explains why.

The former `src/handlers/index.ts` aggregator is **gone**. It re-exported the
feature handler modules so the shell could keep a single `@/handlers` import;
the shell now imports each handler from the feature that owns it, which is what
makes the dependency direction visible at the import site.

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
