import { escapeHtml, type TelegramClient } from "./telegram";
import type { BoxPublic } from "./state";

// The liveness sweep: the brain notices a box that stopped talking.
//
// Three rules hold:
//
//   1. The sweep never guesses. A box that heartbeated recently is
//      silent, and a box that went quiet is probed directly before the
//      owner is told anything. The probe is the brain's own request to
//      the box, so a broken heartbeat does not make the owner think the
//      machine is gone.
//
//   2. One notice per outage. The owner is told once that a box went
//      dark, and never again while it stays dark.
//
//   3. One recovery per outage. When the box answers again — by
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
  telegram: TelegramClient;
  // The chat the notice goes to: the owner's, and only the owner's. The
  // brain talks to one chat, so the sweep names it here.
  ownerChatId: number;
  probePresence: (boxId: string) => Promise<boolean>;   // true = the box answered
  nowSec: () => number;
  offlineAfterSec: number;
}

// The sweep: every box, one pass.
export async function sweepLiveness(store: LivenessStore, deps: LivenessDeps): Promise<void> {
  const now = deps.nowSec();
  for (const box of store.listBoxes()) {
    if (now - box.last_seen <= deps.offlineAfterSec) {
      // The box is talking again: the owner was told it went dark, so
      // the owner is told it is back.
      await announceRecovery(store, deps, box.id);
      continue;
    }
    if (await probe(deps, box.id)) {
      // The box answered the probe: it is alive, even though its
      // heartbeat stopped.
      await announceRecovery(store, deps, box.id);
      continue;
    }
    await announceOffline(store, deps, box.id);
  }
}

// The probe: did the box answer? A probe that fails is a box that did
// not answer — the relay catches its own failures, and a throw here
// means the same thing.
async function probe(deps: LivenessDeps, boxId: string): Promise<boolean> {
  try {
    return await deps.probePresence(boxId);
  } catch (err) {
    console.error(`liveness: the probe failed (${errorText(err)})`);
    return false;
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
    await deps.telegram.sendMessage(deps.ownerChatId, text);
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
