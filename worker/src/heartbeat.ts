import type { TombstoneRow } from "./mint";
import type { BoxRow } from "./state";

// Heartbeat request body (box JSON contract, snake_case). The box sends
// {id, seq, box_now, epoch, version[, enroll_token]} with
// `Authorization: Bearer <heartbeat-token>`. Extra fields (notably any
// hostname/URL and enroll_token) are accepted but ignored here: pinned
// hostnames never change via heartbeat (SSRF rule), enrollment is Task 3.
export interface HeartbeatBody {
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

export function parseHeartbeatBody(value: unknown): HeartbeatBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v["id"] !== "string" || v["id"].length === 0) {
    return null;
  }
  if (!Number.isInteger(v["seq"]) || (v["seq"] as number) < 1) {
    return null;
  }
  if (typeof v["box_now"] !== "number" || !(v["box_now"] as number > 0)) {
    return null;
  }
  if (!Number.isInteger(v["epoch"]) || (v["epoch"] as number) < 0) {
    return null;
  }
  if (v["version"] !== undefined && typeof v["version"] !== "string") {
    return null;
  }
  if (v["taps_24h"] !== undefined && !Number.isInteger(v["taps_24h"])) {
    return null;
  }
  const body: HeartbeatBody = {
    id: v["id"] as string,
    seq: v["seq"] as number,
    box_now: v["box_now"] as number,
    epoch: v["epoch"] as number,
  };
  if (typeof v["version"] === "string") {
    body.version = v["version"];
  }
  if (Number.isInteger(v["taps_24h"])) {
    body.taps_24h = v["taps_24h"] as number;
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

export type ReplayVerdict = "ok" | "stale_seq" | "replayed_timestamp";

// Worker-side replay rule: accept only seq greater than stored last_seq and
// box_now greater than the last accepted box timestamp.
export function checkReplay(
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

// Pinned-host registry: box id -> enrolled-time hostname. Build from
// listBackends()/listBoxes() rows; every future outbound box call must
// resolve through this, never through heartbeat-supplied URLs (SSRF rule).
export function pinnedRegistry(rows: Array<Pick<BoxRow, "id" | "hostname">>): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.hostname]));
}

export function pinnedHostname(registry: Map<string, string>, boxId: string): string {
  const hostname = registry.get(boxId);
  if (!hostname) {
    throw new Error(`refused: unknown box "${boxId}" (no pinned hostname)`);
  }
  return hostname;
}

export function boxUrl(hostname: string, path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("refused: box path must be absolute");
  }
  return `https://${hostname}${path}`;
}

function assertPinnedHost(registry: Map<string, string>, hostname: string): void {
  for (const pinned of registry.values()) {
    if (hostname === pinned) {
      return;
    }
  }
  throw new Error(`refused: hostname "${hostname}" is not pinned`);
}

// Fetch a raw URL only when its hostname is in the pinned registry.
export async function fetchUrlPinned(
  registry: Map<string, string>,
  url: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error("refused: invalid box URL");
  }
  assertPinnedHost(registry, hostname);
  return fetcher(url, init);
}

// Choke point for ALL outbound box calls: resolve the pinned hostname,
// build the URL, fetch. Heartbeat-supplied URLs can never reach fetch.
export async function fetchBox(
  registry: Map<string, string>,
  boxId: string,
  path: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return fetchUrlPinned(registry, boxUrl(pinnedHostname(registry, boxId), path), init, fetcher);
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
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const body = parseHeartbeatBody(raw);
  if (!body) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const candidate = store.getBox(body.id);
  const token = extractBearer(request);
  if (!candidate || !token || !(await tokenMatches(token, candidate.heartbeat_token_hash))) {
    if (candidate) {
      await onMismatch?.(candidate.id);
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Re-read after the async verify so the check-and-write below runs as one
  // synchronous block (no interleaving between check and write).
  const row = store.getBox(body.id);
  if (!row) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const verdict = checkReplay(row, body.seq, body.box_now);
  if (verdict !== "ok") {
    if (verdict === "stale_seq" && body.seq <= REENROLL_SEQ_THRESHOLD) {
      // Probable DB loss, but the token is valid so this is the real box,
      // not a replay attacker: say so explicitly and ping the owner. Never
      // accept (the seq really is stale) — re-enrollment rebinds.
      await onReenroll?.(row.id);
      return Response.json({ error: verdict, code: "re_enroll_required" }, { status: 409 });
    }
    return Response.json({ error: verdict }, { status: 409 });
  }
  const seen = nowSec();
  store.putBox({ ...row, last_seq: body.seq, last_ts: body.box_now, last_seen: seen, epoch: body.epoch });
  // Taint signal (Task 5 revoke): the tombstone epoch is the greatest stale
  // epoch (see TombstoneRow in mint.ts), so the box is tainted while its
  // reported epoch has not rotated past it. A healed epoch clears the
  // tombstone here — heartbeat is the only path that observes new epochs.
  const tombstone = store.getTombstone?.(body.id);
  const tainted = tombstone !== undefined && tombstone !== null && body.epoch <= tombstone.epoch;
  if (tombstone && body.epoch > tombstone.epoch) {
    store.deleteTombstone?.(body.id);
  }
  return Response.json({ id: row.id, enrolled: row.enrolled === 1, last_seen: seen, tainted });
}
