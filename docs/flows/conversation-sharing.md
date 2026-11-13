# Conversation Sharing

Conversation sharing lets an owner publish a frozen, read-only snapshot of a conversation (or a subset of it) via a token-bearing URL. The snapshot is self-contained — it embeds all message content and the data of every upload and every file the agent *presented* (a file the agent only wrote, never presented, stays out: `is_shareable`) — so the share remains stable even if the original conversation is later edited or deleted. Recipients can view the share without authentication; authenticated users can fork the snapshot into their own workspace and continue the conversation. Owners can revoke shares at any time and set an expiration date up to one year in the future. A separate, lighter-weight report mechanism lets users flag conversations for moderation without creating a public link.

---

## Services Involved

```mermaid
flowchart LR
    Browser["Browser"] -->|"POST /share, GET /share/token"| nginx["nginx :8050"]
    nginx --> bridge["dialogue_bridge :8002"]
    bridge -->|"SELECT/INSERT/UPDATE"| pg[("chat_postgres<br/>conversation_shares<br/>conversation_reports")]
    bridge -->|"build snapshot"| snap["snapshot builder<br/>(utils/conversations.py)"]
    bridge -->|"render PDF"| pdf["PDF renderer<br/>(utils/share_export.py)"]
```

---

## Full Sequence — Create and View a Share

```mermaid
sequenceDiagram
    participant Owner as Owner Browser
    participant D as dialogue_bridge
    participant PG as chat_postgres

    Owner->>D: POST /v1/conversations/{userId}/{convId}/share
    D->>PG: SELECT messages (lineage up to messageId)
    PG-->>D: message rows + attachment blobs
    D->>D: select_scoped_messages(mode)
    D->>D: build_share_snapshot() → snapshot_json
    D->>PG: INSERT conversation_shares (token, snapshot_json, expires_at)
    PG-->>D: share row
    D-->>Owner: { token, shareUrl, shareMode, expiresAt, ... }

    Note over Owner: Owner copies /share/{token} link

    participant Viewer as Anyone (no auth)
    Viewer->>D: GET /v1/shared-conversations/{token}
    D->>PG: SELECT WHERE token=? AND is_active=true AND (expires_at IS NULL OR expires_at > now)
    PG-->>D: share row with snapshot_json
    D-->>Viewer: SharedConversationDetail (messages from snapshot)
```

---

## Phase 1 — Database Tables

### conversation_shares

| Column | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | String (UUID) | `gen_uuid()` | Row PK |
| `token` | String | `token_urlsafe(32)` | URL-safe random token; UNIQUE, INDEXED |
| `conversation_id` | String (FK) | — | Source conversation; CASCADE delete; INDEXED |
| `owner_user_id` | String (FK) | — | Share creator; CASCADE delete |
| `snapshot_until_message_id` | String (FK) | — | Last message included; SET NULL on message delete; INDEXED |
| `title` | String | `null` | Conversation title at share creation |
| `snapshot_json` | JSON | — | Frozen snapshot (messages + attachments); NOT NULL |
| `is_active` | Boolean | `true` | `false` after revocation |
| `revoked_at` | DateTime | `null` | Revocation timestamp |
| `expires_at` | DateTime | `null` | Expiry timestamp; `null` = never expires; INDEXED |
| `created_at` | DateTime | `now()` | Creation timestamp |
| `updated_at` | DateTime | `now()` | Last update timestamp |

Multiple shares per conversation are allowed — there is no unique constraint on `conversation_id`. A conversation can have several active links with different scopes or expiration dates simultaneously.

### conversation_reports

| Column | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | String (UUID) | `gen_uuid()` | Row PK |
| `conversation_id` | String (FK) | — | Reported conversation; CASCADE delete; **UNIQUE** |
| `user_id` | String (FK) | — | Reporter; CASCADE delete |
| `message_id` | String (FK) | `null` | Specific message reported (optional); SET NULL |
| `reason` | String | — | Required; max 120 chars |
| `details` | Text | `null` | Extended description; max 2000 chars |
| `status` | String | `"open"` | Moderation status |
| `created_at` | DateTime | `now()` | — |
| `updated_at` | DateTime | `now()` | — |

The `UNIQUE` constraint on `conversation_id` means a conversation can only be reported once.

---

## Phase 2 — Share Scope Modes

The three share modes determine which messages are included in the snapshot. All three use the same message object format; only the selection differs.

```mermaid
flowchart TD
    A[shareConversation request<br/>messageId + mode] --> B[build_message_lineage<br/>root → messageId]
    B --> C{mode?}
    C -->|full| D[all messages in lineage]
    C -->|branch| E[all messages in lineage<br/>validated against branchPath]
    C -->|message| F{has user<br/>predecessor?}
    F -->|yes| G[parent user msg<br/>+ target AI msg]
    F -->|no| H[target AI msg only]
    D --> Z[build_share_snapshot]
    E --> Z
    G --> Z
    H --> Z
    Z --> ZZ[INSERT conversation_shares]
```

### Mode: `full`

Every message from the conversation root down to the target message is included. This is the only mode from which a recipient can fork and continue the conversation. `branchPath` is validated if provided to confirm the message belongs to the expected branch.

### Mode: `branch`

Behaves identically to `full` for most conversations. The distinction matters only when `branchPath` is explicitly supplied: the lineage is filtered to match the provided path, ensuring the snapshot captures a specific branch of the message tree rather than an unexpected one.

### Mode: `message`

The minimal snapshot: just the target AI message and its immediate user predecessor (if one exists). Used for sharing a single response without exposing the full conversation context.

### Snapshot JSON Structure

All modes produce the same JSON envelope:

```json
{
  "shareMode": "full | branch | message",
  "title": "Conversation Title",
  "agent": {
    "id": "agent-uuid",
    "name": "Agent Name",
    "description": "...",
    "icon": "IconName",
    "version": "1.0.0",
    "isActive": true
  },
  "messages": [
    {
      "id": "msg-uuid",
      "parentMessageId": "parent-uuid",
      "content": "Message text",
      "sender": "user | ai",
      "type": "text | file | image | audio | tool",
      "liked": null,
      "created_at": "2026-05-10T14:00:00Z",
      "updated_at": "2026-05-10T14:00:00Z",
      "attachments": [
        {
          "id": "att-uuid",
          "name": "report.pdf",
          "mime": "application/pdf",
          "size": 102400,
          "timestamp": "2026-05-10T14:00:00Z",
          "data": "<base64-encoded blob>"
        }
      ],
      "thinking": ["reasoning step 1", "..."],
      "thinkingTime": 2500,
      "error": false,
      "errorMessage": null,
      "rawEvents": [],
      "plan": {},
      "subagents": {}
    }
  ],
  "sources": [
    {"id": "3fa2c1", "url": "https://example.com/a", "title": "…", "snippet": "…", "tool": "tavily-search"}
  ]
}
```

Attachment blobs are base64-encoded and embedded directly in the JSON. `sources` (plan 42) holds only the citation sources the shared messages cite, and is absent when they cite none. The snapshot is fully self-contained.

---

## Phase 3 — API Endpoints

### Owner Endpoints (authentication + CSRF required)

**`POST /v1/conversations/{userId}/{conversationId}/share`** — Create a share link

```json
{
  "messageId": "msg-uuid",
  "mode": "full | branch | message",
  "branchPath": ["id1", "id2"],
  "expiresAt": "2026-06-10T00:00:00Z"
}
```

- `messageId` must point to an AI message
- `expiresAt` defaults to 30 days from creation; max 365 days; `null` = never expires
- Returns `ConversationShareResponse` with `token`, `shareUrl`, `shareMode`, `isActive`, `expiresAt`

**`DELETE /v1/conversations/{userId}/{conversationId}/share/{shareId}`** — Revoke a share

Sets `is_active = false`, `revoked_at = now()`. Permanent — cannot be un-revoked. Returns 204.

**`GET /v1/conversations/{userId}/shares`** — List owner's shares

Paginated (`page`, `size` 1–50). Each item includes a computed `status` field:
- `"active"` — `is_active = true` and not expired
- `"expired"` — `expires_at` is in the past
- `"revoked"` — `is_active = false`

**`POST /v1/conversations/{userId}/{conversationId}/share/export-pdf`** — Export to PDF

Builds the message selection from `messageId` + `mode` identically to a share, then renders a PDF. The PDF is returned directly in the response (not persisted, no token created). See Phase 5.

### Public Endpoint (no authentication required)

**`GET /v1/shared-conversations/{token}`** — Fetch a share

Validates: `is_active = true`, `revoked_at IS NULL`, `expires_at IS NULL OR expires_at > now()`. Returns the full `SharedConversationDetail` from `snapshot_json`, including `sources` — the citation sources frozen at share time (below), re-validated on every read (`http(s)` URLs only, capped lengths; a bad entry is dropped). Anyone with the URL can call this.

**Citation sources in a share (plan 42).** The public view has no session, so it cannot read the conversation's sources later — and it must not see sources the shared part does not cite (other branches, later turns). So when the link is made, `attach_cited_sources` (`utils/shared_conv.py`) collects the source ids the snapshot's `[src:ID]` markers cite (each message's `content` and the text deltas of its `rawEvents`, sub-agent envelopes included), fetches the conversation's sources once with the owner's ids, and stores only the cited ones as `snapshot_json["sources"]`. No marker → no call; the agents service down → the link is still made, without sources, and its markers render nothing. A share made before plan 42 has no `sources` key and returns `[]`.

In the UI, `transformSharedConversationDetail` re-checks each frozen source (`toCitationSources`) and the share page (and a logged-in viewer's workspace view of a `full` share) hands them to `useConversationSources` as the conversation's durable list, merged with the `SOURCES` events of the snapshot's own `rawEvents`. Copy on a shared answer goes through the same `citationsToPlainText` as in the chat: markers become `[1]`, `[2]` and a `Sources:` list (title — URL) closes the text; an id with no source is removed.

### Fork Endpoint (authentication + CSRF required)

**Shared continuation through inference start** — Fork a share into a new conversation and start inference

Only valid for `shareMode = "full"` shares. The active chat path calls `POST /v1/inference/runs/{userId}/start` with `mode: "shared_continue"` and the share token. The bridge creates a new conversation owned by the current user, clones all snapshot messages into it, appends the first continuation user message, creates the AI placeholder/run, and returns `InferenceStartResponse` with the new conversation detail. See Phase 5.

---

## Phase 4 — Snapshot Freeze and Deletion Resilience

The decision to store `snapshot_json` instead of DB foreign-key references is deliberate:

| If this changes after share creation | Effect on share |
| --- | --- |
| Owner edits a message | Share shows original content |
| Owner deletes a message | Share still shows the message |
| Owner deletes the conversation | DB CASCADE deletes the share row, link 404s |
| Owner renames the conversation | Share title unchanged |
| Agent is updated or removed | Share shows agent data at creation time |
| Attachment blob is deleted | Share still embeds the base64 data |
| A cited source is dropped from the conversation | Share keeps the copy frozen in `snapshot_json["sources"]` |

The one case where deletion does cascade is conversation deletion — the `conversation_shares.conversation_id` FK has `CASCADE`, so all share rows for a conversation are deleted when the conversation is removed. A recipient accessing the link after that gets a 404.

---

## Phase 5 — Forking a Share and Starting Inference

Shared continuation uses the same backend-owned inference start endpoint as normal chat. `utils/inference_start.py` handles the `shared_continue` mode and delegates the clone work to `utils/shared_conv.py::create_conversation_from_share_record()`.

```mermaid
flowchart TD
    A[POST /inference/runs/userId/start<br/>mode=shared_continue] --> B[load active share]
    B --> C{shareMode == full?}
    C -->|no| ERR[400 — only full shares are continuable]
    C -->|yes| D[look up agent from snapshot]
    D --> E[create new ConversationTable for current_user]
    E --> F[iterate snapshot messages]
    F --> G[decode base64 attachments]
    G --> H[create MessageTable + AttachmentTable + BlobTable<br/>new UUIDs, relink parent_message_id via id_map]
    H --> I[create initial user reply message]
    I --> J[create AI placeholder (streaming_status='queued')]
    J --> K[commit atomically]
    K --> L[return InferenceStartResponse]
```

**What gets new UUIDs:** conversation, messages, attachments, blobs.

**What is preserved:** message content, sender, type, created/updated timestamps, reasoning steps, thinking time, raw events, plan, subagents, attachment filenames, MIME types, sizes, and binary blob data (deep copied — not shared references).

**Parent remapping:** a `message_id_map` tracks old → new IDs during the clone loop so `parent_message_id` links are correctly rewritten to the new UUIDs.

The original shared conversation is never mutated. After the response, the frontend navigates to the owned copy and observes the returned run through the normal WebSocket endpoint at `/v1/inference/runs/{userId}/{runId}/ws`.

---

## Phase 6 — PDF Export

The PDF renderer (`utils/share_export.py`) is a custom in-house builder — no third-party PDF library.

**What the PDF contains:**

1. **Per-page header:** logo (if present at `utils/assets/logo.png`), export timestamp, page number
2. **Title block:** conversation title, agent name, export timestamp, horizontal rule
3. **Messages:** each rendered with sender label (`YOU` / `ASSISTANT`), timestamp, and Markdown-rendered content
4. **Sources** (plan 42): citation markers print as `[1]`, `[2]` by first appearance, with the cited pages listed at the end

**An answer reads as the chat shows it** (`conversation_turns`): an orchestrator with background tasks answers in several runs, each after a hidden `task_notification` row. The PDF joins consecutive assistant messages into **one** `ASSISTANT` block and draws each notice between them as a quiet line ("Researcher finished · 2m 14s"), never as the user's message. Exporting "this message" (`mode=message`, the id of the answer's last run) takes the whole answer back to the user's question (`_answer_with_question`). An answer's model calls are separate paragraphs: the bridge now joins them with a blank line when it stores the text, and for answers stored before that, the PDF rebuilds the paragraphs from the run's `TEXT_MESSAGE_START` events when they match the stored text exactly. A message's header is kept with its first lines only, so a long first prompt no longer leaves the first page empty.

**Markdown support in PDF:** headings (h1–h6 with scaled sizes), code blocks (dark background, language tag), tables, bullet/task lists, blockquotes, horizontal rules, bold/italic/strikethrough (rendered to plain weight in PDF). Inline links are rendered as plain text.

**Font handling:** `_FontRegistry` loads Unicode-capable TrueType fonts (Windows: `ARIALUNI.TTF`, `Nirmala.ttc`; Linux fallbacks: DejaVu, Liberation, Noto). Fonts are subsetted to used codepoints to keep file size small.

**Page dimensions:** 8.5" × 11" (612 × 792pt), 56pt margins, 512KB chunk streaming.

The export endpoint returns PDF bytes directly in the response with `Content-Disposition: attachment`. Nothing is persisted.

---

## Phase 7 — Conversation Reports

Reports are a lightweight moderation signal, separate from sharing.

**`POST /v1/conversations/{userId}/{conversationId}/report`** (auth + CSRF required):

```json
{
  "reason": "Contains harmful content",
  "details": "Optional extended explanation (max 2000 chars)",
  "messageId": "optional-specific-message-uuid"
}
```

Validation:
- `reason` is required; max 120 chars
- A conversation can only be reported once (409 Conflict if already reported)
- If `messageId` is provided, it must belong to the conversation

Side effects:
- Creates `ConversationReportTable` row with `status = "open"`
- Sets `conversations.is_reported = true` and `conversations.reported_at = now()`

There are no endpoints to list or resolve reports via the public API. Report management is expected to be handled by a backend admin process.

---

## Sharp Edges and Behavioral Notes

- **Conversation deletion removes all its shares.** The `conversation_id` FK has `CASCADE DELETE`, so deleting a conversation immediately invalidates all share links for it. Existing recipients get a 404. There is no grace period.

- **Only `full` shares can be forked.** Attempting inference start with `mode: "shared_continue"` for a `branch` or `message` share returns 400. The share mode is enforced strictly because forking requires a complete, coherent message tree.
- **A share made with a private custom agent cannot be continued.** `create_conversation_from_share_record` accepts the snapshot's agent only if it is a platform agent or the importer's own; otherwise 400 *"This conversation was made with a private agent, so it can't be continued."* Before plan 32 it accepted any active agent, which let the importer run someone else's private agent — and tied their conversation to it, so deleting the owner's account would have cascaded into it.
- **Hidden while the owner's account awaits deletion.** `load_active_share` skips shares whose owner has an open `account_deletions` row: the public link answers 404 during the grace period and comes back unchanged if the deletion is cancelled ([account-deletion](account-deletion.md)).

- **Revocation is permanent.** Setting `is_active = false` cannot be reversed via the API. If a user wants to re-share, they must create a new share with a new token.

- **Multiple active shares per conversation are allowed.** An owner can create a `full` share (for a team member who needs to fork it) and a `message` share (for a public post) from the same conversation simultaneously. Revoking one does not affect the other.

- **`expiresAt` defaults to 30 days.** Shares do not default to never-expiring. If the frontend does not send `expiresAt`, the backend applies a 30-day default. The maximum allowed expiry is 365 days from creation.

- **The snapshot embeds blob data as base64.** For conversations with large attachments, `snapshot_json` can be very large (the base64 overhead is ~33%). A conversation with many multi-MB attachments will produce a snapshot that is proportionally larger.

- **No cross-tab share revocation notification.** If an owner revokes a share while a recipient has the page open, the recipient's already-loaded snapshot continues to display normally. The revocation only affects new fetch requests against the token.

- **Reports have a one-per-conversation limit.** A second report attempt for the same conversation returns 409. There is no mechanism to amend or withdraw a report via the public API.

- **PDF export is transient.** The PDF is generated on every request and never cached. Repeated exports of the same conversation re-run the full render pipeline each time.

---

## File Map

| Concept | File | What to look for |
| --- | --- | --- |
| DB tables (shares + reports) | [magenticx/dialogue_bridge/core/database/models.py](../../magenticx/dialogue_bridge/core/database/models.py) | `ConversationShareTable`, `ConversationReportTable` |
| Public share endpoint | [magenticx/dialogue_bridge/router/shared_conv.py](../../magenticx/dialogue_bridge/router/shared_conv.py) | `getSharedConversation()` |
| Shared inference continuation | [magenticx/dialogue_bridge/utils/inference_start.py](../../magenticx/dialogue_bridge/utils/inference_start.py) | `mode == "shared_continue"` |
| Owner share endpoints | [magenticx/dialogue_bridge/router/conversations.py](../../magenticx/dialogue_bridge/router/conversations.py) | `shareConversation()`, `revokeConversationShare()`, `getConversationShares()`, `exportConversationPdf()` |
| Snapshot builder | [magenticx/dialogue_bridge/utils/conversations.py](../../magenticx/dialogue_bridge/utils/conversations.py) | `build_share_snapshot()`, `build_message_lineage()`, `clone_branch_to_conversation()` |
| Scoped message selection + PDF | [magenticx/dialogue_bridge/utils/share_export.py](../../magenticx/dialogue_bridge/utils/share_export.py) | `select_scoped_messages()`, `render_conversation_pdf()`, `_PdfDocument`, `_FontRegistry` |
| Pydantic schemas | [magenticx/dialogue_bridge/schema/sharing.py](../../magenticx/dialogue_bridge/schema/sharing.py) | `ConversationShareIn`, `ConversationShareResponse`, `SharedConversationDetail` |
| Frontend API calls | [magenticx/agentic_ui/src/shared/lib/api/](../../magenticx/agentic_ui/src/shared/lib/api/) | `shareConversation()`, `revokeSharedConversationLink()`, `getSharedConversation()`, `startInference()`, `downloadConversationPdfExport()` |
| Frontend types | [magenticx/agentic_ui/src/shared/lib/types/](../../magenticx/agentic_ui/src/shared/lib/types/) | `ConversationShareMode`, `ConversationShareResponse`, `SharedConversationDetail` |
| Citation sources on a share (plan 42) | [magenticx/agentic_ui/src/pages/SharedConvPage.tsx](../../magenticx/agentic_ui/src/pages/SharedConvPage.tsx), [features/chat/hooks/useConversationSources.ts](../../magenticx/agentic_ui/src/features/chat/hooks/useConversationSources.ts), [features/chat/lib/citationText.ts](../../magenticx/agentic_ui/src/features/chat/lib/citationText.ts) | `CitationSourcesContext` provider from `detail.sources`; Copy → numbered references |
| Share UI handlers | [magenticx/agentic_ui/src/features/sharing/handlers/share.ts](../../magenticx/agentic_ui/src/features/sharing/handlers/share.ts) | `handleCreateShareLink()`, `handleRevokeSharedConversation()`, `loadSharedConversationPage()` |
