import { hashToken, tokenMatches } from "./heartbeat";
import type { BoxRow } from "./state";

// Enrollment request body (box JSON contract, snake_case): a box that wants
// to join (or re-bind after a token change) sends {id, hostname,
// enroll_token}. Unknown id OR known id with a non-matching token pauses as
// pending + Telegram ping; approve binds token→id permanently. Hostname
// pinning happens here at enroll time only — heartbeat can never change it.
export interface EnrollBody {
  id: string;
  hostname: string;
  enroll_token: string;
}

export interface PendingRow {
  id: string;
  hostname: string;
  heartbeat_token_hash: string;
  first_seen: number;
}

export interface EnrollStore {
  getBox(id: string): BoxRow | undefined;
  putBox(box: BoxRow): void;
  getPending(id: string): PendingRow | undefined;
  putPending(row: PendingRow): void;
  deletePending(id: string): void;
}

// Owner ping sink. Contract: never throws, never logs secrets —
// sendTelegramMessage below already swallows transport/API failures.
export type NotifyFn = (text: string) => Promise<void>;

function isPinnedHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) {
    return false;
  }
  if (/\s/.test(value) || value.includes("/") || value.includes("://") || value.includes("@") || value.includes(":")) {
    return false;
  }
  return true;
}

export function parseEnrollBody(value: unknown): EnrollBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v["id"] !== "string" || v["id"].length === 0) {
    return null;
  }
  if (typeof v["hostname"] !== "string" || !isPinnedHostname(v["hostname"])) {
    return null;
  }
  if (typeof v["enroll_token"] !== "string" || v["enroll_token"].length === 0) {
    return null;
  }
  return { id: v["id"], hostname: v["hostname"], enroll_token: v["enroll_token"] };
}

export function parseResolveBody(value: unknown): { id: string } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const id = (value as Record<string, unknown>)["id"];
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  return { id };
}

export function enrollPingText(body: Pick<EnrollBody, "id" | "hostname">): string {
  return (
    `enroll request: id="${body.id}" hostname="${body.hostname}". ` +
    `approve: POST /api/enroll/approve {"id":"${body.id}"}. ` +
    `deny: POST /api/enroll/deny {"id":"${body.id}"}.`
  );
}

export function mismatchAlertText(id: string): string {
  return `auth mismatch: heartbeat for known id="${id}" rejected (token does not match binding).`;
}

// Direct Bot API call. Bot token + owner chat id come from Worker env only
// (see telegramNotifier). Failures log the status code alone — never the URL
// (it embeds the token), body, or chat id.
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  };
  let res: Response;
  try {
    res = await fetcher(`https://api.telegram.org/bot${botToken}/sendMessage`, init);
  } catch {
    console.error("enroll: telegram send failed (network)");
    return false;
  }
  if (!res.ok) {
    console.error(`enroll: telegram send failed (status ${res.status})`);
    return false;
  }
  return true;
}

export function telegramNotifier(
  botToken: string | undefined,
  chatId: string | undefined,
  fetcher: typeof fetch = fetch,
): NotifyFn {
  if (!botToken || !chatId) {
    return async () => {
      console.error("enroll: telegram not configured; ping dropped");
    };
  }
  return async (text: string) => {
    await sendTelegramMessage(botToken, chatId, text, fetcher);
  };
}

function defaultNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export type EnrollStatus = "pending" | "enrolled";

export async function requestEnrollment(
  store: EnrollStore,
  body: EnrollBody,
  notify: NotifyFn,
  nowSec: () => number = defaultNowSec,
): Promise<{ status: EnrollStatus; id: string }> {
  const known = store.getBox(body.id);
  if (known && (await tokenMatches(body.enroll_token, known.heartbeat_token_hash))) {
    return { status: "enrolled", id: body.id };
  }
  store.putPending({
    id: body.id,
    hostname: body.hostname,
    heartbeat_token_hash: await hashToken(body.enroll_token),
    first_seen: nowSec(),
  });
  await notify(enrollPingText(body));
  return { status: "pending", id: body.id };
}

export async function approveEnrollment(store: EnrollStore, id: string): Promise<BoxRow | null> {
  const pending = store.getPending(id);
  if (!pending) {
    return null;
  }
  const known = store.getBox(id);
  const row: BoxRow = known
    ? { ...known, heartbeat_token_hash: pending.heartbeat_token_hash, enrolled: 1 }
    : {
        id: pending.id,
        hostname: pending.hostname,
        heartbeat_token_hash: pending.heartbeat_token_hash,
        admin_token_hash: "",
        epoch: 0,
        last_seq: 0,
        last_ts: 0,
        last_seen: 0,
        enrolled: 1,
      };
  // Synchronous write block: bind + clear pending together, no interleave.
  store.putBox(row);
  store.deletePending(id);
  return row;
}

export function denyEnrollment(store: EnrollStore, id: string): boolean {
  if (!store.getPending(id)) {
    return false;
  }
  store.deletePending(id);
  return true;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function handleEnrollRequest(
  request: Request,
  store: EnrollStore,
  notify: NotifyFn,
  nowSec: () => number = defaultNowSec,
): Promise<Response> {
  const body = parseEnrollBody(await readJson(request));
  if (!body) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await requestEnrollment(store, body, notify, nowSec);
  return Response.json({ status: result.status, id: result.id, enrolled: result.status === "enrolled" });
}

export async function handleEnrollApprove(request: Request, store: EnrollStore): Promise<Response> {
  const body = parseResolveBody(await readJson(request));
  if (!body) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const row = await approveEnrollment(store, body.id);
  if (!row) {
    return Response.json({ error: "no_pending" }, { status: 404 });
  }
  return Response.json({ status: "approved", id: row.id, enrolled: true });
}

export async function handleEnrollDeny(request: Request, store: EnrollStore): Promise<Response> {
  const body = parseResolveBody(await readJson(request));
  if (!body) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (!denyEnrollment(store, body.id)) {
    return Response.json({ error: "no_pending" }, { status: 404 });
  }
  return Response.json({ status: "denied", id: body.id });
}
