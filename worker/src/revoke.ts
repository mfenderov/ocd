import { unsealAdminToken } from "./sealedtoken";
import { fetchBox, pinnedRegistry } from "./heartbeat";
import type { BoxRow } from "./boxes";
import { BOX_API } from "./ports";
import type { TombstoneRow } from "./tombstone";

// Revoke relay: console POST /api/backends/:id/revoke (or POST
// /api/revoke-all) → box POST /admin/revoke with {"confirm": true}.
// Server-side confirm: the Worker 400s unless the console body carries
// confirm:true — the box is never asked to confirm on the console's behalf.
// Every outcome is a per-box result ({id, status, ...}), never a silent
// skip: online boxes report revoked, unreachable boxes are tombstoned at
// their last-known epoch (sticky until a heartbeat rotates past it — see
// the TombstoneRow invariant in tombstone.ts), unknown boxes report unknown_box.
// Plaintext admin tokens are never logged.

// Box calls get 15s (revoke execs a password rotation server-side).
const REVOKE_DEADLINE_MS = 15_000;

type RevokeStatus = "revoked" | "tombstoned" | "unknown_box" | "misconfigured" | "box_error";

export interface RevokeResult {
  id: string;
  status: RevokeStatus;
  // New box epoch on revoked; last-known epoch on tombstoned.
  epoch?: number;
  // Box HTTP status when the box answered with an error.
  box_status?: number;
  detail?: string;
}

export interface TombstoneStore {
  getTombstone(boxId: string): TombstoneRow | undefined;
  putTombstone(row: TombstoneRow): void;
}

export interface RevokeStore extends TombstoneStore {
  getBox(id: string): BoxRow | undefined;
  listBoxes(): BoxRow[];
}

export interface RevokeDeps {
  sealKey?: string;
  fetcher?: typeof fetch;
  deadlineMs?: number;
}

// Single choke point for every tombstone write: tombstones only move up.
// Only a heartbeat past the stored epoch proves healing and clears the row,
// so no revoke outcome (success, offline, or garbled reply) may lower it.
export function raiseTombstone(store: TombstoneStore, boxId: string, epoch: number): void {
  const prior = store.getTombstone(boxId)?.epoch;
  if (prior === undefined || epoch > prior) {
    store.putTombstone({ box_id: boxId, epoch });
  }
}

async function readConfirm(request: Request): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return false;
  }
  if (typeof raw !== "object" || raw === null) {
    return false;
  }
  return (raw as Record<string, unknown>)["confirm"] === true;
}

async function parseRevokeEpoch(res: Response): Promise<number | null> {
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

// Cloudflare's own error statuses: the edge never reached the origin.
// 530 carries "error 1016" (no DNS record) and "error 1033" (tunnel not
// connected); 52x are the other origin failures. A 5xx outside this set
// came from the box: the box answered and refused.
const EDGE_ERROR_STATUSES = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530]);

// isEdgeError tells an unreachable box from a box that answered. The
// status covers the tunnel errors; the body covers the edge's plain-text
// "error code: NNN" pages, which arrive on statuses the box also uses.
function isEdgeError(status: number, body: string): boolean {
  return EDGE_ERROR_STATUSES.has(status) || /error code: \d+/.test(body);
}

export async function revokeOneBox(
  boxId: string,
  store: RevokeStore,
  deps: RevokeDeps = {},
): Promise<RevokeResult> {
  const box = store.getBox(boxId);
  if (!box || box.enrolled !== 1) {
    return { id: boxId, status: "unknown_box" };
  }
  const adminToken = await adminTokenFor(deps.sealKey, box);
  if (adminToken === null) {
    return { id: boxId, status: "misconfigured" };
  }
  const signal = AbortSignal.timeout(deps.deadlineMs ?? REVOKE_DEADLINE_MS);
  const boxRes = await callBox(box, boxId, adminToken, deps, signal);
  if (!boxRes) {
    // Offline (or timed out): sticky tombstone at the last-known epoch so
    // mint stays refused until the box heartbeats back past it. The timeout
    // vs unreachable distinction is diagnostic detail only.
    raiseTombstone(store, boxId, box.epoch);
    return {
      id: boxId,
      status: "tombstoned",
      epoch: box.epoch,
      detail: signal.aborted ? "box_timeout" : "box_unreachable",
    };
  }
  if (boxRes.status === 200) {
    return revokedResult(store, box, boxRes);
  }
  return refusedResult(store, box, boxRes);
}

// The admin token the relay carries, or null when the brain cannot read
// it: no seal key, a binding it cannot read, or a box with no admin
// token bound.
//
// Decrypt only at call time, right before the relay. Wrong key or tampered
// blob is a hard failure, never a fallback.
async function adminTokenFor(sealKey: string | undefined, box: BoxRow): Promise<string | null> {
  if (!sealKey) {
    console.error("revoke: seal key not configured");
    return null;
  }
  let adminToken: string | null;
  try {
    adminToken = await unsealAdminToken(sealKey, box.admin_token_sealed);
  } catch {
    console.error("revoke: admin token unseal failed");
    return null;
  }
  if (!adminToken) {
    console.error("revoke: no admin token bound for box");
    return null;
  }
  return adminToken;
}

// The call to the box: the revoke itself. Null when the box was not
// reached.
async function callBox(
  box: BoxRow,
  boxId: string,
  adminToken: string,
  deps: RevokeDeps,
  signal: AbortSignal,
): Promise<Response | null> {
  try {
    return await fetchBox(
      pinnedRegistry([box]),
      boxId,
      BOX_API.revoke,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: true }),
        signal,
      },
      deps.fetcher,
    );
  } catch {
    return null;
  }
}

// The revoked result: the box's new epoch, or a fail-closed tombstone
// when the box claims success but names no epoch.
async function revokedResult(store: RevokeStore, box: BoxRow, boxRes: Response): Promise<RevokeResult> {
  const epoch = await parseRevokeEpoch(boxRes);
  if (epoch === null) {
    // Box claims success but names no epoch: fail closed at the
    // last-known epoch (a 200 means it likely rotated; taint until a
    // heartbeat proves the new epoch).
    raiseTombstone(store, box.id, box.epoch);
    return { id: box.id, status: "tombstoned", epoch: box.epoch, detail: "box_bad_epoch" };
  }
  // Greatest stale epoch: every epoch below the new one is dead. The
  // worker-row max guards a row that already runs ahead of the box reply;
  // raiseTombstone keeps a pre-existing higher tombstone on top of that.
  raiseTombstone(store, box.id, Math.max(box.epoch, epoch - 1));
  return { id: box.id, status: "revoked", epoch };
}

// The result for a box that did not revoke.
//
// A 5xx means the revoke did not take effect, so the box must be blocked
// either way: its sessions may still be alive. What differs is who
// answered. The edge could not reach the origin (520-527, 530: "error
// 1016" no DNS, "error 1033" tunnel not connected) — the box is gone. Any
// other 5xx came from the box itself: it ran and failed the rotation, so
// it is still there and it still needs fixing.
async function refusedResult(store: RevokeStore, box: BoxRow, boxRes: Response): Promise<RevokeResult> {
  if (boxRes.status >= 500) {
    raiseTombstone(store, box.id, box.epoch);
    const body = (await boxRes.text()).slice(0, 256);
    const reason = isEdgeError(boxRes.status, body) ? "box_unreachable" : "box_revoke_failed";
    return {
      id: box.id,
      status: "tombstoned",
      epoch: box.epoch,
      box_status: boxRes.status,
      detail: body ? `${reason}: ${body}` : reason,
    };
  }
  // Box refused (e.g. 400/401/409): rotation did not happen, so no
  // tombstone — the per-box result carries the box status for diagnosis.
  const detail = (await boxRes.text()).slice(0, 256);
  return { id: box.id, status: "box_error", box_status: boxRes.status, detail };
}

// Every enrolled row is attempted; results are per-box so no box is ever
// silently skipped. Sequential: fleets are small and box calls are slow.
export async function revokeAllBoxes(
  store: RevokeStore,
  deps: RevokeDeps = {},
): Promise<RevokeResult[]> {
  const results: RevokeResult[] = [];
  for (const box of store.listBoxes()) {
    results.push(await revokeOneBox(box.id, store, deps));
  }
  return results;
}

function statusFor(result: RevokeResult): number {
  if (result.status === "unknown_box") {
    return 404;
  }
  if (result.status === "misconfigured") {
    return 500;
  }
  return 200;
}

export async function handleRevoke(
  boxId: string,
  request: Request,
  store: RevokeStore,
  deps: RevokeDeps = {},
): Promise<Response> {
  if (!(await readConfirm(request))) {
    return Response.json({ error: "confirm_required" }, { status: 400 });
  }
  const result = await revokeOneBox(boxId, store, deps);
  return Response.json(result, { status: statusFor(result) });
}

export async function handleRevokeAll(
  request: Request,
  store: RevokeStore,
  deps: RevokeDeps = {},
): Promise<Response> {
  if (!(await readConfirm(request))) {
    return Response.json({ error: "confirm_required" }, { status: 400 });
  }
  return Response.json({ results: await revokeAllBoxes(store, deps) });
}
