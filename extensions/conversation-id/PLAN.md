# Plan: X-Conversation-Id header per session

## Goal
Auto-load an extension that, on every new session, generates a fresh conversation
ID and attaches it as an `X-Conversation-Id` header on all outgoing model/provider
requests for the lifetime of that session.

## Requirements (restated)
- Extension auto-loads (lives in an auto-discovered extensions dir).
- A new conversation ID is generated **per new session**.
- The header `X-Conversation-Id: <id>` is sent on **all** provider requests.
- ID must be stable within a session and survive reloads of the same session.

## Key API facts driving the design
- `pi.registerProvider(name, { headers })` can **override an existing provider**,
  merging custom headers while preserving its models when no `models` are given.
- `registerProvider` calls made **after** startup (e.g. from `session_start`)
  take effect immediately, no `/reload` required.
- Header values resolve at request time and support `$ENV_VAR` / `!command`
  interpolation — but a per-session random value is simplest to inject directly
  as a literal string at registration time.
- `session_start` fires for every session lifecycle: `startup`, `new`, `resume`,
  `fork`, `reload`, with `event.reason` telling us which.
- `pi.appendEntry` / `ctx.sessionManager.getEntries()` lets us persist + restore
  the ID so a resumed/reloaded session keeps the same conversation ID.

## Chosen approach
Use `session_start` + `pi.registerProvider(headers-only override)` to inject the
header onto the active provider(s). Persist the ID with `pi.appendEntry` so the
same session keeps a stable ID across `resume`/`reload`, and mint a new one on
`new`/`fork`.

### Why not `before_provider_request`?
That hook rewrites the JSON **payload** (body), not HTTP transport headers. It is
the wrong layer for an HTTP header. `registerProvider({ headers })` is the
supported header mechanism, so we use that.

## ID lifecycle rules
| session_start reason | behavior |
|----------------------|----------|
| `startup`            | generate new ID (or restore if entry already present) |
| `new`                | generate new ID |
| `fork`               | generate new ID (DECIDED: fork = new conversation) |
| `resume`             | restore persisted ID from session entries |
| `reload`             | restore persisted ID (same session, same ID) |

Restore logic: scan `ctx.sessionManager.getEntries()` for our custom entry
(`customType: "conversation-id"`); if found, reuse `data.id`; otherwise generate
and `pi.appendEntry("conversation-id", { id })`.

ID format: `crypto.randomUUID()` — UUIDv4 (DECIDED). Node built-in, no deps.

A `/conversation-id-set <uuid|any>` command lets a tester pin a static ID for the
current session (overrides generation and persists for resume/reload). A
`/conversation-id-set` with no arg clears the override and regenerates.

## Which providers get the header? (DECIDED)
- **Default target: `openrouter` only.** On `session_start` we apply the header
  override to the `openrouter` provider.
- Users can **opt in additional providers** via a command (`/conversation-id-providers`)
  and/or a settings list. The enabled-provider set is persisted with
  `pi.appendEntry` so it survives reloads.
- The header is keyed by provider name, so we re-apply to each enabled provider
  whenever the ID changes.

## Re-application points
- `session_start` — set/refresh header for every enabled provider (default: openrouter).
- After enabling a new provider via command — apply immediately
  (`registerProvider` after startup takes effect without `/reload`).

## File layout
```
extensions/conversation-id/
  index.ts        # entry point (export default (pi: ExtensionAPI) => {...})
  PLAN.md         # this file
```
No package.json needed (only built-ins: `node:crypto`).

## Implementation outline (no code yet)
1. Module-level state: `currentId`, `enabledProviders: Set<string>` (default `{"openrouter"}`).
2. Helper `applyHeader(pi, providerName, id)`:
   `pi.registerProvider(providerName, { headers: { "X-Conversation-Id": id } })`.
3. Helper `applyAll(pi, id)`: loop `enabledProviders` -> `applyHeader`.
4. `pi.on("session_start", ...)`:
   - restore persisted state (ID, static override, enabled providers) from
     `ctx.sessionManager.getEntries()`.
   - determine ID per lifecycle table (static override wins; else restore vs
     generate + `pi.appendEntry`).
   - set `currentId`; `applyAll(pi, currentId)`.
   - `ctx.ui.setStatus("conversation-id", currentId.slice(0,8))` for visibility.
5. `pi.registerCommand("conversation-id-set", ...)`:
   - with arg: pin static ID, persist, `applyAll`.
   - without arg: clear override, regenerate, persist, `applyAll`.
6. `pi.registerCommand("conversation-id-providers", ...)`:
   - list / add / remove enabled providers; persist; `applyAll` for newly added.
7. `pi.registerCommand("conversation-id", ...)` (optional): print current ID +
   enabled providers.

## Verification plan
- Run pi with the extension; use a debug `before_provider_request` log OR point a
  provider `baseUrl` at a local echo/proxy to confirm the header arrives.
- Confirm: same ID across `/reload` and `/resume`; new ID after `/new` and `/fork`.
- Confirm header present after switching model/provider via `/model`.

## Decisions (resolved)
1. Header applied to **openrouter** by default; command-based opt-in for other providers.
2. ID format: **UUIDv4** via `crypto.randomUUID()`.
3. **Fork gets a new ID.**
4. Static ID for testing via **`/conversation-id-set` command** (persisted per session).
