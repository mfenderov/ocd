import { escapeHtml } from "./html";
import type { BoxPublic } from "./boxes";
import type { OwnerChat } from "./owner";

// The liveness sweep: the brain notices a box that stopped talking.
//
// Four rules hold:
//
//   1. The sweep never guesses. A box that heartbeated recently is
//      silent, and a box that went quiet is probed directly before the
//      owner is told anything. The probe is the brain's own request to
//      the box, so a broken heartbeat does not make the owner think the
//      machine is gone.
//
//   2. A retired box is not offline. A box the owner revoked on purpose
//      is tombstoned, and the sweep leaves it alone.
//
//   3. One notice per outage. The owner is told once that a box went
//      dark, and never again while it stays dark.
//
//   4. One recovery per outage. When the box answers again — by
//      heartbeat or by the probe — the owner is told once that it is
//      back.
//
// The mark ("the owner was told") is set only when the message landed:
// a Telegram outage costs a retry, never a notice. The boxes are probed
// one after another: fleets are small and a dead box costs seconds.

// How long a box may go without a heartbeat before the brain probes it:
// three missed beats at the 30 second fleet heartbeat. The board reads
// the same rule (see botbuttons.boxState), so the owner never sees one
// box called ok and offline at once.
export const OFFLINE_AFTER_SEC = 90;

// The store the sweep reads and writes: the boxes it looks at, and the
// mark that says the owner was told a box went dark.
//
// The sweep reads the mark first (isSuspectedOffline) and clears it only
// after the message landed, so a notice that did not reach Telegram is
// retried by the next sweep. clearSuspectedOffline reports whether the
// mark was set, for callers that clear it outright.
export interface LivenessStore {
  listBoxes(): BoxPublic[];
  markSuspectedOffline(boxId: string): void;
  clearSuspectedOffline(boxId: string): boolean;   // true when it was set
  isSuspectedOffline(boxId: string): boolean;
}

export interface LivenessDeps {
  telegram: OwnerChat;
  // The chat the notice goes to: the owner's, and only the owner's. The
  // brain talks to one chat, so the sweep names it here.
  ownerChatId: number;
  // The probe: did the box answer? true = the box answered, false = it
  // did not. The probe throws when the brain could not ask the box at
  // all (a misconfigured relay): the sweep then leaves the box unjudged
  // instead of reporting a box it never asked.
  probePresence: (boxId: string) => Promise<boolean>;
  nowSec: () => number;
  offlineAfterSec: number;
}

// What the probe says: the box answered, the box did not answer, or the
// brain could not ask and must not judge the box.
type ProbeVerdict = "answered" | "silent" | "unjudged";

// The sweep: every box, one pass.
export async function sweepLiveness(store: LivenessStore, deps: LivenessDeps): Promise<void> {
  const now = deps.nowSec();
  for (const box of store.listBoxes()) {
    if (box.tombstoned) {
      // A box the owner revoked on purpose is retired, not offline: the
      // board calls it tombstoned, and the mint gate refuses it. It must
      // not be probed and must not be reported — and it leaves no mark
      // behind, so a later re-enrolment inherits no stale notice.
      store.clearSuspectedOffline(box.id);
      continue;
    }
    if (now - box.last_seen <= deps.offlineAfterSec) {
      // The box is talking again: the owner was told it went dark, so
      // the owner is told it is back.
      await announceRecovery(store, deps, box.id);
      continue;
    }
    const verdict = await probe(deps, box.id);
    if (verdict === "unjudged") {
      // The brain could not ask. That is the brain's problem, not the
      // box's: the box stays unjudged.
      continue;
    }
    if (verdict === "answered") {
      // The box answered the probe: it is alive, even though its
      // heartbeat stopped.
      await announceRecovery(store, deps, box.id);
      continue;
    }
    await announceOffline(store, deps, box.id);
  }
}

// The probe: what the box says when the brain asks. A probe that throws
// means the brain could not ask at all: that is a misconfiguration, and
// a misconfiguration must never read as a dead box.
async function probe(deps: LivenessDeps, boxId: string): Promise<ProbeVerdict> {
  try {
    return (await deps.probePresence(boxId)) ? "answered" : "silent";
  } catch (err) {
    console.error(`liveness: the probe for "${boxId}" failed (${errorText(err)})`);
    return "unjudged";
  }
}

// The offline notice: the owner is told once that the box went dark.
async function announceOffline(store: LivenessStore, deps: LivenessDeps, boxId: string): Promise<void> {
  if (store.isSuspectedOffline(boxId)) {
    // Already told: the owner hears it once per outage, not once per
    // sweep.
    return;
  }
  if (await notify(deps, offlineText(boxId))) {
    store.markSuspectedOffline(boxId);
  }
}

// The recovery: the owner is told once that the box is back. The mark
// is cleared only when the message landed, so a Telegram outage costs a
// retry, not the notice.
async function announceRecovery(store: LivenessStore, deps: LivenessDeps, boxId: string): Promise<void> {
  if (!store.isSuspectedOffline(boxId)) {
    return;
  }
  if (await notify(deps, backText(boxId))) {
    store.clearSuspectedOffline(boxId);
  }
}

// The message: to the owner's chat, and to nobody else. A failure is
// logged and swallowed — the sweep must not die on a Telegram outage,
// and the next sweep tries again.
async function notify(deps: LivenessDeps, text: string): Promise<boolean> {
  try {
    await deps.telegram.say(deps.ownerChatId, text);
    return true;
  } catch (err) {
    console.error(`liveness: the notice failed (${errorText(err)})`);
    return false;
  }
}

// The notice: the box went dark.
function offlineText(boxId: string): string {
  return (
    `🔴 I suspect <code>${escapeHtml(boxId)}</code> is offline — ` +
    "it stopped heartbeating and did not answer a direct probe."
  );
}

// The recovery: the box is back.
function backText(boxId: string): string {
  return `🟢 <code>${escapeHtml(boxId)}</code> is back.`;
}

// The message of a failure, whatever shape it came in.
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
