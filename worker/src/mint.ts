import { unsealAdminToken } from "./sealedtoken";
import type { Box, BoxSilence, MintAnswer } from "./box";
import type { BoxRow } from "./boxes";
import { isTainted, type TombstoneRow } from "./tombstone";

// Mint relay: console POST /api/backends/:id/link → the box mints its own
// tap code. One idempotency key per console request: the console's own
// `Idempotency-Key` header (its retry chain) passes through verbatim; when
// absent the box client generates one so the box never sees a keyless mint
// (it 400s those). Box 429/502 surface verbatim; tainted-epoch boxes are
// refused before any call. Plaintext admin tokens and keys are never
// logged.

export interface MintStore {
  getBox(id: string): BoxRow | undefined;
  getTombstone(boxId: string): TombstoneRow | undefined;
}

export interface MintDeps {
  sealKey?: string;
  // The box: the port the brain asks a box through. The wiring builds
  // it; the mint never builds a client of its own.
  box: Box;
}

// The type the console's link answer carries. The link is text, and the
// box's own refusal is text too.
const LINK_CONTENT_TYPE = "text/plain;charset=utf-8";

export async function handleMintLink(
  boxId: string,
  consoleKey: string | null,
  store: MintStore,
  deps: MintDeps,
): Promise<Response> {
  const box = store.getBox(boxId);
  if (!box || box.enrolled !== 1) {
    return Response.json({ error: "unknown_box" }, { status: 404 });
  }
  // Taint gate first: no unseal, no call for boxes with a pending revoke.
  if (isTainted(box.epoch, store.getTombstone(boxId))) {
    return Response.json({ error: "tainted" }, { status: 409 });
  }
  const adminToken = await adminTokenFor(deps.sealKey, box);
  if (adminToken instanceof Response) {
    return adminToken;
  }
  return mintAnswer(await deps.box.mintLink(boxId, adminToken, consoleKey));
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

// The console's answer to the mint: the link the box minted, the box's
// own refusal, or the reason the box did not answer.
function mintAnswer(answer: MintAnswer): Response {
  if (answer.kind === "minted") {
    return new Response(answer.link, {
      status: 200,
      headers: { "content-type": LINK_CONTENT_TYPE },
    });
  }
  if (answer.kind === "refused") {
    // Non-200 relays verbatim: the box's own status and its own body
    // (covers box 429/502).
    return new Response(answer.message.said, {
      status: answer.message.status,
      headers: { "content-type": LINK_CONTENT_TYPE },
    });
  }
  return silenceAnswer(answer.reason);
}

// The answer for a box that was not reached: it timed out, or it is gone.
function silenceAnswer(reason: BoxSilence): Response {
  if (reason === "misconfigured") {
    return Response.json({ error: "misconfigured" }, { status: 500 });
  }
  if (reason === "box_timeout") {
    return Response.json({ error: "box_timeout" }, { status: 504 });
  }
  if (reason === "box_unreachable") {
    return Response.json({ error: "box_unreachable" }, { status: 502 });
  }
  return Response.json({ error: "unknown_box" }, { status: 404 });
}
