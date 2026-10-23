import type { BoxPublic } from "./boxes";
import type { OwnerButton, OwnerButtons } from "./owner";

// The brain's inline keyboards: the buttons the owner taps.
//
// The board is the fleet's front door: one row per box, an Open button
// carrying the box's tap link, a Pair button asking for the pairing
// URL, and the box itself opening that box's view. Each box's actions
// stay in its own row, so the fleet reads the same with two boxes or
// ten. The footer's row carries the global actions: History, Box, Nuke
// and Help.
//
// A box's view edits the board message into that box's actions: its
// Open and Pair buttons, its Status and Revoke buttons, and the Back
// button that edits the board back. The confirms edit the view again:
// YES runs, Cancel edits back.
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

// The box button: a tap for this box's view. It rides last in the
// box's board row, so the Open and Pair buttons keep their places.
export function boxButton(boxId: string): OwnerButton {
  return { label: buttonLabel(`📦 ${boxId}`), tap: callbackData("box", boxId) };
}

// The Status button: a tap for this box's status relay. The answer
// arrives as a follow-up message, like the Pair tap's.
function statusButton(boxId: string): OwnerButton {
  return { label: buttonLabel(`📊 Status ${boxId}`), tap: callbackData("status", boxId) };
}

// The Revoke button: a tap edits the box into its revoke confirm. The
// credentials rotate, so the owner confirms.
function revokeAskButton(boxId: string): OwnerButton {
  return { label: buttonLabel(`🗑 Revoke ${boxId}`), tap: callbackData("rask", boxId) };
}

// The Back button: a tap edits the box back into the board. The board
// is never stranded on a box.
export function backButton(): OwnerButton {
  return { label: "‹ Back", tap: callbackData("board", "") };
}

// The History button: a tap posts the fleet's recent audit as a
// follow-up message — the same content as the /faudit default.
function historyButton(): OwnerButton {
  return { label: "🕘 History", tap: callbackData("audit", "") };
}

// The Box button: a tap asks for the new box's name. The owner's next
// message names it.
function addBoxButton(): OwnerButton {
  return { label: "＋ Box", tap: callbackData("enroll", "") };
}

// The Nuke button: a tap edits the board into the nuke confirm. Every
// box re-enrolls, so the owner confirms.
function nukeButton(): OwnerButton {
  return { label: "☠️ Nuke", tap: callbackData("nuke", "") };
}

// The Help button: a tap posts the /help text as a follow-up message.
function helpButton(): OwnerButton {
  return { label: "❓ Help", tap: callbackData("help", "") };
}

// The actions a button can carry: the brain's taps. Open is a tap
// link's URL button and reaches no command; Pair mints a tap and reads
// the pairing URL out of its answer; box opens the box's view; status
// relays that box's status; rask and ryes are the revoke's confirm and
// run; nuke and nukeyes are the fleet's confirm and run; help posts the
// command list; enroll and encancel arm and clear the box-name prompt;
// the rest re-read the fleet.
export type Action =
  | "link"
  | "pair"
  | "revoke"
  | "audit"
  | "board"
  | "box"
  | "status"
  | "rask"
  | "ryes"
  | "nuke"
  | "nukeyes"
  | "help"
  | "enroll"
  | "encancel";

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

// The fleet board: one row per box, then the footer's row. The Open
// button carries the tap link the caller minted for the box; a box with
// no link — offline, or its mint failed — keeps its Pair button, and
// the tap explains instead of minting blind. Every row ends in the box
// itself, opening that box's view.
//
// The Open links come from the caller: the board cannot mint, so the
// caller hands over what it minted. The caller skips the boxes its own
// clock calls offline, so no link is minted for a box that cannot tap.
export function fleetBoard(boxes: BoxPublic[], openLinks: Map<string, string>): OwnerButtons {
  return [...boxes.map((box) => boxRow(box, openLinks.get(box.id))), boardFooterRow()];
}

// The footer's row: the global actions. It rides even when no box is
// enrolled — +Box is how the first box gets in.
function boardFooterRow(): OwnerButton[] {
  return [historyButton(), addBoxButton(), nukeButton(), helpButton()];
}

// The board's footer, on its own: the keyboard a follow-up board would
// carry. The board builder above inlines the row; this names it for
// the tests.
export function boardFooter(): OwnerButtons {
  return [boardFooterRow()];
}

// One box's row: the Open button when the caller minted a link for it,
// always the Pair button, and the box itself last.
function boxRow(box: BoxPublic, link: string | undefined): OwnerButton[] {
  if (link === undefined) {
    return [pairButton(box.id), boxButton(box.id)];
  }
  return [openButton(buttonLabel(`🚀 Open ${box.id}`), link), pairButton(box.id), boxButton(box.id)];
}

// One box's view: the box's own row as on the board, its Status and
// Revoke buttons, and the Back button that edits the board back.
export function boxView(box: BoxPublic, link: string | undefined): OwnerButtons {
  const first = link === undefined ? [pairButton(box.id)] : [openButton(buttonLabel(`🚀 Open ${box.id}`), link), pairButton(box.id)];
  return [first, [statusButton(box.id), revokeAskButton(box.id)], [backButton()]];
}

// The revoke confirm: YES runs the per-box revoke, Cancel edits back
// to the box it was asked from.
export function revokeConfirmButtons(boxId: string): OwnerButtons {
  return [
    [
      { label: "YES", tap: callbackData("ryes", boxId) },
      { label: "Cancel", tap: callbackData("box", boxId) },
    ],
  ];
}

// The nuke confirm: YES revokes every box, Cancel edits back to the
// board it was asked from.
export function nukeConfirmButtons(): OwnerButtons {
  return [
    [
      { label: "YES", tap: callbackData("nukeyes", "") },
      { label: "Cancel", tap: callbackData("board", "") },
    ],
  ];
}

// The enroll prompt's keyboard: the one way out before the name.
export function enrollPromptButtons(): OwnerButtons {
  return [[{ label: "Cancel", tap: callbackData("encancel", "") }]];
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
