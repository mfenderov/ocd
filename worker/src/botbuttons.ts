import type { BoxPublic } from "./boxes";
import type { OwnerButton, OwnerButtons } from "./owner";

// The brain's inline keyboards: the buttons the owner taps.
//
// The board is the fleet's front door: one row per box, an Open button
// carrying the box's tap link and a Pair button asking for the pairing
// URL. Each box's actions stay in its own row, so the fleet reads the
// same with two boxes or ten.
//
// The payload is "<action>:<boxId>". The tap link rides the Open
// button as its target, never as visible text; the Pair tap names the
// box to mint for at tap time.
//
// The buttons are the owner's chat's buttons (owner.ts): a label and
// what the tap does. The Bot API's own spelling of a button belongs to
// the adapter that speaks it.

// The Open button: the tap link travels as the target, never as visible
// text. The board's button and the tap reply's button share the label,
// so one box reads the same everywhere.
export function openButton(label: string, link: string): OwnerButton {
  return { label, link };
}

// The Pair button: a tap for this box's pairing URL. The URL itself is
// minted at tap time and arrives as a follow-up message, so its
// five-minute clock starts when asked — not while a board sits unread.
export function pairButton(boxId: string): OwnerButton {
  return { label: buttonLabel(`🔑 Pair ${boxId}`), tap: callbackData("pair", boxId) };
}

// The actions a button can carry: the brain's five taps. Open is a tap
// link's URL button and reaches no command; Pair mints a tap and reads
// the pairing URL out of its answer; the rest re-read the fleet.
export type Action = "link" | "pair" | "revoke" | "audit" | "board";

// How long a box may go without a heartbeat before the board calls it
// offline: three missed beats at the 30 second fleet heartbeat.
const OFFLINE_AFTER_SEC = 90;

// The label of one button is at most this long. The Go's boxKey "caps
// the button label length Telegram renders well" (internal/tg/buttons.go).
// The Go counts bytes and the brain counts characters, so a full-length
// id shows two characters more here.
const LABEL_MAX = 32;

// The state of one box: tombstoned wins over staleness, then a box
// quieter than the offline threshold reads offline (the Go's
// fleet.BoxState — offline only *exceeds* the threshold). The threshold
// lives above: the fleet's text and the Pair tap's offline check read
// the same rule, so a box the board calls offline is never minted for.
export function boxState(box: BoxPublic, now: number): string {
  if (box.tombstoned) {
    return "tombstoned";
  }
  if (now - box.last_seen <= OFFLINE_AFTER_SEC) {
    return "ok";
  }
  return "offline";
}

// The dot of a state: the fleet's text leads with it.
export function stateDot(state: string): string {
  if (state === "ok") {
    return "🟢";
  }
  if (state === "offline") {
    return "🔴";
  }
  return "🟠";
}

// The fleet board: one row per box. The Open button carries the tap
// link the caller minted for the box; a box with no link — offline, or
// its mint failed — keeps its Pair button, and the tap explains instead
// of minting blind.
//
// The Open links come from the caller: the board cannot mint, so the
// caller hands over what it minted. The caller skips the boxes its own
// clock calls offline, so no link is minted for a box that cannot tap.
export function fleetBoard(boxes: BoxPublic[], openLinks: Map<string, string>): OwnerButtons {
  return boxes.map((box) => boxRow(box, openLinks.get(box.id)));
}

// One box's row: the Open button when the caller minted a link for it,
// and always the Pair button.
function boxRow(box: BoxPublic, link: string | undefined): OwnerButton[] {
  if (link === undefined) {
    return [pairButton(box.id)];
  }
  return [openButton(buttonLabel(`🚀 Open ${box.id}`), link), pairButton(box.id)];
}

// The payload of a button: "<action>:<boxId>".
export function callbackData(action: Action, boxId: string): string {
  return `${action}:${boxId}`;
}

// The reader of that payload. It reads the shape, not the vocabulary: a
// tap for an action the brain does not know is still a tap, and the
// command layer answers it.
export function parseCallback(data: string): { action: string; boxId: string } | null {
  const at = data.indexOf(":");
  const action = (at < 0 ? data : data.slice(0, at)).trim();
  const boxId = at < 0 ? "" : data.slice(at + 1).trim();
  if (!action) {
    return null;
  }
  return { action, boxId };
}

// The label of one button: capped at what Telegram renders well.
function buttonLabel(label: string): string {
  return label.length > LABEL_MAX ? label.slice(0, LABEL_MAX) : label;
}
