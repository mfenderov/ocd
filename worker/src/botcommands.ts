import type { BotCommand } from "./bot";
import {
  boxState,
  boxView,
  enrollPromptButtons,
  fleetBoard,
  nukeConfirmButtons,
  openButton,
  revokeConfirmButtons,
  stateDot,
} from "./botbuttons";
import type { RevokeResult } from "./revoke";
import type { BoxPublic } from "./boxes";
import { escapeHtml } from "./html";
import type { OwnerButtons, OwnerChat, SentMessage } from "./owner";

// The brain's command layer: one Telegram command in, one message out.
//
// The Go bot is the text of record. Every reply below is ported from
// internal/tg/fleet.go and internal/tg/tg.go — the wording, the emojis and
// the confirm prompts — so the owner reads the same bot whether it runs
// on the home box or in the Worker.
//
// The layer is a pure function of its dependencies: the Durable Object is
// never touched from here, so a command can be tested on its own.
//
// Three rules hold for every command:
//
//   1. HTML. Telegram parses these messages as HTML, so every value that
//      comes from the fleet (a box id, an error, an IP, a user agent)
//      goes through escapeHtml. One unescaped "<" makes Telegram refuse
//      the whole message.
//
//   2. No throw. Telegram retries a webhook that answers with an error,
//      so an exception that escapes this module would loop the update.
//      A failure becomes a short answer ("⚠️ Fleet failed: …"), the way
//      the Go bot's sendFleetReply turns it.
//
//   3. No silence for a typed command. A command the brain does not know
//      is answered with a pointer at /help: muscle memory for a retired
//      command must land somewhere. A tap for an unknown action stays
//      silent — the tap itself is always answered, and there is nothing
//      to say.

// AuditRow is one row of the brain's history. The shape matches the Go
// client's AuditRow so the bot's text and the console's text agree.
export interface AuditRow {
  box: string;
  at: number;
  actor: string;
  action: string;
  device: string;
  ip: string;
  result: string;
  ua: string;
  tainted: boolean;
  error?: string;
}

// A tapping client the brain saw: one IP + user-agent pair from the
// brain's own history, with its tap count and its last tap. The shape
// is the Go bot's SeenClient, read from the rows the boxes pushed.
export interface DeviceRow {
  ip: string;
  ua: string;
  count: number;
  last: number;
}

// A link the brain handed out, with the message it rides on. The brain
// owns every message, so it has to know where the link lives to edit
// that message when the link is spent or dies.
export interface LinkRecord {
  token: string;
  box: string;
  chatId: number;
  messageId: number;
}

// CommandDeps is everything the commands need: the Telegram client that
// carries the answers, the fleet state to read and the relays to call.
// The Durable Object supplies them; the layer never reaches for one.
export interface CommandDeps {
  telegram: OwnerChat;
  listBoxes: () => BoxPublic[];
  // The tap URL. The key decides the dedup: the board passes its stable
  // per-box key so re-renders reuse the live token, every tap passes
  // nothing so the box mints a fresh token per tap.
  mintLink: (boxId: string, idempotencyKey?: string) => Promise<string>;   // the tap URL
  // The pairing URL out of a tap's own answer: a server-side GET of the
  // tap URL that reads the printed link without following the redirect.
  // Following it would spend the single use in a browser the owner
  // never sees.
  resolvePair: (boxId: string, tapUrl: string) => Promise<string>;
  audit: (boxId: string, limit: number) => Promise<AuditRow[]>;
  devices: () => Promise<DeviceRow[]>;   // the tapping clients
  revoke: (boxId: string) => Promise<RevokeResult>;
  revokeAll: () => Promise<RevokeResult[]>;
  issueEnrollCode: (boxId: string) => Promise<{ code: string; command: string }>;
  boxStatus: (boxId: string) => Promise<string>;
  // The link registry: the brain records every link it hands out, with
  // the message it rides on.
  recordLink: (link: LinkRecord) => void;
  // The +Box prompt: the next message names the box. The brain arms the
  // prompt when the tap asks, and clears it when the tap is cancelled —
  // the Durable Object holds the prompt next to the fleet state.
  beginEnroll: (chatId: number) => void;
  cancelEnroll: (chatId: number) => void;
  primaryBox: string;
}

// What a command answers with: the text, and the keyboard that goes
// with it — the board under the fleet's text, the Open button under a
// minted link.
interface Reply {
  text: string;
  keyboard?: OwnerButtons;
  // The minted link this reply carries, when it carries one: the brain
  // has to find that message again to edit it when the link is spent.
  link?: { url: string; box: string };
  // An edit, not a follow-up: the reply replaces the tapped message
  // instead of saying something new. The navigation taps (the box, the
  // board, the confirms, the Cancel) edit; the content (Pair, Status,
  // History, Help, the enroll prompt, the YES results) says.
  edit?: boolean;
}

// A command handler answers with the message to send, or with nothing
// when the command has nothing to say (the Go bot stays silent in the
// same cases). A handler with nothing to wait for answers straight
// away; the caller awaits the answer either way.
type CommandHandler = (cmd: BotCommand, deps: CommandDeps) => Reply | undefined | Promise<Reply | undefined>;

// The row limit of /faudit: ten by default, thirty at most (the Go bot's
// clamp).
const AUDIT_ROWS_DEFAULT = 10;
const AUDIT_ROWS_MAX = 30;

// The dispatch table. A typed command carries its slash ("/fleet"); a tap
// carries its action ("link", "board", …) with the box id in the
// arguments. Both reach the same commands. A Map, so a name can never
// reach something that only looks like a command.
const COMMANDS = new Map<string, CommandHandler>([
  // /start prints the same list as /help: Telegram shows a Start
  // button on first contact, and it must land somewhere.
  ["/start", helpCommand],
  ["/help", helpCommand],
  ["/fleet", fleetCommand],
  ["/devices", devicesCommand],
  ["/faudit", auditCommand],
  // Typed /audit is the /faudit question, not a redirect: the tap
  // action "audit" below answers through the same handler.
  ["/audit", auditCommand],
  ["/frevoke", revokeCommand],
  // Typed /revoke is retired out loud: the tap action "revoke" below
  // still revokes one box — this answers the typed command only.
  ["/revoke", revokeRetiredCommand],
  ["/fnuke", nukeCommand],
  ["/enrollcode", enrollCodeCommand],
  ["/status", statusCommand],
  // The taps: Pair mints a pairing URL; the board's old link taps still
  // mint an Open button, so a board that sat unread keeps working. Box
  // opens the box's view; status relays that box; rask and ryes are the
  // revoke's ask and run; nuke and nukeyes are the fleet's ask and run;
  // help posts the command list; enroll arms the box-name prompt and
  // encancel clears it. The rest re-read the fleet.
  ["link", tapLinkCommand],
  ["pair", pairCommand],
  ["board", fleetCommand],
  ["revoke", revokeCommand],
  ["audit", auditCommand],
  ["box", boxCommand],
  ["status", statusTapCommand],
  ["rask", revokeAskCommand],
  ["ryes", revokeYesCommand],
  ["nuke", nukeAskCommand],
  ["nukeyes", nukeYesCommand],
  ["help", helpCommand],
  ["enroll", enrollPromptCommand],
  ["encancel", enrollCancelCommand],
]);

// runCommand answers one command. It never throws: a failure becomes a
// short answer, so Telegram never retries the update in a loop.
export async function runCommand(cmd: BotCommand, deps: CommandDeps): Promise<void> {
  // A tap is answered before the command runs. Telegram spins the
  // button until the answer comes, so a tap that takes ten seconds must
  // not leave the owner watching a spinner for ten seconds. A tap that
  // fails and a tap for an action the brain does not know are answered
  // too: an unanswered tap is a spinner that never stops.
  if (cmd.callbackId) {
    await answerTap(deps, cmd.callbackId);
  }
  const handler = COMMANDS.get(commandName(cmd.name));
  if (!handler) {
    // A typed command the brain does not know still gets an answer: a
    // pointer at /help, so retired muscle memory lands somewhere. A tap
    // for an unknown action stays silent — the tap itself was answered
    // above, and there is nothing to say.
    if (!cmd.callbackId) {
      await sendReply(cmd, { text: unknownCommandText(commandName(cmd.name)) }, deps);
    }
    return;
  }
  const reply = await commandReply(handler, cmd, deps);
  if (reply === undefined) {
    return;
  }
  const sent = await sendReply(cmd, reply, deps);
  if (!sent) {
    return;
  }
  recordReplyLink(cmd, reply, sent, deps);
}

// The handler's answer. A handler that throws becomes a short failure
// answer: the exception must not escape into the webhook, which would
// retry the update in a loop.
async function commandReply(
  handler: CommandHandler,
  cmd: BotCommand,
  deps: CommandDeps,
): Promise<Reply | undefined> {
  try {
    return await handler(cmd, deps);
  } catch (err) {
    return { text: fleetFailedText(err) };
  }
}

// The reply, sent. A tap that navigates edits the message it came
// from; everything else says something new. Telegram is down: nothing
// can be said about it, and the answer must not escape — the webhook
// would be retried forever.
async function sendReply(
  cmd: BotCommand,
  reply: Reply,
  deps: CommandDeps,
): Promise<SentMessage | undefined> {
  if (reply.edit === true && cmd.messageId !== undefined) {
    return sendEdit(cmd.chatId, cmd.messageId, reply, deps);
  }
  try {
    return await deps.telegram.say(cmd.chatId, reply.text, replyButtons(reply));
  } catch (err) {
    console.error(`bot: the reply failed (${errorText(err)})`);
    return undefined;
  }
}

// The edit: the navigation taps replace the message they came from, so
// the chat keeps one board, one view, one confirm — never a trail of
// them. A failed edit is the same as a failed reply: the webhook must
// not retry the update in a loop.
async function sendEdit(
  chatId: number,
  messageId: number,
  reply: Reply,
  deps: CommandDeps,
): Promise<SentMessage | undefined> {
  try {
    const landed = await deps.telegram.replace(chatId, messageId, reply.text, replyButtons(reply));
    if (!landed) {
      console.error("bot: the edit did not land");
      return undefined;
    }
    return { id: messageId };
  } catch (err) {
    console.error(`bot: the edit failed (${errorText(err)})`);
    return undefined;
  }
}

// The link registry: the brain has to know which message carries the
// link, so it can edit that message when the link is spent or dies.
//
// The message is already sent when this runs, so a registry that fails
// must not take the answer down with it: the link lives on. An edit
// records nothing: the message already exists, and the board and box
// views re-render their links on every Back instead of tracking them.
function recordReplyLink(
  cmd: BotCommand,
  reply: Reply,
  sent: SentMessage,
  deps: CommandDeps,
): void {
  if (!reply.link || reply.edit === true) {
    return;
  }
  const token = linkToken(reply.link.url);
  if (!token) {
    return;
  }
  try {
    deps.recordLink({ token, box: reply.link.box, chatId: cmd.chatId, messageId: sent.id });
  } catch (err) {
    console.error(`bot: the link was not recorded (${errorText(err)})`);
  }
}

// The token out of a minted tap URL: the box carries it as the "t" query
// parameter (internal/boxadmin/mint.go). A URL the brain cannot read
// carries no token, and such a link is never recorded.
function linkToken(url: string): string {
  try {
    return new URL(url).searchParams.get("t")?.trim() ?? "";
  } catch {
    return "";
  }
}

// The tap's answer. A failure to answer must not stop the reply: the
// owner would never learn what the tap did.
async function answerTap(deps: CommandDeps, callbackId: string): Promise<void> {
  try {
    await deps.telegram.answerTap(callbackId);
  } catch (err) {
    console.error(`bot: the tap was not answered (${errorText(err)})`);
  }
}

// The reply's buttons: Telegram refuses an empty keyboard, and a tap
// that navigates with no keyboard would strand the message without a
// way back. The board always carries its footer, so it never sends the
// text alone.
function replyButtons(reply: Reply): OwnerButtons | undefined {
  if (!reply.keyboard || reply.keyboard.length === 0) {
    return undefined;
  }
  return reply.keyboard;
}

// commandName strips the @botname suffix a group chat adds, so
// "/fleet@ocd_fleet_bot" reads as "/fleet" — the Go bot's NormalizeCommand.
function commandName(name: string): string {
  const at = name.indexOf("@");
  return at >= 0 ? name.slice(0, at) : name;
}

// /fleet: every enrolled box, its state and how long ago it was seen,
// with the board's buttons under it. The Open links are minted here —
// the board owns every link — one per box the clock calls online.
async function fleetCommand(_cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  return boardReply(deps);
}

// The board's reply: the fleet's text and the keyboard under it. One
// clock for both, so the text and the mint skip can never call the same
// box ok and offline. A tap edits the message it came from; a typed
// /fleet says something new.
async function boardReply(deps: CommandDeps): Promise<Reply> {
  const boxes = deps.listBoxes();
  const now = nowSec();
  return {
    text: fleetText(boxes, now),
    keyboard: fleetBoard(boxes, await mintOpenLinks(boxes, now, deps)),
    edit: true,
  };
}

// The box tap: that box's view — its state line and its actions —
// editing the board message it came from. A stale button for a box
// that is gone edits back into the board, so the message keeps
// working; a tap with no message to edit says the view instead.
async function boxCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply | undefined> {
  const box = cmd.args[0]?.trim() ?? "";
  if (!box) {
    return undefined;
  }
  const boxes = deps.listBoxes();
  const now = nowSec();
  const known = boxes.find((b) => b.id === box);
  if (!known) {
    return boardReply(deps);
  }
  const links = await mintOpenLinks([known], now, deps);
  return { text: fleetLine(known, now), keyboard: boxView(known, links.get(known.id)), edit: true };
}

// The Status tap: that box's status, relayed as a follow-up — the
// typed /status still reads the primary box.
async function statusTapCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply | undefined> {
  const box = cmd.args[0]?.trim() ?? "";
  if (!box) {
    return undefined;
  }
  const now = nowSec();
  const known = deps.listBoxes().find((b) => b.id === box);
  if (!known) {
    return { text: unknownBoxText(box) };
  }
  if (boxState(known, now) === "offline") {
    return { text: offlineText(known, now) };
  }
  return { text: statusBoxText(box, await deps.boxStatus(box)) };
}

// The Revoke button: the ask, editing the box into its confirm view.
// YES runs the existing per-box revoke; Cancel edits back to the box.
function revokeAskCommand(cmd: BotCommand): Reply | undefined {
  const box = cmd.args[0]?.trim() ?? "";
  if (!box) {
    return undefined;
  }
  return { text: revokeAskText(box), keyboard: revokeConfirmButtons(box), edit: true };
}

// The revoke's YES: the existing per-box revoke, as a follow-up.
async function revokeYesCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply | undefined> {
  const box = cmd.args[0]?.trim() ?? "";
  if (!box) {
    return undefined;
  }
  return { text: revokeText(await deps.revoke(box), box) };
}

// The Nuke button: the ask, editing the board into its confirm view.
// YES runs the existing nuke path; Cancel edits back to the board.
function nukeAskCommand(): Reply {
  return { text: nukeAskText(), keyboard: nukeConfirmButtons(), edit: true };
}

// The nuke's YES: the existing nuke path, as a follow-up.
async function nukeYesCommand(_cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  return { text: nukeText(await deps.revokeAll()) };
}

// The +Box button: the ask, as a follow-up. The prompt arms the
// box-name input; the owner's next message names the box.
function enrollPromptCommand(cmd: BotCommand, deps: CommandDeps): Reply {
  deps.beginEnroll(cmd.chatId);
  return { text: enrollPromptText(), keyboard: enrollPromptButtons() };
}

// The prompt's Cancel: the prompt is cleared, and the message says so.
function enrollCancelCommand(cmd: BotCommand, deps: CommandDeps): Reply {
  deps.cancelEnroll(cmd.chatId);
  return { text: "📦 Enrollment cancelled.", edit: true };
}

// One tap link per box the clock calls online, all at once. The board
// pre-mints with one stable key per box per window, so a re-render
// reuses the live token through the box's claim path instead of running
// another exec and leaving another idem row. A mint that fails is not
// the board's failure: the box keeps its Pair button, and the tap says
// what went wrong when asked.
//
// The window is half the tap-token TTL: a reused token always has at
// least that long left, so an Open link served from dedup never lands
// the owner on a token about to die.
const BOARD_KEY_WINDOW_SEC = 300;

// The board's idempotency key: the box, in the window the render falls
// in. The next window mints fresh, so a reused token is never older
// than one window.
export function boardIdempotencyKey(boxId: string, now: number): string {
  return `fleet-board:${boxId}:${Math.floor(now / BOARD_KEY_WINDOW_SEC)}`;
}

async function mintOpenLinks(
  boxes: BoxPublic[],
  now: number,
  deps: CommandDeps,
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  await Promise.all(
    boxes.map(async (box) => {
      if (boxState(box, now) !== "ok") {
        return;
      }
      try {
        links.set(box.id, await deps.mintLink(box.id, boardIdempotencyKey(box.id, now)));
      } catch {
        // The Pair tap says what went wrong; the board still renders.
      }
    }),
  );
  return links;
}

// The tap on a box's button: the same mint, the Go bot's callback
// wording, and the Open button that carries the link. A tap that names
// no box stays silent.
async function tapLinkCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply | undefined> {
  const box = cmd.args[0]?.trim() ?? "";
  if (!box) {
    return undefined;
  }
  const now = nowSec();
  const known = deps.listBoxes().find((b) => b.id === box);
  if (known && boxState(known, now) === "offline") {
    // An offline box cannot mint. The tap explains instead of waiting
    // for the relay to time out.
    return { text: offlineText(known, now) };
  }
  let url: string;
  try {
    // No key: every tap mints a fresh token. The tap's reply URL is
    // recorded and gets its spent edit, so sharing one token across
    // taps would edit the wrong message.
    url = await deps.mintLink(box);
  } catch (err) {
    // The Go's callback answer when the mint fails: the link failed,
    // not the fleet (internal/tg/buttons.go).
    return { text: linkFailedText(err) };
  }
  return {
    text: tapLinkText(box),
    keyboard: [[openButton(`🚀 Open ${box}`, url)]],
    link: { url, box },
  };
}

// The Pair tap: a pairing URL for one box, as copyable text. The tap
// mints at tap time, so the URL's five-minute clock starts when asked —
// not while a board sits unread. The resolve spends the tap
// server-side; the owner copies the URL out of the follow-up message
// instead of tapping it.
//
// Nothing is recorded for it: the tap is already spent when the message
// goes out, and the pairing URL is not a tap the brain can edit.
async function pairCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply | undefined> {
  const box = cmd.args[0]?.trim() ?? "";
  if (!box) {
    return undefined;
  }
  const now = nowSec();
  const known = deps.listBoxes().find((b) => b.id === box);
  if (known && boxState(known, now) === "offline") {
    // An offline box cannot mint. The tap explains instead of waiting
    // for the relay to time out.
    return { text: offlineText(known, now) };
  }
  let tapUrl: string;
  try {
    // No key: every Pair tap mints a fresh token. The resolve spends it
    // server-side, so a reused token would already be spent.
    tapUrl = await deps.mintLink(box);
  } catch (err) {
    return { text: pairFailedText(err) };
  }
  let pairingUrl: string;
  try {
    pairingUrl = await deps.resolvePair(box, tapUrl);
  } catch (err) {
    // The mint or the resolve failed, not the fleet: one line, and the
    // board keeps working.
    return { text: pairFailedText(err) };
  }
  return { text: pairReadyText(box, pairingUrl) };
}

// /start and /help: the same list. A bot with no help text is a bot
// nobody can learn, and /start is where Telegram's Start button lands.
function helpCommand(): Reply {
  return { text: helpText() };
}

// /devices: the clients that tapped in, from the brain's own history.
async function devicesCommand(_cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  const now = nowSec();
  return { text: devicesText(await deps.devices(), now) };
}

// /faudit [box] [n]: the fleet's history, newest first.
async function auditCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  const { box, limit } = auditArgs(cmd.args);
  return { text: auditText(await deps.audit(box, limit)) };
}

// /frevoke <box> YES: revoke one box. The YES is not optional — the
// credentials rotate, and the Go bot asks for the same word.
async function revokeCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  const box = cmd.args[0]?.trim() ?? "";
  if (!box || box === "YES") {
    return { text: "Usage: <code>/frevoke &lt;box&gt; YES</code>" };
  }
  if (cmd.args.length < 2 || !confirmedBy(cmd.args)) {
    return { text: revokeConfirmText(box) };
  }
  return { text: revokeText(await deps.revoke(box), box) };
}

// Typed /revoke: retired out loud. The Go bot's /revoke killed sessions;
// /fnuke rotates credentials instead. Silence would leave the owner's
// muscle memory talking to nothing.
function revokeRetiredCommand(): Reply {
  return { text: revokeRetiredText() };
}

// /fnuke YES: revoke every box.
async function nukeCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  if (cmd.args.length !== 1 || !confirmedBy(cmd.args)) {
    return { text: nukeConfirmText() };
  }
  return { text: nukeText(await deps.revokeAll()) };
}

// /enrollcode <box>: a one-time code for a new box. The code is shown in
// the owner-only chat, and that display is the approval.
async function enrollCodeCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  const box = cmd.args[0]?.trim() ?? "";
  if (!isValidBoxId(box)) {
    return { text: "Usage: <code>/enrollcode &lt;box&gt;</code>" };
  }
  const { command } = await deps.issueEnrollCode(box);
  return { text: enrollCodeText(box, command) };
}

// /status: the primary box's OpenCode service status, relayed.
async function statusCommand(_cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  return { text: statusText(await deps.boxStatus(deps.primaryBox)) };
}

// The trailing YES that confirms a destructive command.
function confirmedBy(args: string[]): boolean {
  return args[args.length - 1] === "YES";
}

// /faudit [box] [n]: the number is the limit, the other word is the box.
function auditArgs(args: string[]): { box: string; limit: number } {
  let box = "";
  let limit = 0;
  for (const arg of args) {
    if (/^\d+$/.test(arg)) {
      limit = Number(arg);
    } else if (box === "") {
      box = arg;
    }
  }
  return { box, limit: auditLimit(limit) };
}

// The row limit: ten by default, thirty at most (the Go bot's clamp).
function auditLimit(limit: number): number {
  if (limit <= 0) {
    return AUDIT_ROWS_DEFAULT;
  }
  return Math.min(limit, AUDIT_ROWS_MAX);
}

// A box id the fleet accepts: 1-32 chars, lowercase alphanumerics and
// dashes, never leading or trailing with a dash (the Go bot's
// onboard.ValidateBoxID).
function isValidBoxId(id: string): boolean {
  if (id.length < 1 || id.length > 32) {
    return false;
  }
  if (!/^[a-z0-9-]+$/.test(id)) {
    return false;
  }
  return !id.startsWith("-") && !id.endsWith("-");
}

// The board, ported from the Go bot's FleetStatusText.
function fleetText(boxes: BoxPublic[], now: number): string {
  if (boxes.length === 0) {
    return "📭 <b>No boxes enrolled.</b>";
  }
  const lines = [`🖥 <b>Fleet</b> (${boxes.length})`];
  for (const b of boxes) {
    lines.push(fleetLine(b, now));
  }
  return lines.join("\n");
}

// One box's line: its state, how long ago it was seen, its epoch. The
// box view prints this same line, so the view and the board agree.
function fleetLine(b: BoxPublic, now: number): string {
  const state = boxState(b, now);
  const dot = stateDot(state);
  return `${dot} <code>${escapeHtml(b.id)}</code> · ${state} · synced ${escapeHtml(fmtAgo(now - b.last_seen))} · epoch ${b.epoch}`;
}

// The age of a last-seen timestamp, in the words the fleet list reads:
// "never", "just now", "5m ago", "3h ago", "2d ago".
function fmtAgo(seconds: number): string {
  if (seconds < 0) {
    return "never";
  }
  if (seconds < 90) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86400)}d ago`;
}

// The failure answer, the Go bot's sendFleetReply.
function fleetFailedText(err: unknown): string {
  return `⚠️ <b>Fleet failed:</b> ${escapeHtml(errorText(err))}`;
}

// The answer for a command the brain does not know: what was typed and
// where the list lives. Retired muscle memory (/link, /flink, /login)
// lands here too — a pointer, not silence.
function unknownCommandText(name: string): string {
  return `❓ <code>${escapeHtml(name)}</code> is not a command — see <code>/help</code> for what the fleet bot can do.`;
}

// The failed link, the Go bot's callback answer: "⚠️ <b>Link failed:</b> …"
// (internal/tg/buttons.go). The fleet is fine; the link is not.
function linkFailedText(err: unknown): string {
  return `⚠️ <b>Link failed:</b> ${escapeHtml(errorText(err))}`;
}

// The failed Pair tap: the mint or the resolve failed, not the fleet.
// One line, and the board keeps working.
function pairFailedText(err: unknown): string {
  return `⚠️ <b>Pair failed:</b> ${escapeHtml(errorText(err))}`;
}

// The tapped box, the Go bot's callback answer. The link itself rides
// the Open button, so the one-time URL never shows as text.
function tapLinkText(box: string): string {
  return `🔗 <b>${escapeHtml(box)}</b> ready — one tap:`;
}

// The offline box: the tap explains instead of failing. The words are
// the Go's: the box's id, its state and how long ago it was seen.
function offlineText(box: BoxPublic, now: number): string {
  return (
    `🔴 <b>${escapeHtml(box.id)}</b> is offline — synced ${escapeHtml(fmtAgo(now - box.last_seen))}. ` +
    "It cannot mint a link until it checks in again."
  );
}

// The pairing URL: copyable text in a <code> block, never a button or
// a bare link — a stray tap would spend the single use before opencode
// ever sees it. Single use, good for five minutes from this tap.
function pairReadyText(box: string, pairingUrl: string): string {
  return (
    `🔑 <b>${escapeHtml(box)}</b> pairing link — single use, good for 5 minutes:\n` +
    `<code>${escapeHtml(pairingUrl)}</code>\n` +
    "Open it within 5 minutes — the first opener wins."
  );
}

// The command list, in one place: /start and /help print the same
// text. One line per command: what it does, nothing more.
function helpText(): string {
  return [
    "🤖 <b>Fleet bot</b> — what each command does:",
    "/start — this list",
    "/help — this list",
    "/fleet — every box, its state and last sync, with Open and Pair buttons",
    "Open links expire — a fresh /fleet mints new ones",
    "/devices — the clients that tapped in",
    "/faudit [box] [n] — the fleet's history, newest first",
    "/audit [box] [n] — the same history",
    "/frevoke &lt;box&gt; YES — revoke one box",
    "/revoke — retired; /fnuke YES is the fleet-wide equivalent",
    "/fnuke YES — revoke every box",
    "/enrollcode &lt;box&gt; — a one-time code for a new box",
    "/status — the primary box's service status",
  ].join("\n");
}

// The tapping clients, the Go bot's sendDevices: each client with its
// tap count and how long ago it was last seen, newest first.
function devicesText(clients: DeviceRow[], now: number): string {
  if (clients.length === 0) {
    return "📭 <b>No taps yet.</b>";
  }
  const lines = ["📱 <b>Seen clients</b>"];
  for (const client of clients) {
    lines.push(
      `• <code>${escapeHtml(client.ip)}</code> · ${client.count} taps · ${escapeHtml(fmtAgo(now - client.last))}`,
    );
    if (client.ua !== "") {
      lines.push(`<code>${escapeHtml(client.ua)}</code>`);
    }
  }
  return lines.join("\n");
}

// The history, the Go bot's FleetAuditText.
function auditText(rows: AuditRow[]): string {
  if (rows.length === 0) {
    return "📭 <b>No audit rows.</b>";
  }
  const lines = [`📋 <b>Audit</b> (${rows.length})`];
  for (const row of rows) {
    if (row.error) {
      lines.push(`• <code>${escapeHtml(row.box)}</code> · error: ${escapeHtml(row.error)}`);
      continue;
    }
    lines.push(`• ${escapeHtml(row.action)} · ${escapeHtml(row.actor)} @ <code>${escapeHtml(row.box)}</code>`);
    lines.push(
      `  <i>${escapeHtml(auditTime(row.at))} · ${escapeHtml(row.result)} · ${escapeHtml(row.device)} ${escapeHtml(row.ip)}</i>`,
    );
    if (row.tainted) {
      lines.push("  ⚠️ revoke pending");
    }
  }
  return lines.join("\n");
}

// The month names of the audit timestamps, the Go bot's time format.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// When a row happened, the Go bot's "Jan 2 15:04" in UTC.
function auditTime(at: number): string {
  const when = new Date(at * 1000);
  const hh = String(when.getUTCHours()).padStart(2, "0");
  const mm = String(when.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[when.getUTCMonth()]} ${when.getUTCDate()} ${hh}:${mm}`;
}

// The revoke outcome, the Go bot's FleetRevokeText.
function revokeText(result: RevokeResult, box: string): string {
  const epoch = result.epoch ?? 0;
  if (result.status === "revoked") {
    return `💀 <code>${escapeHtml(box)}</code> revoked at epoch ${epoch}.`;
  }
  if (result.status === "tombstoned") {
    return blockedText(box, epoch, result.detail);
  }
  return `⚠️ revoke: ${escapeHtml(result.status)}`;
}

// The blocked box: the credentials rotate, so no new link until the box
// comes back. The detail says why, when the revoke had one to give.
function blockedText(box: string, epoch: number, detail?: string): string {
  const blocked = `⛔ <code>${escapeHtml(box)}</code> blocked at epoch ${epoch} — no new links until it returns.`;
  if (!detail) {
    return blocked;
  }
  return `${blocked}\n<i>${escapeHtml(detail)}</i>`;
}

// The retired command: what happened to it and where to go instead.
// The old /revoke killed sessions; /fnuke rotates credentials —
// that is the difference, in one clause.
function revokeRetiredText(): string {
  return (
    "⚠️ <code>/revoke</code> is retired — it killed sessions on one box. " +
    "The fleet-wide equivalent is <code>/fnuke YES</code>, which rotates credentials on every box."
  );
}

// The revoke prompt: the credentials rotate, so the owner confirms.
function revokeConfirmText(box: string): string {
  return `☠️ <b>Revoke box ${escapeHtml(box)}?</b> Its credentials rotate.\nConfirm: <code>/frevoke ${escapeHtml(box)} YES</code>`;
}

// The revoke's ask on a button: the same question, without the typing —
// YES and Cancel ride under it.
function revokeAskText(box: string): string {
  return `☠️ <b>Revoke box ${escapeHtml(box)}?</b> Its credentials rotate.`;
}

// The nuke outcome, the Go bot's FleetNukeText.
function nukeText(results: RevokeResult[]): string {
  let revoked = 0;
  let blocked = 0;
  const lines: string[] = [];
  for (const result of results) {
    if (result.status === "revoked") {
      revoked += 1;
    }
    if (result.status === "tombstoned") {
      blocked += 1;
    }
    const line = `• <code>${escapeHtml(result.id)}</code>: ${escapeHtml(result.status)}`;
    lines.push(result.detail ? `${line} — ${escapeHtml(result.detail)}` : line);
  }
  return `💀 nuke: ${revoked} revoked, ${blocked} blocked\n${lines.join("\n")}`;
}

// The nuke prompt: every box re-enrolls, so the owner confirms.
function nukeConfirmText(): string {
  return "☠️ <b>Nuke the whole fleet?</b> Every box re-enrolls.\nConfirm: <code>/fnuke YES</code>";
}

// The nuke's ask on a button: the same question, without the typing —
// YES and Cancel ride under it.
function nukeAskText(): string {
  return "☠️ <b>Nuke the whole fleet?</b> Every box re-enrolls.";
}

// The +Box prompt: the ask for the new box's name. The owner's next
// message names it.
function enrollPromptText(): string {
  return "📦 Send me the box name — the next message names the box.";
}

// The enroll code, the Go bot's FleetEnrollCodeText.
function enrollCodeText(box: string, command: string): string {
  return (
    `🔑 Enroll code for <code>${escapeHtml(box)}</code> (15 min, single use):\n\n` +
    `<code>${escapeHtml(command)}</code>\n\n` +
    "Paste it into a terminal on that machine — it enrolls itself."
  );
}

// The status of one box, the box view's relay. The typed /status
// prints the primary box's bare line; the tap names the box it relays.
function statusBoxText(box: string, status: string): string {
  return `📊 <b>Status ${escapeHtml(box)}</b>\n• <code>${escapeHtml(status.trim())}</code>`;
}

// A button for a box that is gone: the fleet moved on, and the board
// has the live list.
function unknownBoxText(box: string): string {
  return `⚠️ Unknown box <code>${escapeHtml(box)}</code> — send /fleet for the live board.`;
}

// The status, the Go bot's /status answer. The box reports one line, so
// the brain relays that line instead of splitting it into fields it
// would have to parse. The line is trimmed here: the box's status ends
// would have to parse. The line is trimmed here: the box's status ends
// in a newline, and a newline inside the <code> block ends the block —
// the closing tag would land in the owner's chat as plain text.
function statusText(status: string): string {
  return `📊 <b>Status</b>\n• <code>${escapeHtml(status.trim())}</code>`;
}

// The message of a failure, whatever shape it came in.
function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// The brain's clock: Unix seconds, like the DO's other timestamps.
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
