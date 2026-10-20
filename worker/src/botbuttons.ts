import { OFFLINE_AFTER_SEC } from "./liveness";
import type { BoxPublic } from "./state";

// The brain's inline keyboards: the buttons the owner taps.
//
// The Go bot is the text of record (internal/tg/buttons.go): the fleet
// board carries one button per box, labeled with the box's state, and
// the button's payload names the box it acts on. The brain keeps the
// labels and the layout. One thing changes: the payload is
// "<action>:<boxId>" instead of the Go's "flink:<boxId>", because the
// brain's buttons ask for more than a link.

// A button that runs a command when it is tapped.
export interface InlineButton {
  text: string;
  callback_data: string;
}

// A button that opens a link: the Go's openButton. The one-time link
// travels as the target, never as visible text.
export interface UrlButton {
  text: string;
  url: string;
}

// One keyboard: rows of buttons.
export type Button = InlineButton | UrlButton;
export type Keyboard = Button[][];

// The actions a button can carry: the brain's four taps. Mint a link,
// show the board, revoke a box, read a box's history.
export type Action = "link" | "revoke" | "audit" | "board";

// The label of a button is at most this long. The Go's boxKey "caps the
// button label length Telegram renders well" (internal/tg/buttons.go).
// The Go counts bytes and the brain counts characters, so a full-length
// id shows two characters more here.
const LABEL_MAX = 32;

// The state of one box: tombstoned wins over staleness, then a box
// quieter than the offline threshold reads offline (the Go's
// fleet.BoxState — offline only *exceeds* the threshold). The threshold
// itself lives in liveness.ts: the board's label, the fleet's text and
// the brain's liveness sweep must agree on a box's state.
export function boxState(box: BoxPublic, now: number): string {
  if (box.tombstoned) {
    return "tombstoned";
  }
  if (now - box.last_seen <= OFFLINE_AFTER_SEC) {
    return "ok";
  }
  return "offline";
}

// The dot of a state: the Go's board and its text both lead with it.
export function stateDot(state: string): string {
  if (state === "ok") {
    return "🟢";
  }
  if (state === "offline") {
    return "🔴";
  }
  return "🟠";
}

// The fleet board: one button per box, in one row — the Go's boxButton.
// The label carries the box's state, so the owner sees at a glance which
// machine is up; the payload asks for a link for that box, the way the
// Go's "flink:" button did.
//
// The clock comes from the caller: the board's label and the fleet's
// text must read the same second, or they can call one box ok and the
// other offline.
export function fleetBoard(boxes: BoxPublic[], now: number): InlineButton[][] {
  if (boxes.length === 0) {
    return [];
  }
  const row = boxes.map((box) => ({
    text: boxLabel(box, now),
    callback_data: callbackData("link", box.id),
  }));
  return [row];
}

// The link menu: the boxes the owner picks a machine from. The Go bot
// sends one keyboard for /fleet and /link — "/link is the menu: which
// machine do you want to work in?" (internal/tg/tg.go) — so the menu and
// the board are the same buttons.
export function linkMenu(boxes: BoxPublic[], now: number): InlineButton[][] {
  return fleetBoard(boxes, now);
}

// The Open button: the Go's openButton.
export function openButton(text: string, url: string): UrlButton {
  return { text, url };
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

// The label of one box: its state and its id.
function boxLabel(box: BoxPublic, now: number): string {
  const label = `${stateDot(boxState(box, now))} ${box.id}`;
  return label.length > LABEL_MAX ? label.slice(0, LABEL_MAX) : label;
}
