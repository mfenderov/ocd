import { extractBearer } from "./heartbeat";
import { escapeHtml, type TelegramClient } from "./telegram";

// The box event ingest: POST /api/events → the brain's links and history.
//
// A box pushes three things: a link was used, a link died, an audit row
// happened. The brain answers each in its own way: the first two edit the
// Telegram message the brain owns, the third lands in the brain's history.
//
// Four rules hold here:
//
//   1. The box proves who it is. The bearer is the box's heartbeat token
//      and the body names the box, so the brain checks the token against
//      that box. A console token cannot forge box events.
//
//   2. An event the brain cannot use is ignored, never fatal. A box that
//      pushes an event for a token the brain never handed out (the box's
//      own /login links) must not break the rest of the batch.
//
//   3. An edit happens once. The link is marked edited only when the edit
//      landed, so a failed edit is retried by the next event.
//
//   4. The brain never computes an expiry. The box decides when a link
//      dies and pushes "link-expired"; the brain edits the message then.

// One event a box pushed. A field the box did not send stays undefined:
// a link event carries no audit fields, an audit row carries no link.
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

// One link the brain handed out: the token, the box that minted it and
// the Telegram message that carries it. The brain edits that message when
// the link is spent or dies.
//
// The row carries no expiry: the box decides when a link dies and says
// so (rule 4 above), so the brain never stores an expiry of its own.
export interface LinkRow {
  token: string;
  box_id: string;
  chat_id: number;
  message_id: number;
  state: string;             // "issued" | "used" | "expired"
  created_at: number;
  used_at: number;
  used_ip: string;
  used_ua: string;
  edited: number;            // 1 when the message was edited
}

// One row of the fleet's history, as the box pushed it: the box's audit
// row, the box it came from and the token it belongs to (the dedup key).
export interface AuditRow {
  box: string;
  at: number;
  actor: string;
  action: string;
  device: string;
  ip: string;
  result: string;
  ua: string;
  token: string;
}

// The store the ingest writes to: the Durable Object's own tables.
export interface EventStore {
  linkRow(token: string): LinkRow | undefined;
  putLink(row: LinkRow): void;
  // True when the link is in that state and the edit is still owed: the
  // first report, or a retry after a failed edit.
  markLinkUsed(token: string, ip: string, ua: string, at: number): boolean;
  markLinkExpired(token: string): boolean;
  addAuditRow(row: AuditRow): boolean;   // false when it is a duplicate
}

// What the ingest needs from the outside: the client that carries the
// edits and the box's own check of its heartbeat token.
export interface EventDeps {
  telegram: TelegramClient;
  verifyBox: (id: string, token: string) => Promise<boolean>;
}

// The events the brain knows. An event of another kind is ignored.
const EVENT_TYPES = new Set(["link-used", "link-expired", "audit"]);

// The user agent the brain keeps: the Go store truncates it at 300
// characters (internal/store/links.go), so a box that pushes a huge one
// cannot fill the brain's history.
const UA_MAX = 300;

// The most events one request may carry. A box pushes one event per tap
// and at most a sweep batch of dead links, so the cap never bites in
// practice — it keeps a runaway batch from pinning the brain.
const MAX_EVENTS = 500;

export async function handleEvents(
  request: Request,
  store: EventStore,
  deps: EventDeps,
): Promise<Response> {
  const envelope = readEnvelope(await readJson(request));
  if (!envelope) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  // The box proves who it is before anything is written.
  const bearer = extractBearer(request);
  if (!bearer || !(await deps.verifyBox(envelope.id, bearer))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  for (const raw of envelope.events.slice(0, MAX_EVENTS)) {
    const event = readEvent(raw);
    if (!event) {
      // An event the brain cannot use is ignored; the rest still applies.
      continue;
    }
    await applyEvent(event, envelope.id, store, deps);
  }
  if (envelope.events.length > MAX_EVENTS) {
    console.error(`events: the batch carried ${envelope.events.length} events; ${MAX_EVENTS} were applied`);
  }
  return Response.json({ ok: true });
}

// One event, read defensively: a malformed event never breaks the batch.
function readEvent(raw: unknown): BoxEvent | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const fields = raw as Record<string, unknown>;
  const type = fields["type"];
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) {
    return undefined;
  }
  const event: BoxEvent = { type };
  // The text fields: the box sends what it has, the brain reads what it
  // understands and drops the rest.
  for (const name of ["token", "ip", "actor", "action", "device", "result"] as const) {
    const value = text(fields[name]);
    if (value) {
      event[name] = value;
    }
  }
  const ua = text(fields["ua"]);
  if (ua) {
    event.ua = ua.slice(0, UA_MAX);
  }
  const at = fields["at"];
  if (typeof at === "number" && Number.isFinite(at)) {
    event.at = at;
  }
  return event;
}

// The body the box pushes: the box it speaks for and its events.
function readEnvelope(body: unknown): { id: string; events: unknown[] } | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const fields = body as Record<string, unknown>;
  const id = text(fields["id"]).trim();
  if (!id) {
    return undefined;
  }
  const events = fields["events"];
  if (!Array.isArray(events)) {
    return undefined;
  }
  return { id, events };
}

// One event, applied: the link events change the link and edit the
// message, the audit event lands in the history.
async function applyEvent(
  event: BoxEvent,
  boxId: string,
  store: EventStore,
  deps: EventDeps,
): Promise<void> {
  if (event.type === "link-used") {
    await applyLinkUsed(event, boxId, store, deps);
    return;
  }
  if (event.type === "link-expired") {
    await applyLinkExpired(event, boxId, store, deps);
    return;
  }
  applyAudit(event, boxId, store);
}

// The link was tapped: the link is spent and its message says so.
async function applyLinkUsed(
  event: BoxEvent,
  boxId: string,
  store: EventStore,
  deps: EventDeps,
): Promise<void> {
  const link = knownLink(event.token, boxId, store);
  if (!link) {
    return;
  }
  const at = event.at ?? nowSec();
  if (!store.markLinkUsed(link.token, event.ip ?? "", event.ua ?? "", at)) {
    return;
  }
  await editLink(link, usedText(at, event.ip ?? "", event.ua ?? ""), store, deps);
}

// The link died: the link is dead and its message says so.
async function applyLinkExpired(
  event: BoxEvent,
  boxId: string,
  store: EventStore,
  deps: EventDeps,
): Promise<void> {
  const link = knownLink(event.token, boxId, store);
  if (!link) {
    return;
  }
  if (!store.markLinkExpired(link.token)) {
    return;
  }
  await editLink(link, expiredText(), store, deps);
}

// The audit row: it lands in the brain's history. A row the brain already
// has is not stored twice.
function applyAudit(event: BoxEvent, boxId: string, store: EventStore): void {
  const row = auditRow(event, boxId);
  if (!row) {
    return;
  }
  store.addAuditRow(row);
}

// The row the brain keeps: the box's audit row, the box it came from and
// the token it belongs to. A row without a time or an action cannot be
// keyed, so it is not a row the brain can use.
function auditRow(event: BoxEvent, boxId: string): AuditRow | undefined {
  if (event.at === undefined || !event.action) {
    return undefined;
  }
  return {
    box: boxId,
    at: Math.floor(event.at),
    actor: event.actor ?? "",
    action: event.action,
    device: event.device ?? "",
    ip: event.ip ?? "",
    result: event.result ?? "",
    ua: event.ua ?? "",
    token: event.token ?? "",
  };
}

// The link the event is about: the brain's own link, for that box. A
// token the brain never handed out (the box's own /login links) is not a
// link the brain can edit.
function knownLink(token: string | undefined, boxId: string, store: EventStore): LinkRow | undefined {
  if (!token) {
    return undefined;
  }
  const link = store.linkRow(token);
  if (!link || link.box_id !== boxId) {
    return undefined;
  }
  return link;
}

// The edit of the message the brain owns. The link is marked edited only
// when the edit landed: a failed edit leaves the link unedited, so the
// next event or the next sweep tries again.
async function editLink(
  link: LinkRow,
  text: string,
  store: EventStore,
  deps: EventDeps,
): Promise<void> {
  let landed = false;
  try {
    landed = await deps.telegram.editMessageText(link.chat_id, link.message_id, text);
  } catch (err) {
    console.error(`events: the edit failed (${errorText(err)})`);
    return;
  }
  if (!landed) {
    return;
  }
  const current = store.linkRow(link.token);
  if (current) {
    store.putLink({ ...current, edited: 1 });
  }
}

// The message of a spent link, ported from the Go sweeper
// (internal/tg/tg.go): "✅ <b>Logged in</b> · <time>" with the IP and the
// user agent.
function usedText(at: number, ip: string, ua: string): string {
  let text = `✅ <b>Logged in</b> · ${clock(at)}\n<code>${escapeHtml(ip)}</code>`;
  const agent = ua.trim();
  if (agent !== "") {
    text += `\n<code>${escapeHtml(agent)}</code>`;
  }
  return text;
}

// The message of a dead link, ported from the Go sweeper: "⌛️ <b>Expired</b>
// · never tapped".
function expiredText(): string {
  return "⌛️ <b>Expired</b> · never tapped\n/login for a fresh one";
}

// The time of the tap: the Go's "15:04:05". The Go reads the box's local
// clock; the brain reads UTC.
function clock(at: number): string {
  const when = new Date(at * 1000);
  const hh = String(when.getUTCHours()).padStart(2, "0");
  const mm = String(when.getUTCMinutes()).padStart(2, "0");
  const ss = String(when.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// The brain's clock: Unix seconds, like the DO's other timestamps.
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// A field as text: anything that is not a string is no text.
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The message of a failure, whatever shape it came in.
function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
