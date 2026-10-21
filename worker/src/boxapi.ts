// Box API paths the Worker calls on an enrolled box.
//
// The prefix avoids "/admin" on purpose: Cloudflare's managed WAF rules
// challenge any path containing that segment (a WordPress-admin
// heuristic), and the challenge page answers instead of the box — which
// broke every worker→box relay. A path the edge does not second-guess
// keeps the relay working; the endpoints stay bearer-gated either way.
//
// This module also owns the call itself: the relay takes the sealed
// admin token, the box's pinned hostname and a short deadline, and says
// whether the box answered.
import { unsealAdminToken } from "./enroll";
import { fetchBox, pinnedRegistry } from "./heartbeat";
import type { BoxRow } from "./state";

export const BOX_API = {
  mint: "/_oc/mint",
  revoke: "/_oc/revoke",
  audit: "/_oc/audit",
  presence: "/_oc/presence",
  status: "/_oc/status",
} as const;

// Box reads get 3s: a dead box must not hold a request open. The mint
// relay's 15s is far too long for a presence probe — the owner would
// wait behind a box that is already gone.
export const BOX_READ_DEADLINE_MS = 3_000;

// Why a relay never reached the box.
export type RelayFailure =
  | "unknown_box"
  | "misconfigured"
  | "box_timeout"
  | "box_unreachable";

// The outcome of one relay: the box answered (with a status and a body),
// or it did not (and why not).
export type BoxRelay =
  | { answered: true; status: number; body: string; contentType: string }
  | { answered: false; reason: RelayFailure };

export interface BoxRelayStore {
  getBox(id: string): BoxRow | undefined;
}

export interface BoxRelayDeps {
  sealKey?: string;
  fetcher?: typeof fetch;
  deadlineMs?: number;
}

// The relay: one call to the box, over its pinned hostname, with the
// sealed admin token and a short deadline.
//
// The admin token is decrypted at call time only (the same rule the mint
// and audit relays follow) and is never logged. A box that answers with
// an error status still answered: the relay hands the status and the
// body back, and the caller decides what an error means.
export async function relayToBox(
  store: BoxRelayStore,
  boxId: string,
  path: string,
  deps: BoxRelayDeps = {},
): Promise<BoxRelay> {
  const box = store.getBox(boxId);
  if (!box || box.enrolled !== 1) {
    return { answered: false, reason: "unknown_box" };
  }
  const adminToken = await adminTokenFor(deps.sealKey, box);
  if (adminToken === null) {
    return { answered: false, reason: "misconfigured" };
  }
  const signal = AbortSignal.timeout(deps.deadlineMs ?? BOX_READ_DEADLINE_MS);
  let boxRes: Response;
  try {
    boxRes = await fetchBox(
      pinnedRegistry([box]),
      boxId,
      path,
      { headers: { authorization: `Bearer ${adminToken}` }, signal },
      deps.fetcher,
    );
  } catch {
    return { answered: false, reason: signal.aborted ? "box_timeout" : "box_unreachable" };
  }
  return {
    answered: true,
    status: boxRes.status,
    body: await boxRes.text(),
    contentType: boxRes.headers.get("content-type") ?? "text/plain;charset=utf-8",
  };
}

// The admin token the relay carries, or null when the brain cannot read
// it: no seal key, a binding it cannot read, or a box with no admin
// token bound.
//
// The admin token is decrypted at call time only (the same rule the mint
// and audit relays follow) and is never logged.
async function adminTokenFor(sealKey: string | undefined, box: BoxRow): Promise<string | null> {
  if (!sealKey) {
    console.error("relay: seal key not configured");
    return null;
  }
  let adminToken: string | null;
  try {
    adminToken = await unsealAdminToken(sealKey, box.admin_token_sealed);
  } catch {
    console.error("relay: admin token unseal failed");
    return null;
  }
  if (!adminToken) {
    console.error("relay: no admin token bound for box");
    return null;
  }
  return adminToken;
}

// The status each failed relay reason answers with.
const RELAY_FAILURE_STATUS = new Map<RelayFailure, number>([
  ["unknown_box", 404],
  ["misconfigured", 500],
  ["box_timeout", 504],
  ["box_unreachable", 502],
]);

// The status a failed relay answers with: the reason names the answer.
// A reason the table does not know is a bad gateway — the brain cannot
// say more about a relay it does not understand.
export function relayFailureStatus(reason: RelayFailure): number {
  return RELAY_FAILURE_STATUS.get(reason) ?? 502;
}
