import { integerField, numberField, optionalIntegerField, optionalStringField, textField } from "./fields";
import type { TombstoneRow } from "./tombstone";
import type { BoxRow } from "./boxes";

// Heartbeat request body (box JSON contract, snake_case). The box sends
// {id, seq, box_now, epoch, version[, enroll_token]} with
// `Authorization: Bearer <heartbeat-token>`. Extra fields (notably any
// hostname/URL and enroll_token) are accepted but ignored here: pinned
// hostnames never change via heartbeat (SSRF rule), enrollment is Task 3.
interface HeartbeatBody {
  id: string;
  seq: number;
  box_now: number;
  epoch: number;
  version?: string;
  taps_24h?: number;
}

export interface HeartbeatStore {
  getBox(id: string): BoxRow | undefined;
  putBox(box: BoxRow): void;
  // Tombstone reads (Task 5 revoke). Optional so unit MemStores that only
  // track boxes keep compiling; the real FleetState implements both and
  // heals through the path below.
  getTombstone?(boxId: string): TombstoneRow | undefined;
  deleteTombstone?(boxId: string): void;
}

function parseHeartbeatBody(value: unknown): HeartbeatBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const fields = validHeartbeatFields(value as Record<string, unknown>);
  if (!fields) {
    return null;
  }
  return heartbeatBody(fields);
}

// The body's fields, each by its own rule. Null when a field breaks its
// rule.
function validHeartbeatFields(v: Record<string, unknown>): HeartbeatFields | null {
  const id = textField(v["id"]);
  if (id === null) {
    return null;
  }
  const seq = integerField(v["seq"], 1);
  if (seq === null) {
    return null;
  }
  const boxNow = numberField(v["box_now"], 0);
  if (boxNow === null) {
    return null;
  }
  const epoch = integerField(v["epoch"], 0);
  if (epoch === null) {
    return null;
  }
  const version = optionalStringField(v["version"]);
  if (version === null) {
    return null;
  }
  const taps24h = optionalIntegerField(v["taps_24h"]);
  if (taps24h === null) {
    return null;
  }
  return { id, seq, boxNow, epoch, version, taps24h };
}

// The fields the body carries, once each has passed its rule.
interface HeartbeatFields {
  id: string;
  seq: number;
  boxNow: number;
  epoch: number;
  version?: string;
  taps24h?: number;
}

// The body, from the fields that passed their rules.
function heartbeatBody(fields: HeartbeatFields): HeartbeatBody {
  const body: HeartbeatBody = {
    id: fields.id,
    seq: fields.seq,
    box_now: fields.boxNow,
    epoch: fields.epoch,
  };
  if (fields.version !== undefined) {
    body.version = fields.version;
  }
  if (fields.taps24h !== undefined) {
    body.taps_24h = fields.taps24h;
  }
  return body;
}

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }
  const [scheme, ...rest] = header.split(" ");
  if (scheme.toLowerCase() !== "bearer" || rest.length !== 1 || rest[0].length === 0) {
    return null;
  }
  return rest[0];
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function tokenMatches(provided: string, storedHash: string): Promise<boolean> {
  if (!provided || !storedHash) {
    return false;
  }
  return timingSafeEqual(await hashToken(provided), storedHash);
}

type ReplayVerdict = "ok" | "stale_seq" | "replayed_timestamp";

// Worker-side replay rule: accept only seq greater than stored last_seq and
// box_now greater than the last accepted box timestamp.
function checkReplay(
  row: Pick<BoxRow, "last_seq" | "last_ts">,
  seq: number,
  boxNow: number,
): ReplayVerdict {
  if (seq <= row.last_seq) {
    return "stale_seq";
  }
  if (boxNow <= row.last_ts) {
    return "replayed_timestamp";
  }
  return "ok";
}

function defaultNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// A box that loses its local DB restarts its seq counter at 1 while
// presenting a still-valid token: every heartbeat then 409s as stale_seq
// forever. A stale seq at or below this threshold is treated as a probable
// seq reset — rejected (never accepted), but flagged so the owner can
// re-enroll (which rebinds). Genuine replays of high seqs stay silent.
export const REENROLL_SEQ_THRESHOLD = 10;

// PING_WINDOW_MS: one owner ping per box per condition per window. Both
// heartbeat warnings use it: a wrong-token box and a box that lost its DB
// beat every 30s, and each condition is worth one message, not a stream.
const PING_WINDOW_MS = 15 * 60 * 1000;

// The ledger rule the two guards share: the first ping for a box goes
// out, the next one waits for the window to close.
function withinWindow(
  seen: Map<string, number>,
  id: string,
  nowMs: number,
  windowMs: number,
): boolean {
  const last = seen.get(id);
  if (last !== undefined && nowMs - last < windowMs) {
    return false;
  }
  seen.set(id, nowMs);
  return true;
}

// shouldPingMismatch rate-limits mismatch pings to one per box per window.
// A wrong-token box beats every 30s; without this the owner gets spammed.
export function shouldPingMismatch(
  seen: Map<string, number>,
  id: string,
  nowMs: number,
  windowMs: number = PING_WINDOW_MS,
): boolean {
  return withinWindow(seen, id, nowMs, windowMs);
}

// shouldPingReenroll rate-limits re-enroll pings to one per box per window.
// The ledger is the caller's: a wrong token and a lost DB are different
// facts, and each keeps its own ledger, so neither may hide the other.
export function shouldPingReenroll(
  seen: Map<string, number>,
  id: string,
  nowMs: number,
  windowMs: number = PING_WINDOW_MS,
): boolean {
  return withinWindow(seen, id, nowMs, windowMs);
}

export function reenrollPingText(id: string): string {
  return (
    `seq reset suspected: heartbeat for id="${id}" presented a valid token ` +
    `with a reset-looking seq. The box may have lost its DB — re-enroll it to rebind.`
  );
}

export async function handleHeartbeat(
  request: Request,
  store: HeartbeatStore,
  nowSec: () => number = defaultNowSec,
  // Fired when auth fails for a KNOWN box id (wrong or missing token):
  // the cloned-.env case. Unknown ids stay silent (scanner noise). The id
  // is not a secret; the presented token is never passed on or logged.
  // Contract: must never throw — alerting must not break the auth path.
  onMismatch?: (id: string) => Promise<void> | void,
  // Fired when an AUTHENTICATED heartbeat looks like a post-DB-loss seq
  // reset (stale_seq with a low incoming seq). Same never-throw contract.
  onReenroll?: (id: string) => Promise<void> | void,
): Promise<Response> {
  const body = await readHeartbeatBody(request);
  if (!body) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const row = await authenticatedRow(request, store, body, onMismatch);
  if (!row) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const verdict = checkReplay(row, body.seq, body.box_now);
  if (verdict !== "ok") {
    return replayAnswer(verdict, body.seq, row.id, onReenroll);
  }
  const seen = nowSec();
  store.putBox({ ...row, last_seq: body.seq, last_ts: body.box_now, last_seen: seen, epoch: body.epoch });
  return Response.json({
    id: row.id,
    enrolled: row.enrolled === 1,
    last_seen: seen,
    tainted: taintOf(store, body),
  });
}

// The heartbeat's body, when the request carries one.
async function readHeartbeatBody(request: Request): Promise<HeartbeatBody | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  return parseHeartbeatBody(raw);
}

// The box row, when the box proved who it is. Null when the token does
// not match — or when the box is not known, which stays silent: a
// stranger's id is scanner noise, not a clone.
async function authenticatedRow(
  request: Request,
  store: HeartbeatStore,
  body: HeartbeatBody,
  onMismatch?: (id: string) => Promise<void> | void,
): Promise<BoxRow | null> {
  const candidate = store.getBox(body.id);
  const token = extractBearer(request);
  if (!candidate || !token || !(await tokenMatches(token, candidate.heartbeat_token_hash))) {
    if (candidate) {
      await onMismatch?.(candidate.id);
    }
    return null;
  }
  // Re-read after the async verify so the check-and-write below runs as one
  // synchronous block (no interleaving between check and write).
  return store.getBox(body.id) ?? null;
}

// The answer for a heartbeat that may not be replayed.
//
// A stale seq at or below the threshold is a probable seq reset, but the
// token is valid so this is the real box, not a replay attacker: say so
// explicitly and ping the owner. Never accept (the seq really is stale)
// — re-enrollment rebinds.
async function replayAnswer(
  verdict: ReplayVerdict,
  seq: number,
  boxId: string,
  onReenroll?: (id: string) => Promise<void> | void,
): Promise<Response> {
  if (verdict === "stale_seq" && seq <= REENROLL_SEQ_THRESHOLD) {
    await onReenroll?.(boxId);
    return Response.json({ error: verdict, code: "re_enroll_required" }, { status: 409 });
  }
  return Response.json({ error: verdict }, { status: 409 });
}

// The taint signal (Task 5 revoke): the tombstone epoch is the greatest
// stale epoch (see TombstoneRow in tombstone.ts), so the box is tainted while
// its reported epoch has not rotated past it. A healed epoch clears the
// tombstone here — heartbeat is the only path that observes new epochs.
function taintOf(store: HeartbeatStore, body: HeartbeatBody): boolean {
  const tombstone = store.getTombstone?.(body.id);
  if (tombstone && body.epoch > tombstone.epoch) {
    store.deleteTombstone?.(body.id);
  }
  return tombstone !== undefined && body.epoch <= tombstone.epoch;
}
