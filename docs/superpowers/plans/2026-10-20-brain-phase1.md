# Brain Phase 1 — the brain takes the bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Telegram bot moves out of the Go daemon on the home box and into the Cloudflare Worker, which then owns every fleet message, button and link record.

**Architecture:** The Worker grows a Telegram client, a `POST /tg/webhook` route and a set of command handlers that live in the Durable Object (the DO is already the serialization point for the fleet). The boxes push their events — link used, link expired, audit rows — to `POST /api/events`; the brain edits the message it owns. The home box stops registering the Telegram webhook in the same release that flips the webhook over, because both sides register the same bot and the last writer wins.

**Tech Stack:** TypeScript (Cloudflare Workers + Durable Objects, vitest), Go 1.27 (cobra CLI, net/http), Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-10-20-brain-architecture-design.md` — read it. It carries the protocols, the data model and the phase order. This plan implements Phase 1 only; Phases 2-4 (DNS ownership, the history, home's naming migration, the Mac) are separate plans.

**The plan file is deliberately uncommitted.** The repo's rule is that planning and design documents never get committed. Do not `git add docs/superpowers/`.

## Global Constraints

- Telegram delivery must request `allowed_updates: ["message", "callback_query"]`. The current bot requests only `["message"]`, which is why the inline buttons have never worked.
- The webhook secret is one value: the Worker secret `TELEGRAM_WEBHOOK_SECRET`, sent as Telegram's `secret_token` and verified from the `X-Telegram-Bot-Api-Secret-Token` header. The route path carries no secret.
- The brain drops any update whose chat id is not `TELEGRAM_OWNER_CHAT_ID`, silently, including group messages.
- The event push from a box is best-effort, off the tap's critical path, with a 3 second timeout. A brain outage must never break an already-minted session.
- The brain never computes a link's expiry. The box pushes `link-expired`; the brain acts on it.
- `POST /api/events` is authenticated with the box's heartbeat token and the box id in the body. It is **not** in the CLI scope map — a console token must not be able to forge box events.
- One Durable Object alarm, every 30 seconds, does all the sweeping: prune `seen_updates` and `links`, mark expired links, detect a silent box. A DO alarm is the only scheduler a Worker has.
- The brain's links and seen-updates tables are pruned after 24 hours, matching the box's own link prune.
- Every worker test is `npx vitest run` in `worker/`; every Go test is `go test ./... -count=1`.
- Go changes must be `gofmt` clean and `golangci-lint run ./cmd/... ./internal/...` must report 0 issues.

## Review Focus

Five input classes the spec implies that no task's tests would otherwise cover. Each one gets its test in the task that owns the code.

1. **A retried Telegram update must not mint two links.** Telegram retries a webhook it thinks failed. The brain records `update_id` in `seen_updates` and ignores a repeat. → Task 6.
2. **A dead box must not stall the brain.** `/fleet` must answer even when every box is unreachable; the presence probe gets a 3 second deadline, not the mint relay's 15. → Task 10.
3. **A brain outage must not break an already-minted tap.** The event push happens after the redirect is prepared and its failure is never surfaced to the tapper. → Task 1.
4. **The bot must never answer in a group chat.** The chat-id gate drops group updates silently, before any command runs. → Task 6.
5. **A malformed or oversized event payload must not break the ingest.** The brain validates each event, ignores the ones it cannot use, and still stores the ones it can. → Task 9.

---

## File structure

**Worker (new):**
- `worker/src/telegram.ts` — the Telegram Bot API client (sendMessage, editMessageText, answerCallbackQuery, setWebhook) and the HTML escaping helper.
- `worker/src/bot.ts` — the update routing: parse an update, apply the chat-id gate, dedupe, dispatch to a command, answer a callback.
- `worker/src/botcommands.ts` — the command handlers and the text they build.
- `worker/src/botbuttons.ts` — the inline keyboards and the callback payload encoding.
- `worker/src/events.ts` — the box event ingest: validate, write the links and audit rows, edit the messages.
- `worker/src/liveness.ts` — the presence relay, the status relay and the offline detection.

**Worker (modified):**
- `worker/src/state.ts` — the schema (`links`, `seen_updates`, the `tunnel_id` and `suspected_offline` columns), the store methods, the new DO routes, the alarm handler.
- `worker/src/index.ts` — the edge routes: `/tg/webhook`, `/api/events`, `/api/backends/:id/presence`, `/api/backends/:id/status`.
- `worker/src/boxapi.ts` — the box endpoint paths for presence and status.
- `worker/src/access.ts` — the scope map: the new console routes get scopes, `/api/events` gets none (it authenticates the box itself).

**Go (new):**
- `internal/boxagent/events.go` — the event push client.
- `internal/boxagent/events_test.go`
- `internal/boxadmin/status.go` — the `/_oc/status` handler.

**Go (modified):**
- `internal/pair/pair.go` — push the `link-used` event after the redirect is prepared.
- `internal/store/links.go` — the query for tokens that were never used and are past their TTL.
- `internal/cli/serve.go` — mount `/_oc/status`; sweep the dead links every 30 seconds and push them.
- `internal/boxagent/enroll.go` — carry the tunnel id in the enrolment request.
- `internal/onboard/flow.go` — pass the tunnel id from the tunnel plan into the enrolment.
- `internal/tg/webhook_api.go` — request `callback_query` too.
- `internal/onboard/envload.go` — strip single quotes as well as double quotes.

**CI (modified):**
- `scripts/brain-webhook.sh` — the one explicit step that hands Telegram to the brain.
  Nothing registers the webhook automatically: the Durable Object is alive from the
  brain's first deploy, so a registration inside the release workflow would point
  Telegram at the Worker before the home box had stopped competing.

---

### Task 1: The box pushes its events

**Files:**
- Create: `internal/boxagent/events.go`
- Create: `internal/boxagent/events_test.go`
- Modify: `internal/pair/pair.go`

**Interfaces:**
- Consumes: nothing (the first task).
- Produces:
  ```go
  // Event is one thing a box tells the brain.
  type Event struct {
      Type   string `json:"type"`
      Token  string `json:"token,omitempty"`
      IP     string `json:"ip,omitempty"`
      UA     string `json:"ua,omitempty"`
      At     int64  `json:"at,omitempty"`
      Actor  string `json:"actor,omitempty"`
      Action string `json:"action,omitempty"`
      Device string `json:"device,omitempty"`
      Result string `json:"result,omitempty"`
  }

  // PushEvents sends the box's events to the brain. It returns an error
  // the caller is free to ignore: the push is best effort.
  func PushEvents(ctx context.Context, client *http.Client, brainURL, boxID, token string, events []Event) error
  ```
  The request is `POST <brainURL>/api/events` with `Authorization: Bearer <token>` and body `{"id": "<boxID>", "events": [...]}`.

- [ ] **Step 1: Write the failing test**

  In `internal/boxagent/events_test.go`: a `httptest` server that records the method, path, Authorization header and body. Call
  `boxagent.PushEvents(ctx, srv.Client(), srv.URL, "mac", "hb-secret", []boxagent.Event{{Type: "link-used", Token: "tok-1", IP: "1.2.3.4"}})`.
  Assert: the path is `/api/events`, the method is POST, the Authorization header is `Bearer hb-secret`, and the decoded body has `id == "mac"` and one event of type `link-used` with token `tok-1`.

- [ ] **Step 2: Run the test to verify it fails**

  Run: `go test ./internal/boxagent/ -run TestPushEvents -v`
  Expected: FAIL — `undefined: boxagent.PushEvents`.

- [ ] **Step 3: Implement `PushEvents` in `internal/boxagent/events.go`**

  Signature exactly as in the Interfaces block. JSON-encode `struct { ID string \`json:"id"\`; Events []Event \`json:"events"\` }`. Set `Content-Type: application/json`. Return an error wrapping the HTTP status when the response is not 2xx. Trim a trailing slash from `brainURL` before appending `/api/events`.

- [ ] **Step 4: Run the test to verify it passes**

  Run: `go test ./internal/boxagent/ -run TestPushEvents -v`
  Expected: PASS.

- [ ] **Step 5: Write the failing test for the tap path**

  In `internal/pair/pair_test.go` (extend the existing file): the pair handler is exercised against a fake `opencode` exec and a fake brain server that returns 500. Assert the handler still answers the tap (a redirect, not a 5xx) — the brain being down must not break a tap.

- [ ] **Step 6: Run it to verify it fails**

  Run: `go test ./internal/pair/ -v`
  Expected: FAIL — the handler does not push anything yet, so the assertion that a `link-used` event arrives fails.

- [ ] **Step 7: Push the `link-used` event from the pair handler**

  In `internal/pair/pair.go`: after the token is consumed and the redirect is prepared, push one event of type `link-used` with the token, the client IP and the User-Agent. The push runs in its own goroutine with a 3 second timeout, and its error is logged, never returned. The handler must not wait for it.

- [ ] **Step 8: Run the tests to verify they pass**

  Run: `go test ./internal/pair/ ./internal/boxagent/ -count=1`
  Expected: PASS.

- [ ] **Step 9: Commit**

  ```bash
  git add internal/boxagent/events.go internal/boxagent/events_test.go internal/pair/pair.go internal/pair/pair_test.go
  git commit -m "feat(box): push link events to the brain without blocking the tap"
  ```

---

### Task 2: The box reports its dead links and its service status

**Files:**
- Create: `internal/boxadmin/status.go`
- Create: `internal/boxadmin/status_test.go`
- Modify: `internal/store/links.go`
- Modify: `internal/cli/serve.go`

**Interfaces:**
- Consumes: `boxagent.Event` and `boxagent.PushEvents` from Task 1.
- Produces:
  ```go
  // boxadmin
  // StatusHandler serves the OpenCode service status for the brain.
  func StatusHandler(st *store.Store, exec func(name string, args ...string) (string, error)) http.Handler

  // store
  // ExpiredLinkTokens returns the tokens that were never used and are past
  // their TTL: the brain has to learn that its links died.
  func (s *Store) ExpiredLinkTokens(limit int) ([]string, error)
  ```
  `StatusHandler` answers `text/plain` with the same line `admin.Status` builds. `ExpiredLinkTokens` returns at most `limit` tokens, oldest first, and never returns a token that was used.

- [ ] **Step 1: Write the failing test for the dead links**

  In the store's test file: insert a link token, mark another one used, then assert `ExpiredLinkTokens(10)` returns only the unused one, and that a fresh token is not returned.

- [ ] **Step 2: Run it to verify it fails**

  Run: `go test ./internal/store/ -run TestExpiredLinkTokens -v`
  Expected: FAIL — `undefined` on the method.

- [ ] **Step 3: Implement `ExpiredLinkTokens` in `internal/store/links.go`**

  Query the `link_tokens` table for `used_at IS NULL AND created_at < strftime('%s','now') - <linkTTL seconds>`, ordered by `created_at`, limited by `limit`. Reuse the existing `linkTTL` constant; do not add a second TTL.

- [ ] **Step 4: Run it to verify it passes**

  Run: `go test ./internal/store/ -run TestExpiredLinkTokens -v`
  Expected: PASS.

- [ ] **Step 5: Write the failing test for the status handler**

  In `internal/boxadmin/status_test.go`: a `StatusHandler` with a fake exec that returns `http://127.0.0.1:49374` for `opencode service status`. Assert the response is 200 and the body contains the URL.

- [ ] **Step 6: Run it to verify it fails**

  Run: `go test ./internal/boxadmin/ -run TestStatusHandler -v`
  Expected: FAIL — `undefined: boxadmin.StatusHandler`.

- [ ] **Step 7: Implement `StatusHandler` in `internal/boxadmin/status.go`**

  Signature as in the Interfaces block. Delegate to `admin.Status(st, exec)` and write the result as `text/plain`.

- [ ] **Step 8: Mount it and sweep the dead links in `internal/cli/serve.go`**

  Mount `/_oc/status` next to the other `/_oc/*` routes, behind the same Bearer auth. Add a 30 second ticker that calls `store.ExpiredLinkTokens(50)` and pushes one `link-expired` event per token to the brain. The sweep runs in the background and never blocks the daemon.

- [ ] **Step 9: Run the tests to verify they pass**

  Run: `go test ./internal/store/ ./internal/boxadmin/ ./internal/cli/ -count=1`
  Expected: PASS.

- [ ] **Step 10: Commit**

  ```bash
  git add internal/boxadmin/status.go internal/boxadmin/status_test.go internal/store/links.go internal/cli/serve.go
  git commit -m "feat(box): report the OpenCode status and the links that died"
  ```

---

### Task 3: The enrolment carries the tunnel id

**Files:**
- Modify: `internal/boxagent/enroll.go`
- Modify: `internal/onboard/flow.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```go
  // boxagent
  type EnrollOptions struct {
      Quiet    bool
      Bearer   string
      TunnelID string   // the box's cloudflared tunnel id, empty when it has none
  }
  ```
  The request body gains `"tunnel_id": "<id>"` (omitted when empty).

- [ ] **Step 1: Write the failing test**

  In `internal/boxagent/enroll_test.go`: call `boxagent.EnrollBox` with `EnrollOptions{TunnelID: "tun-123"}` against a server that captures the body. Assert the decoded body has `tunnel_id == "tun-123"`. Add a second case: with `TunnelID` empty, the body must not carry the key at all.

- [ ] **Step 2: Run it to verify it fails**

  Run: `go test ./internal/boxagent/ -run TestEnrollPostsTunnelID -v`
  Expected: FAIL — `tunnel_id` is not in the body.

- [ ] **Step 3: Add the field to the request**

  In `internal/boxagent/enroll.go`: add `TunnelID` to `EnrollOptions` and `tunnel_id` to the request struct with `json:"tunnel_id,omitempty"`. Pass `EnrollOptions.TunnelID` into the request struct.

- [ ] **Step 4: Run it to verify it passes**

  Run: `go test ./internal/boxagent/ -count=1`
  Expected: PASS.

- [ ] **Step 5: Write the failing test for the onboarding wiring**

  In `internal/onboard/onboard_test.go`: a `Config` with a `TunnelPlan` whose setup yields a known tunnel id, and a fake Worker that captures the enrolment body. Assert the body's `tunnel_id` is that id.

- [ ] **Step 6: Run it to verify it fails**

  Run: `go test ./internal/onboard/ -run TestOnboardSendsTunnelID -v`
  Expected: FAIL — the enrolment body has no `tunnel_id`.

- [ ] **Step 7: Pass the tunnel id through `internal/onboard/flow.go`**

  `SetupTunnel` already returns the tunnel id. Capture it in `DoOnboard` and set `EnrollOptions{TunnelID: id}` on the `boxagent.EnrollBox` call. When there is no tunnel plan, the id is empty.

- [ ] **Step 8: Run the tests to verify they pass**

  Run: `go test ./internal/onboard/ ./internal/boxagent/ -count=1`
  Expected: PASS.

- [ ] **Step 9: Commit**

  ```bash
  git add internal/boxagent/enroll.go internal/boxagent/enroll_test.go internal/onboard/flow.go internal/onboard/onboard_test.go
  git commit -m "feat(box): tell the brain which tunnel this box uses"
  ```

---

### Task 4: Two one-line fixes in the Go half

**Files:**
- Modify: `internal/tg/webhook_api.go`
- Modify: `internal/onboard/envload.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `LoadEnvFile` strips single quotes as well as double quotes, so a value written `KEY='value'` reads as `value`.

- [ ] **Step 1: Write the failing test**

  In `internal/onboard/onboard_test.go`: write an env file containing `OCD_TG_TOKEN='123:abc'` and assert `LoadEnvFile` returns `123:abc` — not `'123:abc'`.

- [ ] **Step 2: Run it to verify it fails**

  Run: `go test ./internal/onboard/ -run TestLoadEnvFile -v`
  Expected: FAIL — the value keeps its single quotes.

- [ ] **Step 3: Fix the loader**

  In `internal/onboard/envload.go`: after `strconv.Unquote` fails, strip one layer of matching single quotes. A value that is neither quoted form stays as it is.

- [ ] **Step 4: Run it to verify it passes**

  Run: `go test ./internal/onboard/ -count=1`
  Expected: PASS.

- [ ] **Step 5: Fix `allowed_updates`**

  In `internal/tg/webhook_api.go`: `"allowed_updates": []string{"message", "callback_query"}`.

- [ ] **Step 6: Run the whole Go suite**

  Run: `go test ./... -count=1`
  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add internal/onboard/envload.go internal/onboard/onboard_test.go internal/tg/webhook_api.go
  git commit -m "fix: the webhook must ask for callback queries, and the env loader must read single quotes"
  ```

---

### Task 5: The Worker's Telegram client

**Files:**
- Create: `worker/src/telegram.ts`
- Create: `worker/test/telegram.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface TelegramClient {
    sendMessage(chatId: number, text: string, opts?: { replyMarkup?: unknown }): Promise<{ message_id: number }>;
    editMessageText(chatId: number, messageId: number, text: string): Promise<boolean>;
    answerCallbackQuery(callbackId: string, text?: string): Promise<void>;
    setWebhook(url: string, secret: string): Promise<void>;
  }
  export function createTelegramClient(token: string, fetcher?: typeof fetch): TelegramClient;
  export function escapeHtml(raw: string): string;
  ```
  `createTelegramClient` calls `https://api.telegram.org/bot<token>/<method>`. Every method rejects when the API answers `{"ok": false}`.

- [ ] **Step 1: Write the failing test**

  In `worker/test/telegram.test.ts`: a fake fetcher that records the URL and returns `{"ok":true,"result":{"message_id":42}}`. Assert `sendMessage(7, "hi")` posts to `/botTOKEN/sendMessage` with `chat_id` 7 and the text, and resolves to `{message_id: 42}`. Assert a response of `{"ok":false,"description":"nope"}` rejects.

- [ ] **Step 2: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/telegram.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `worker/src/telegram.ts`**

  Signatures as in the Interfaces block. `escapeHtml` replaces `&`, `<` and `>` with their entities — the same three the Go `esc` helper handles, because the brain's messages are HTML-parse-mode like the Go bot's.

- [ ] **Step 4: Run it to verify it passes**

  Run: `cd worker && npx vitest run test/telegram.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add worker/src/telegram.ts worker/test/telegram.test.ts
  git commit -m "feat(worker): a Telegram client for the brain"
  ```

---

### Task 6: The brain's webhook route, the gate and the dedup

**Files:**
- Create: `worker/src/bot.ts`
- Create: `worker/test/bot.test.ts`
- Modify: `worker/src/state.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Consumes: `TelegramClient` from Task 5.
- Produces:
  ```ts
  // bot.ts
  export interface BotUpdate {
    update_id: number;
    message?: { text?: string; chat?: { id?: number; type?: string }; from?: { id?: number } };
    callback_query?: { id?: string; data?: string; message?: { chat?: { id?: number }; message_id?: number } };
  }
  export interface BotStore {
    seenUpdate(updateId: number): boolean;      // false when it was already handled
    markUpdateSeen(updateId: number, at: number): void;
  }
  export function handleTelegramUpdate(update: BotUpdate, deps: {
    telegram: TelegramClient;
    store: BotStore;
    ownerChatId: number;
    dispatch: (cmd: BotCommand) => Promise<void>;
  }): Promise<void>;

  export interface BotCommand {
    name: string;         // "/fleet", "/flink", ...
    args: string[];
    chatId: number;
    messageId?: number;
    callbackId?: string;
  }
  ```
  `state.ts` gains the `seen_updates` table and the two store methods above, and a `/tg` DO route that calls `handleTelegramUpdate`.

- [ ] **Step 1: Write the failing test for the gate**

  In `worker/test/bot.test.ts`: an update whose `message.chat.id` is 999 while the owner chat is 7. Assert the dispatch function is never called.

- [ ] **Step 2: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/bot.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the gate and the dedup in `worker/src/bot.ts`**

  Signatures as in the Interfaces block. Order inside `handleTelegramUpdate`: the chat-id check first (silently return), then the dedup (`store.seenUpdate` — if it returns false the update was already handled, return), then `markUpdateSeen`, then dispatch. A callback query carries its own chat: use `callback_query.message.chat.id`, and fall back to the message's chat id.

- [ ] **Step 4: Run it to verify it passes**

  Run: `cd worker && npx vitest run test/bot.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write the failing test for the retry**

  In the same file: the same `update_id` twice. Assert the dispatch function is called exactly once. This is Review Focus item 1.

- [ ] **Step 6: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/bot.test.ts`
  Expected: FAIL — the dispatch runs twice.

- [ ] **Step 7: Implement the dedup**

  `state.ts`: add the `seen_updates` table to the schema and the two store methods. `seenUpdate` returns false when the row exists; `markUpdateSeen` inserts it. Prune rows older than 24 hours in the alarm (Task 10).

- [ ] **Step 8: Wire the route**

  `index.ts`: forward `POST /tg/webhook` to the DO's `/tg` path. `state.ts`: in the DO's fetch, handle `POST /tg` by reading the JSON body, checking `X-Telegram-Bot-Api-Secret-Token` against the `TELEGRAM_WEBHOOK_SECRET` env value (401 on a mismatch, 400 on a bad body), and calling `handleTelegramUpdate`.

- [ ] **Step 9: Run the tests to verify they pass**

  Run: `cd worker && npx vitest run && npx tsc --noEmit`
  Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

  ```bash
  git add worker/src/bot.ts worker/test/bot.test.ts worker/src/state.ts worker/src/index.ts
  git commit -m "feat(worker): the brain answers Telegram, owner chat only, once per update"
  ```

---

### Task 7: The commands

**Files:**
- Create: `worker/src/botcommands.ts`
- Create: `worker/test/botcommands.test.ts`

**Interfaces:**
- Consumes: `BotCommand` from Task 6, `TelegramClient` from Task 5.
- Produces:
  ```ts
  // botcommands.ts
  // AuditRow is one row of the brain's history. The shape matches the Go
  // client's AuditRow so the bot's text and the console's text agree.
  export interface AuditRow {
    box: string;
    at: number;
    actor: string;
    action: string;
    device: string;
    ip: string;
    result: string;
    ua: string;
    tainted: boolean;
    error?: string;
  }
  export interface CommandDeps {
    telegram: TelegramClient;
    listBoxes: () => BoxPublic[];
    mintLink: (boxId: string) => Promise<string>;   // the tap URL
    audit: (boxId: string, limit: number) => Promise<AuditRow[]>;
    revoke: (boxId: string) => Promise<RevokeResult>;
    revokeAll: () => Promise<RevokeResult[]>;
    issueEnrollCode: (boxId: string) => Promise<{ code: string; command: string }>;
    boxStatus: (boxId: string) => Promise<string>;
    primaryBox: string;
  }
  export async function runCommand(cmd: BotCommand, deps: CommandDeps): Promise<void>;
  ```
  `RevokeResult` is the interface `worker/src/revoke.ts` already exports; `BoxPublic` is the one `worker/src/state.ts` already exports. The command set is exactly: `/fleet`, `/link`, `/flink <box>`, `/login`, `/faudit [box]`, `/frevoke <box> YES`, `/fnuke YES`, `/enrollcode <box>`, `/status`.

- [ ] **Step 1: Write the failing test for `/fleet`**

  In `worker/test/botcommands.test.ts`: two boxes, one online and one stale. Assert the reply text names both boxes and says which one is offline.

- [ ] **Step 2: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/botcommands.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `/fleet` and `/link`**

  Signatures as in the Interfaces block. `/fleet` lists every enrolled box with its state (online when `now - last_seen < 90`, offline otherwise, tombstoned when the tombstone covers it) and its age. `/link` replies with the plain box list for now — Task 8 replaces it with the button menu. A task that ships a half-built menu cannot be reviewed on its own, so `/link` is deliberately plain text here and the buttons land in one piece in Task 8.

- [ ] **Step 4: Run it to verify it passes**

  Run: `cd worker && npx vitest run test/botcommands.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write the failing tests for the rest**

  In the same file, one test each:
  - `/flink mac` calls `mintLink("mac")` and replies with the URL.
  - `/login` mints for `deps.primaryBox`.
  - `/faudit` calls `audit("", 10)` and lists the rows.
  - `/frevoke mac YES` calls `revoke("mac")` and reports the outcome.
  - `/fnuke YES` calls `revokeAll()` and reports how many were revoked and how many blocked.
  - `/enrollcode mac` calls `issueEnrollCode("mac")` and replies with the paste-ready command.
  - `/status` calls `boxStatus(deps.primaryBox)` and replies with the text.
  - An unknown command is ignored (no reply at all).

- [ ] **Step 6: Run them to verify they fail**

  Run: `cd worker && npx vitest run test/botcommands.test.ts`
  Expected: FAIL — the commands are not implemented.

- [ ] **Step 7: Implement the remaining commands**

  Same file, same signature. The text of each reply is the Go bot's text, ported: `internal/tg/fleet.go` (`FleetStatusText`, `FleetLinkText`, `FleetAuditText`, `FleetRevokeText`, `FleetNukeText`, `FleetEnrollCodeText`) and `internal/tg/tg.go` (`/status`). The Go source is the text of record — port the wording, do not invent new copy.

- [ ] **Step 8: Run the tests to verify they pass**

  Run: `cd worker && npx vitest run test/botcommands.test.ts`
  Expected: PASS.

- [ ] **Step 9: Commit**

  ```bash
  git add worker/src/botcommands.ts worker/test/botcommands.test.ts
  git commit -m "feat(worker): the brain answers the fleet commands"
  ```

---

### Task 8: The buttons

**Files:**
- Create: `worker/src/botbuttons.ts`
- Create: `worker/test/botbuttons.test.ts`
- Modify: `worker/src/botcommands.ts`

**Interfaces:**
- Consumes: `CommandDeps` from Task 7.
- Produces:
  ```ts
  // botbuttons.ts
  export interface InlineButton { text: string; callback_data: string; }
  // The board takes the clock it is given: one `now` for the board and
  // its text, so the label and the text cannot disagree at the 90s edge.
  export function fleetBoard(boxes: BoxPublic[], now: number): InlineButton[][];
  export function linkMenu(boxes: BoxPublic[], now: number): InlineButton[][];
  export function parseCallback(data: string): { action: string; boxId: string } | null;
  ```
  The callback data is `"<action>:<boxId>"` with the actions `link`, `revoke`, `audit`, `board`.

- [ ] **Step 1: Write the failing test**

  In `worker/test/botbuttons.test.ts`: three boxes, one offline. Assert `fleetBoard` produces one button per box, that the offline one is marked in its label, and that `parseCallback("link:mac")` returns `{action: "link", boxId: "mac"}`.

- [ ] **Step 2: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/botbuttons.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `worker/src/botbuttons.ts`**

  Signatures as in the Interfaces block. The labels and the layout are ported from `internal/tg/buttons.go`.

- [ ] **Step 4: Run it to verify it passes**

  Run: `cd worker && npx vitest run test/botbuttons.test.ts`
  Expected: PASS.

- [ ] **Step 5: Wire the buttons into the commands**

  In `worker/src/botcommands.ts`: `/fleet` replies with `fleetBoard` as the keyboard; `/link` replies with `linkMenu`. A callback query with action `link` mints for that box and replies with the "Open" button; `board` re-sends the fleet board; `revoke` and `audit` run their commands for that box. The bot answers every callback with `answerCallbackQuery` so the button never spins.

- [ ] **Step 6: Write the failing test for the callback**

  In `worker/test/botcommands.test.ts`: a callback with `link:mac` asserts `mintLink` was called with `mac` and that `answerCallbackQuery` was called with the callback id.

- [ ] **Step 7: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/botcommands.test.ts`
  Expected: FAIL — the callback is not handled.

- [ ] **Step 8: Implement the callback handling**

  Same file. The callback path is the same `runCommand` entry point with the action mapped to a command.

- [ ] **Step 9: Run the tests to verify they pass**

  Run: `cd worker && npx vitest run`
  Expected: PASS.

- [ ] **Step 10: Commit**

  ```bash
  git add worker/src/botbuttons.ts worker/test/botbuttons.test.ts worker/src/botcommands.ts
  git commit -m "feat(worker): the fleet board and the link menu, with working buttons"
  ```

---

### Task 9: The links, the event ingest and the message edits

**Files:**
- Create: `worker/src/events.ts`
- Create: `worker/test/events.test.ts`
- Modify: `worker/src/state.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Consumes: `TelegramClient` from Task 5.
- Produces:
  ```ts
  // events.ts
  export interface BoxEvent {
    type: string;              // "link-used" | "link-expired" | "audit"
    token?: string;
    ip?: string;
    ua?: string;
    at?: number;
    actor?: string;
    action?: string;
    device?: string;
    result?: string;
  }
  export interface EventStore {
    linkRow(token: string): LinkRow | undefined;
    putLink(row: LinkRow): void;
    markLinkUsed(token: string, ip: string, ua: string, at: number): boolean;
    markLinkExpired(token: string): boolean;
    addAuditRow(row: AuditRow): boolean;   // false when it is a duplicate
  }
  export async function handleEvents(request: Request, store: EventStore, deps: {
    telegram: TelegramClient;
    verifyBox: (id: string, token: string) => Promise<boolean>;
  }): Promise<Response>;
  ```
  `LinkRow` is `{token, box_id, chat_id, message_id, state, created_at, expires_at, used_at, used_ip, used_ua, edited}`.

- [ ] **Step 1: Write the failing test for the auth**

  In `worker/test/events.test.ts`: a request whose bearer token does not match the box id's token. Assert the response is 401 and nothing was written.

- [ ] **Step 2: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/events.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the ingest**

  Signatures as in the Interfaces block. The body is `{"id": "<box>", "events": [...]}`. Verify the bearer against the box's heartbeat token before anything else. Process each event in turn; an event that does not match a known type or a known link is ignored, and the rest still apply. This is Review Focus item 5.

- [ ] **Step 4: Run it to verify it passes**

  Run: `cd worker && npx vitest run test/events.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write the failing test for the edits**

  In the same file: a `link-used` event for a link the brain knows, with a chat id and a message id. Assert `editMessageText` was called with the chat id, the message id, and text containing `✅` and the IP. Then a `link-expired` event asserts the text contains `⌛️`.

- [ ] **Step 6: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/events.test.ts`
  Expected: FAIL — no edit happens.

- [ ] **Step 7: Implement the edits**

  Same file. The text is ported from the Go sweeper in `internal/tg/tg.go` (`✅ <b>Logged in</b> · <time>` with the IP and the user agent, `⌛️ <b>Expired</b> · never tapped`). The brain marks the link edited only when the edit succeeded, so a failed edit is retried by the next sweep.

- [ ] **Step 8: Write the failing test for the duplicate**

  In the same file: the same `link-used` event twice. Assert `editMessageText` was called once. Then the same audit row twice: assert the audit table holds one row.

- [ ] **Step 9: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/events.test.ts`
  Expected: FAIL — the events are applied twice.

- [ ] **Step 10: Implement the idempotency**

  Same file. `markLinkUsed` and `markLinkExpired` return false when the link is already in that state, and the edit happens only when they return true. `addAuditRow` keys on box + at + action + token.

- [ ] **Step 11: Wire the schema and the route**

  `state.ts`: add the `links` table and its store methods. `index.ts`: forward `POST /api/events` to the DO's `/events` path. The path is **not** added to the scope map in `access.ts` — the box authenticates itself.

- [ ] **Step 12: Run the tests to verify they pass**

  Run: `cd worker && npx vitest run && npx tsc --noEmit`
  Expected: PASS, no type errors.

- [ ] **Step 13: Commit**

  ```bash
  git add worker/src/events.ts worker/test/events.test.ts worker/src/state.ts worker/src/index.ts
  git commit -m "feat(worker): the brain owns the links and edits the messages it handed out"
  ```

---

### Task 10: The presence and status relays, the offline detection and the alarm

**Files:**
- Create: `worker/src/liveness.ts`
- Create: `worker/test/liveness.test.ts`
- Modify: `worker/src/boxapi.ts`
- Modify: `worker/src/state.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Consumes: `TelegramClient` from Task 5.
- Produces:
  ```ts
  // liveness.ts
  export interface LivenessStore {
    listBoxes(): BoxPublic[];
    markSuspectedOffline(boxId: string): void;
    clearSuspectedOffline(boxId: string): boolean;  // true when it was set
    isSuspectedOffline(boxId: string): boolean;
  }
  export async function sweepLiveness(store: LivenessStore, deps: {
    telegram: TelegramClient;
    probePresence: (boxId: string) => Promise<boolean>;  // true = the box answered
    nowSec: () => number;
    offlineAfterSec: number;   // 90
  }): Promise<void>;
  ```
  `worker/src/boxapi.ts` gains `presence` and `status` paths. The presence relay's deadline is **3 seconds** — the mint relay's 15 is far too long to hold a request open on a dead box.

- [ ] **Step 1: Write the failing test**

  In `worker/test/liveness.test.ts`: one box whose `last_seen` is 200 seconds old, with `probePresence` returning false. Assert one message was sent naming that box. Sweep again: assert no second message.

- [ ] **Step 2: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/liveness.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the sweep**

  Signatures as in the Interfaces block. For each box: silent when it heartbeated within `offlineAfterSec`. Otherwise probe; when the probe fails, mark it suspected-offline (once) and send the message. When the probe succeeds, clear the flag and, if it was set, send the recovery message — once.

- [ ] **Step 4: Run it to verify it passes**

  Run: `cd worker && npx vitest run test/liveness.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write the failing test for the recovery**

  In the same file: a box marked suspected-offline that answers the probe. Assert one recovery message, and that a second sweep sends nothing more.

- [ ] **Step 6: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/liveness.test.ts`
  Expected: FAIL — no recovery message.

- [ ] **Step 7: Implement the recovery**

  Same file.

- [ ] **Step 8: Add the routes and the alarm**

  `boxapi.ts`: add `presence` and `status`. `state.ts`: add the DO routes for `/presence/<box>` and `/status/<box>` (relaying to the box with the sealed admin token and a 3 second deadline), the `suspected_offline` column on `boxes`, the alarm handler, and the alarm-driven sweep of the links, the `seen_updates` prune and the liveness sweep. `index.ts`: forward the two new console routes to the DO. The console routes need an `audit` scope, like the other read routes.

- [ ] **Step 9: Write the failing test for the alarm**

  In `worker/test/liveness.test.ts`: call the alarm handler twice and assert the sweep ran twice and the prune ran.

- [ ] **Step 10: Run it to verify it fails**

  Run: `cd worker && npx vitest run test/liveness.test.ts`
  Expected: FAIL — the alarm does nothing yet.

- [ ] **Step 11: Implement the alarm**

  Same file. `state.ts`'s `alarm()` calls the sweep, prunes `seen_updates` and `links` older than 24 hours, and re-arms itself for 30 seconds later.

- [ ] **Step 12: Run the tests to verify they pass**

  Run: `cd worker && npx vitest run && npx tsc --noEmit`
  Expected: PASS, no type errors.

- [ ] **Step 13: Commit**

  ```bash
  git add worker/src/liveness.ts worker/test/liveness.test.ts worker/src/boxapi.ts worker/src/state.ts worker/src/index.ts
  git commit -m "feat(worker): the brain notices a silent box, once, and probes it directly"
  ```

---

### Task 11: The cutover script

**Files:**
- Create: `scripts/brain-webhook.sh`

**Interfaces:**
- Consumes: `TELEGRAM_BOT_TOKEN` (from the operator's environment) and `TELEGRAM_WEBHOOK_SECRET` (the Worker's secret).
- Produces: Telegram's webhook points at the Worker's `/tg/webhook`, with `allowed_updates: ["message","callback_query"]`.

**Nothing registers the webhook automatically.** The DO is alive from the brain's first deploy — the boxes heartbeat every 30 seconds — so an automatic registration (a release step, an alarm) would point Telegram at the Worker *before* the home box has stopped competing, and the box would take the webhook back on its next restart. The registration is one explicit, deliberate step.

- [ ] **Step 1: Write the script**

  `scripts/brain-webhook.sh` takes the Worker's public URL and the webhook secret from the environment and posts to Telegram:

  ```bash
  curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -H 'Content-Type: application/json' \
    -d "{\"url\":\"${BRAIN_URL}/tg/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
  ```

  It must fail loudly when Telegram answers `{"ok":false}` — a webhook that was not registered is a silent outage. Exit non-zero in that case.

- [ ] **Step 2: Verify the script parses**

  Run: `bash -n scripts/brain-webhook.sh`
  Expected: no output, exit 0.

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/brain-webhook.sh
  git commit -m "feat: the cutover script that hands Telegram to the brain"
  ```

---

### Task 12: The flip

**Files:**
- Modify (outside the repo): `~/.ocd/env`
- Modify (outside the repo): the running `ocd-serve.service`

**Interfaces:**
- Consumes: everything above.
- Produces: Telegram's webhook points at the Worker.

- [ ] **Step 0: Merge and release the branch**

  ```bash
  git checkout master && git merge --ff-only feature/brain-phase1
  git push origin master
  ```

  Wait for the release workflow to go green: it builds the archives, tags, deploys the Worker and verifies the downloads. The Worker must be live before Step 1.

  Then set the brain's webhook secret (the Worker needs it to verify every update, and the cutover script needs the same value):

  ```bash
  cd worker && npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
  ```

  Use a hex secret, for example the output of `openssl rand -hex 32`. Keep it: Step 3 needs the same value.

- [ ] **Step 1: Verify the brain answers before the flip**

  Post a fake update to the Worker's webhook and confirm the bot's reply arrives in Telegram. The Worker must not be serving traffic yet, so this is the only way to test it before the flip.

  Two more checks, because both fail silently:

  - **The home box's sealed admin token.** Every brain-side relay to a box uses it (the mint relay, the status relay, the presence probe, the audit fan-out). A box enrolled before that feature has none, and every relay to it fails with `misconfigured` — so `/link` would answer "Link failed" and the liveness sweep would never call the box dead. Check it: `POST /api/backends/home/presence` through the console, or a `GET /_oc/presence` on the box with the sealed token from `~/.ocd/env`. It must answer 200.
  - **`PRIMARY_BOX` must equal the home box's enrolled id** (the default is `home`). A mismatch makes `/login` and `/status` fail loudly — but only after the webhook is handed over.

- [ ] **Step 2: Stop the home box from competing**

  In `~/.ocd/env`, remove `OCD_TG_TOKEN`, `OCD_OWNER_ID`, `OCD_WEBHOOK_BASE` and `OCD_GROUP_ID` — all four, in one edit. Keep every other key. The file stays `chmod 600`.

  Then run: `systemctl --user restart ocd-serve.service`
  Expected: the service is active, and its log says `telegram off` — the box no longer registers a webhook.

  **All four keys, in one edit.** `internal/cli/serve.go` refuses to start when exactly one of `OCD_TG_TOKEN` and `OCD_OWNER_ID` is set, and the failure mode is "the whole box is dead", not "the bot is off".

  This step comes before the brain takes over, not after. While the box still holds the keys it re-registers the webhook on every `ocd serve` start, and Telegram keeps one webhook per bot — last writer wins. A restart in that window silently points Telegram back at the box and the brain goes quiet with no error on either side.

- [ ] **Step 3: Hand Telegram to the brain**

  Run `scripts/brain-webhook.sh` with `BRAIN_URL` set to the Worker's public origin, `TELEGRAM_BOT_TOKEN` set to the token you saved in Step 1, and `TELEGRAM_WEBHOOK_SECRET` set to the Worker's secret. Telegram now points at the Worker and the brain answers.

- [ ] **Step 4: Verify in Telegram**

  Send `/fleet` to the bot. Expect the fleet board with both boxes. Tap a box, expect a link, tap the link, expect the "✅ Logged in" edit.

- [ ] **Step 5: Verify a box restart does not steal the webhook back**

  Run: `systemctl --user restart ocd-serve.service`, then send `/fleet` to the bot again. The reply must come from the brain. This is the failure the phase was ordered around: the box registers on every start, so the keys have to be gone before it can compete again.

- [ ] **Step 6: Nothing — the release happened first**

  The Worker has to be deployed before the cutover: Step 1 posts a real update to it. The release therefore happens **before** this task: merge the branch into master, push, and let the release workflow build, tag and deploy. It does **not** register the webhook — an automatic registration would flip the bot on every release, before the box has stopped competing.

  The rollback, if the cutover goes wrong: put the four Telegram keys back into `~/.ocd/env`, restart `ocd serve` on home, and the box registers a fresh webhook and takes the bot back. The Go half is still in the tree for exactly that.

