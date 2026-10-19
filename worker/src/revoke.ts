import { unsealAdminToken } from "./enroll";
import { fetchBox, pinnedRegistry } from "./heartbeat";
import type { TombstoneRow } from "./mint";
import type { BoxRow } from "./state";
import { BOX_API } from "./boxapi";

// Revoke relay: console POST /api/backends/:id/revoke (or POST
// /api/revoke-all) → box POST /admin/revoke with {"confirm": true}.
// Server-side confirm: the Worker 400s unless the console body carries
// confirm:true — the box is never asked to confirm on the console's behalf.
// Every outcome is a per-box result ({id, status, ...}), never a silent
// skip: online boxes report revoked, unreachable boxes are tombstoned at
// their last-known epoch (sticky until a heartbeat rotates past it — see
// the TombstoneRow invariant in mint.ts), unknown boxes report unknown_box.
// Plaintext admin tokens are never logged.

// Box calls get 15s (revoke execs a password rotation server-side).
export const REVOKE_DEADLINE_MS = 15_000;

export type RevokeStatus = "revoked" | "tombstoned" | "unknown_box" | "misconfigured" | "box_error";

export interface RevokeResult {
  id: string;
  status: RevokeStatus;
  // New box epoch on revoked; last-known epoch on tombstoned.
  epoch?: number;
  // Box HTTP status on box_error.
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

export async function revokeOneBox(
  boxId: string,
  store: RevokeStore,
  deps: RevokeDeps = {},
): Promise<RevokeResult> {
  const box = store.getBox(boxId);
  if (!box || box.enrolled !== 1) {
    return { id: boxId, status: "unknown_box" };
  }
  if (!deps.sealKey) {
    console.error("revoke: seal key not configured");
    return { id: boxId, status: "misconfigured" };
  }
  // Decrypt only at call time, right before the relay. Wrong key or tampered
  // blob is a hard failure, never a fallback; a box with no bound admin
  // token cannot be revoked.
  let adminToken: string | null;
  try {
    adminToken = await unsealAdminToken(deps.sealKey, box.admin_token_sealed);
  } catch {
    console.error("revoke: admin token unseal failed");
    return { id: boxId, status: "misconfigured" };
  }
  if (!adminToken) {
    console.error("revoke: no admin token bound for box");
    return { id: boxId, status: "misconfigured" };
  }
  const signal = AbortSignal.timeout(deps.deadlineMs ?? REVOKE_DEADLINE_MS);
  let boxRes: Response;
  try {
    boxRes = await fetchBox(
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
    const epoch = await parseRevokeEpoch(boxRes);
    if (epoch === null) {
      // Box claims success but names no epoch: fail closed at the
      // last-known epoch (a 200 means it likely rotated; taint until a
      // heartbeat proves the new epoch).
      raiseTombstone(store, boxId, box.epoch);
      return { id: boxId, status: "tombstoned", epoch: box.epoch, detail: "box_bad_epoch" };
    }
    // Greatest stale epoch: every epoch below the new one is dead. The
    // worker-row max guards a row that already runs ahead of the box reply;
    // raiseTombstone keeps a pre-existing higher tombstone on top of that.
    raiseTombstone(store, boxId, Math.max(box.epoch, epoch - 1));
    return { id: boxId, status: "revoked", epoch };
  }
  // Box refused (e.g. 400/401/409): rotation did not happen, so no
  // tombstone — the per-box result carries the box status for diagnosis.
  const detail = (await boxRes.text()).slice(0, 256);
  return { id: boxId, status: "box_error", box_status: boxRes.status, detail };
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
