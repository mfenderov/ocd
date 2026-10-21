import { unsealAdminToken } from "./enroll";
import { fetchBox, pinnedRegistry } from "./heartbeat";
import type { BoxRow } from "./boxes";
import { BOX_API } from "./boxapi";

// Mint relay: console POST /api/backends/:id/link → box POST /admin/mint.
// One idempotency key per console request: the console's own
// `Idempotency-Key` header (its retry chain) passes through verbatim; when
// absent the Worker generates one so the box never sees a keyless mint (it
// 400s those). Box 429/502 surface verbatim; tainted-epoch boxes are refused
// before any fetch. Plaintext admin tokens and keys are never logged.

// Box calls get 15s (mint execs a password rotation server-side).
const MINT_DEADLINE_MS = 15_000;

// Pending-revoke marker. Invariant for Task 5 (revoke): tombstone.epoch is
// the greatest stale epoch — a box is tainted while its heartbeat epoch has
// not rotated past it, clean once it exceeds it. Table lives here minimally
// so Task 5 only adds the revoke write path, never a second table.
export interface TombstoneRow {
  box_id: string;
  epoch: number;
}

export function isTainted(boxEpoch: number, tombstone: TombstoneRow | undefined): boolean {
  if (!tombstone) {
    return false;
  }
  return boxEpoch <= tombstone.epoch;
}

export interface MintStore {
  getBox(id: string): BoxRow | undefined;
  getTombstone(boxId: string): TombstoneRow | undefined;
}

export interface MintDeps {
  sealKey?: string;
  fetcher?: typeof fetch;
  deadlineMs?: number;
  generateKey?: () => string;
}

function defaultGenerateKey(): string {
  return crypto.randomUUID();
}

export async function handleMintLink(
  boxId: string,
  consoleKey: string | null,
  store: MintStore,
  deps: MintDeps = {},
): Promise<Response> {
  const box = store.getBox(boxId);
  if (!box || box.enrolled !== 1) {
    return Response.json({ error: "unknown_box" }, { status: 404 });
  }
  // Taint gate first: no unseal, no fetch for boxes with a pending revoke.
  if (isTainted(box.epoch, store.getTombstone(boxId))) {
    return Response.json({ error: "tainted" }, { status: 409 });
  }
  const adminToken = await adminTokenFor(deps.sealKey, box);
  if (adminToken instanceof Response) {
    return adminToken;
  }
  const signal = AbortSignal.timeout(deps.deadlineMs ?? MINT_DEADLINE_MS);
  const boxRes = await callBox(box, boxId, adminToken, consoleKey, deps, signal);
  if (!boxRes) {
    return unreachable(signal);
  }
  return boxAnswer(boxRes);
}

// The admin token the relay carries, or the answer that says it cannot:
// a brain without the seal key, a binding it cannot read, or a box with
// no admin token bound.
//
// Decrypt only at call time, right before the relay. Wrong key or tampered
// blob is a hard failure, never a fallback.
async function adminTokenFor(sealKey: string | undefined, box: BoxRow): Promise<string | Response> {
  if (!sealKey) {
    console.error("mint: seal key not configured");
    return Response.json({ error: "misconfigured" }, { status: 500 });
  }
  let adminToken: string | null;
  try {
    adminToken = await unsealAdminToken(sealKey, box.admin_token_sealed);
  } catch {
    console.error("mint: admin token unseal failed");
    return Response.json({ error: "misconfigured" }, { status: 500 });
  }
  if (!adminToken) {
    console.error("mint: no admin token bound for box");
    return Response.json({ error: "misconfigured" }, { status: 500 });
  }
  return adminToken;
}

// The call to the box: the mint itself, with the console's idempotency
// key (one per console request, so a retry never mints twice). Null when
// the box was not reached.
async function callBox(
  box: BoxRow,
  boxId: string,
  adminToken: string,
  consoleKey: string | null,
  deps: MintDeps,
  signal: AbortSignal,
): Promise<Response | null> {
  const key = consoleKey && consoleKey.length > 0 ? consoleKey : (deps.generateKey ?? defaultGenerateKey)();
  try {
    return await fetchBox(
      pinnedRegistry([box]),
      boxId,
      BOX_API.mint,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": key },
        signal,
      },
      deps.fetcher,
    );
  } catch {
    return null;
  }
}

// The answer for a box that was not reached: it timed out, or it is gone.
function unreachable(signal: AbortSignal): Response {
  if (signal.aborted) {
    return Response.json({ error: "box_timeout" }, { status: 504 });
  }
  return Response.json({ error: "box_unreachable" }, { status: 502 });
}

// The box's own answer: its body, with its status.
async function boxAnswer(boxRes: Response): Promise<Response> {
  if (boxRes.status === 200) {
    return new Response(await boxRes.text(), {
      status: 200,
      headers: { "content-type": "text/plain;charset=utf-8" },
    });
  }
  // Non-200 relays verbatim: status + body (covers box 429/502).
  return new Response(boxRes.body, {
    status: boxRes.status,
    headers: { "content-type": boxRes.headers.get("content-type") ?? "text/plain;charset=utf-8" },
  });
}
