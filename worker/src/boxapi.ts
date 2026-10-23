// The box adapter: the box port, spoken.
//
// The brain asks a box for things in its own words; this module says
// how the box hears it: the paths, the bearer, the idempotency key,
// the query strings and the deadlines. The HTTP itself lives in
// boxclient.ts, the one place that reaches a box.
//
// The admin token is the brain's: it seals it at enrolment and unseals
// it at call time. The adapter only carries it.
import { fetchBox, pinnedRegistry } from "./boxclient";
import { isEdgeError } from "./edgeerror";
import type { BoxRow } from "./boxes";
import type {
  AuditAnswer,
  Box,
  BoxMessage,
  BoxReply,
  BoxSilence,
  MintAnswer,
  RevokeAnswer,
} from "./box";

// The endpoints the brain asks for. The paths are the protocol the
// brain speaks with a box, so they live here, with the module that
// speaks them — not with the domain that asks.
//
// The prefix avoids "/admin" on purpose: Cloudflare's managed WAF rules
// challenge any path containing that segment (a WordPress-admin
// heuristic), and the challenge page answers instead of the box — which
// broke every worker→box relay. A path the edge does not second-guess
// keeps the relay working; the endpoints stay bearer-gated either way.
const BOX_API = {
  mint: "/_oc/mint",
  revoke: "/_oc/revoke",
  audit: "/_oc/audit",
  presence: "/_oc/presence",
  status: "/_oc/status",
} as const;

// Box reads get 3s: a dead box must not hold a request open. The mint
// relay's 15s is far too long for a read — the owner would wait behind
// a box that is already gone.
export const BOX_READ_DEADLINE_MS = 3_000;

// The mint and the revoke exec a password rotation server-side, so
// they get the time the rotation needs.
const BOX_WRITE_DEADLINE_MS = 15_000;

// The audit is a small SQLite scan server-side.
export const AUDIT_DEADLINE_MS = 5_000;

// What the adapter needs: the rows it reads the box's hostname from,
// and the transport the calls go through.
export interface BoxAdapterDeps {
  fetcher?: typeof fetch;
  // deadlineMs bounds one call. Unset = the call's own deadline.
  deadlineMs?: number;
}

// The rows the adapter reads: the box it is talking to.
export interface BoxStore {
  getBox(id: string): BoxRow | undefined;
}

// One call to a box: what to ask, and how long the box may take.
interface BoxCall {
  path: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  deadlineMs: number;
}

// The outcome of one call: the box answered, or it did not.
type CallOutcome =
  | { kind: "answered"; res: Response }
  | { kind: "silent"; reason: BoxSilence };

// The box the brain asks: the port, spoken by this adapter. The wiring
// (state.ts) builds it and hands it to the brain.
export function boxAdapter(store: BoxStore, deps: BoxAdapterDeps = {}): Box {
  return {
    mintLink: (boxId, adminToken, consoleKey) => mintLink(store, boxId, adminToken, consoleKey, deps),
    resolvePair: (boxId, tapUrl) => resolvePair(store, boxId, tapUrl, deps),
    auditRows: (boxId, adminToken, n) => auditRows(store, boxId, adminToken, n, deps),
    revoke: (boxId, adminToken) => revoke(store, boxId, adminToken, deps),
    status: (boxId, adminToken) => ask(store, boxId, adminToken, BOX_API.status, deps),
    presence: (boxId, adminToken) => ask(store, boxId, adminToken, BOX_API.presence, deps),
  };
}

// The mint: the box mints its own tap code.
//
// The console's idempotency key rides along, so a retry never mints
// twice; when the console sends none, the adapter mints one — the box
// 400s a keyless mint.
async function mintLink(
  store: BoxStore,
  boxId: string,
  adminToken: string,
  consoleKey: string | null,
  deps: BoxAdapterDeps,
): Promise<MintAnswer> {
  const call = await callBox(store, boxId, adminToken, {
    path: BOX_API.mint,
    method: "POST",
    headers: { "idempotency-key": idempotencyKey(consoleKey) },
    deadlineMs: deps.deadlineMs ?? BOX_WRITE_DEADLINE_MS,
  }, deps);
  if (call.kind === "silent") {
    return { kind: "silent", reason: call.reason };
  }
  if (call.res.status === 200) {
    return { kind: "minted", link: await call.res.text() };
  }
  return { kind: "refused", message: await refusal(call.res) };
}

// The key the box sees: the console's own, or one the adapter mints.
function idempotencyKey(consoleKey: string | null): string {
  if (consoleKey && consoleKey.length > 0) {
    return consoleKey;
  }
  return crypto.randomUUID();
}

// The tap's own answer: the pairing URL the box 302s to and prints.
// The redirect is not followed — following it would spend the single
// use in a fetch the owner never sees — so the printed body is read
// instead. The tap URL's host must be the box's own pinned hostname: a
// tap that points anywhere else is refused, not followed.
async function resolvePair(
  store: BoxStore,
  boxId: string,
  tapUrl: string,
  deps: BoxAdapterDeps,
): Promise<BoxReply> {
  const box = store.getBox(boxId);
  if (!box || box.enrolled !== 1) {
    return { kind: "silent", reason: "unknown_box" };
  }
  const tap = parseTapUrl(tapUrl);
  assertTapHost(box, tap);
  return fetchTap(box, boxId, tap, deps);
}

// The tap URL the box minted, parsed. A URL that does not parse is
// refused, not fetched.
function parseTapUrl(tapUrl: string): URL {
  try {
    return new URL(tapUrl);
  } catch {
    throw new Error("refused: invalid tap URL");
  }
}

// The tap URL's host must be the box's own pinned hostname: the check
// reads the box's row, never a heartbeat-supplied URL.
function assertTapHost(box: BoxRow, tap: URL): void {
  if (tap.hostname !== box.hostname) {
    throw new Error(`refused: the tap is not this box's ("${tap.hostname}")`);
  }
}

// One GET of the tap, without following the redirect: the box 302s to
// the pairing URL and prints it, and the printed body is the answer.
async function fetchTap(box: BoxRow, boxId: string, tap: URL, deps: BoxAdapterDeps): Promise<BoxReply> {
  const signal = AbortSignal.timeout(deps.deadlineMs ?? BOX_WRITE_DEADLINE_MS);
  try {
    // Redirect manual: following it would spend the single use in a
    // fetch the owner never sees.
    const res = await fetchBox(
      pinnedRegistry([box]),
      boxId,
      `${tap.pathname}${tap.search}`,
      { redirect: "manual", signal },
      deps.fetcher,
    );
    const said = await res.text();
    if (isEdgeError(res.status, said)) {
      return { kind: "silent", reason: "box_unreachable" };
    }
    return { kind: "answered", message: { status: res.status, said } };
  } catch {
    return { kind: "silent", reason: signal.aborted ? "box_timeout" : "box_unreachable" };
  }
}

// The pairing URL out of the tap's answer: the box 302s to it and prints
// it. Anything else — another status, another body — is not a pairing
// link, and the caller says so instead of handing the owner a dead URL.
export function pairingLink(status: number, said: string): string {
  if (status !== 302) {
    throw new Error(`the tap answered ${status}`);
  }
  const link = said.trim();
  if (!link.startsWith("https://")) {
    throw new Error("the tap answered no pairing link");
  }
  return link;
}

// The audit: the box's own rows, in the box's own shape.
async function auditRows(
  store: BoxStore,
  boxId: string,
  adminToken: string,
  n: number,
  deps: BoxAdapterDeps,
): Promise<AuditAnswer> {
  const call = await callBox(store, boxId, adminToken, {
    path: `${BOX_API.audit}?n=${n}`,
    deadlineMs: deps.deadlineMs ?? AUDIT_DEADLINE_MS,
  }, deps);
  if (call.kind === "silent") {
    return { kind: "silent", reason: call.reason };
  }
  if (call.res.status !== 200) {
    return { kind: "unreadable", reason: `status ${call.res.status}` };
  }
  const rows = await boxRows(call.res);
  return rows === null ? { kind: "unreadable", reason: "box_bad_json" } : { kind: "rows", rows };
}

// The rows the box sent. Null when the answer is not a list of rows:
// the brain never guesses what the box said.
async function boxRows(res: Response): Promise<unknown[] | null> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return null;
  }
  return Array.isArray(raw) ? (raw as unknown[]) : null;
}

// The revoke: the box rotates its own credentials. The confirm rides
// along, because the box is never asked to confirm on the console's
// behalf.
async function revoke(
  store: BoxStore,
  boxId: string,
  adminToken: string,
  deps: BoxAdapterDeps,
): Promise<RevokeAnswer> {
  const call = await callBox(store, boxId, adminToken, {
    path: BOX_API.revoke,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true }),
    deadlineMs: deps.deadlineMs ?? BOX_WRITE_DEADLINE_MS,
  }, deps);
  if (call.kind === "silent") {
    return { kind: "silent", reason: call.reason };
  }
  if (call.res.status !== 200) {
    return { kind: "refused", message: await refusal(call.res) };
  }
  const epoch = await rotatedEpoch(call.res);
  return epoch === null ? { kind: "claimed" } : { kind: "revoked", epoch };
}

// The epoch the box rotated to, when it named one. Null when it did
// not: the box claims it revoked and says nothing about its epoch.
async function rotatedEpoch(res: Response): Promise<number | null> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const epoch = (raw as Record<string, unknown>)["epoch"];
  return Number.isInteger(epoch) && (epoch as number) >= 0 ? (epoch as number) : null;
}

// The status and the presence: the box's own answer, relayed.
//
// An edge error page is not the box answering: when the tunnel is down
// the edge answers instead of the box, so the relay must read it as
// silence — otherwise a dead box looks alive.
async function ask(
  store: BoxStore,
  boxId: string,
  adminToken: string,
  path: string,
  deps: BoxAdapterDeps,
): Promise<BoxReply> {
  const call = await callBox(store, boxId, adminToken, {
    path,
    deadlineMs: deps.deadlineMs ?? BOX_READ_DEADLINE_MS,
  }, deps);
  if (call.kind === "silent") {
    return { kind: "silent", reason: call.reason };
  }
  const said = await call.res.text();
  if (isEdgeError(call.res.status, said)) {
    return { kind: "silent", reason: "box_unreachable" };
  }
  return { kind: "answered", message: { status: call.res.status, said } };
}

// The box's refusal: the status it answered with and what it said.
async function refusal(res: Response): Promise<BoxMessage> {
  return { status: res.status, said: await res.text() };
}

// One call to a box: the bearer, the deadline, the pinned hostname.
//
// A box the brain does not know, or one that is not enrolled, is never
// called. A box that does not answer is a silence, and the silence says
// whether the box was slow or gone.
async function callBox(
  store: BoxStore,
  boxId: string,
  adminToken: string,
  call: BoxCall,
  deps: BoxAdapterDeps,
): Promise<CallOutcome> {
  const box = store.getBox(boxId);
  if (!box || box.enrolled !== 1) {
    return { kind: "silent", reason: "unknown_box" };
  }
  const signal = AbortSignal.timeout(call.deadlineMs);
  try {
    const res = await fetchBox(
      pinnedRegistry([box]),
      boxId,
      call.path,
      {
        method: call.method ?? "GET",
        headers: { authorization: `Bearer ${adminToken}`, ...call.headers },
        body: call.body,
        signal,
      },
      deps.fetcher,
    );
    return { kind: "answered", res };
  } catch {
    return { kind: "silent", reason: signal.aborted ? "box_timeout" : "box_unreachable" };
  }
}
