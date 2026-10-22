import type { BotCommand } from "./bot";
import {
  boxState,
  fleetBoard,
  linkMenu,
  openButton,
  stateDot,
  type InlineButton,
  type Keyboard,
} from "./botbuttons";
import type { RevokeResult } from "./revoke";
import type { BoxPublic } from "./boxes";
import { escapeHtml } from "./html";
import type { TelegramClient } from "./ports";

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
//   3. Silence for what it does not know. An unknown command gets no
//      reply at all: a typo must not make noise. A tap is different: it
//      is always answered, or the owner's button spins forever.

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
  telegram: TelegramClient;
  listBoxes: () => BoxPublic[];
  mintLink: (boxId: string) => Promise<string>;   // the tap URL
  audit: (boxId: string, limit: number) => Promise<AuditRow[]>;
  revoke: (boxId: string) => Promise<RevokeResult>;
  revokeAll: () => Promise<RevokeResult[]>;
  issueEnrollCode: (boxId: string) => Promise<{ code: string; command: string }>;
  boxStatus: (boxId: string) => Promise<string>;
  // The link registry: the brain records every link it hands out, with
  // the message it rides on.
  recordLink: (link: LinkRecord) => void;
  primaryBox: string;
}

// What a command answers with: the text, and the keyboard that goes
// with it — the board under the fleet's text, the Open button under a
// minted link.
interface Reply {
  text: string;
  keyboard?: Keyboard;
  // The minted link this reply carries, when it carries one: the brain
  // has to find that message again to edit it when the link is spent.
  link?: { url: string; box: string };
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
  ["/fleet", fleetCommand],
  // The Go bot sends one board for /fleet and /link — "/link is the
  // menu: which machine do you want to work in?" (internal/tg/tg.go) —
  // so the two views carry the same buttons.
  ["/link", linkCommand],
  ["/flink", flinkCommand],
  ["/login", loginCommand],
  ["/faudit", auditCommand],
  ["/frevoke", revokeCommand],
  ["/fnuke", nukeCommand],
  ["/enrollcode", enrollCodeCommand],
  ["/status", statusCommand],
  // The taps: the same commands, reached by a button.
  ["link", tapLinkCommand],
  ["board", fleetCommand],
  ["revoke", revokeCommand],
  ["audit", auditCommand],
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
    // An unknown command is ignored: no reply at all.
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

// The reply, sent. Telegram is down: nothing can be said about it, and
// the answer must not escape — the webhook would be retried forever.
async function sendReply(
  cmd: BotCommand,
  reply: Reply,
  deps: CommandDeps,
): Promise<{ message_id: number } | undefined> {
  try {
    return await deps.telegram.sendMessage(cmd.chatId, reply.text, replyOptions(reply));
  } catch (err) {
    console.error(`bot: the reply failed (${errorText(err)})`);
    return undefined;
  }
}

// The link registry: the brain has to know which message carries the
// link, so it can edit that message when the link is spent or dies.
//
// The message is already sent when this runs, so a registry that fails
// must not take the answer down with it: the link lives on.
function recordReplyLink(
  cmd: BotCommand,
  reply: Reply,
  sent: { message_id: number },
  deps: CommandDeps,
): void {
  if (!reply.link) {
    return;
  }
  const token = linkToken(reply.link.url);
  if (!token) {
    return;
  }
  try {
    deps.recordLink({ token, box: reply.link.box, chatId: cmd.chatId, messageId: sent.message_id });
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
    await deps.telegram.answerCallbackQuery(callbackId);
  } catch (err) {
    console.error(`bot: the tap was not answered (${errorText(err)})`);
  }
}

// The reply's markup: Telegram refuses an empty keyboard, so a fleet
// with no boxes sends the text alone.
function replyOptions(reply: Reply): { replyMarkup?: unknown } {
  if (!reply.keyboard || reply.keyboard.length === 0) {
    return {};
  }
  return { replyMarkup: { inline_keyboard: reply.keyboard } };
}

// commandName strips the @botname suffix a group chat adds, so
// "/fleet@ocd_fleet_bot" reads as "/fleet" — the Go bot's NormalizeCommand.
function commandName(name: string): string {
  const at = name.indexOf("@");
  return at >= 0 ? name.slice(0, at) : name;
}

// /fleet: every enrolled box, its state and how long ago it was seen,
// with the board's buttons under it.
function fleetCommand(_cmd: BotCommand, deps: CommandDeps): Reply {
  return boardReply(fleetBoard, deps);
}

// /link: the menu of boxes the owner picks a machine from. The Go bot
// sends the same board for /fleet and /link, so the menu and the board
// are the same buttons.
function linkCommand(_cmd: BotCommand, deps: CommandDeps): Reply {
  return boardReply(linkMenu, deps);
}

// The board's reply: the fleet's text and the keyboard under it. One
// clock for both, so the label and the text can never call the same box
// ok and offline.
function boardReply(board: (boxes: BoxPublic[], now: number) => InlineButton[][], deps: CommandDeps): Reply {
  const boxes = deps.listBoxes();
  const now = nowSec();
  return { text: fleetText(boxes, now), keyboard: board(boxes, now) };
}

// /flink <box>: a tap URL for one box. The URL is single-use; it travels
// as a link target, never as visible text.
async function flinkCommand(cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  const box = cmd.args[0]?.trim() ?? "";
  if (!box) {
    return { text: "Usage: <code>/flink &lt;box&gt;</code>" };
  }
  const url = await deps.mintLink(box);
  return { text: linkText(url, box), link: { url, box } };
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

// /login: the primary box, one tap.
async function loginCommand(_cmd: BotCommand, deps: CommandDeps): Promise<Reply> {
  const url = await deps.mintLink(deps.primaryBox);
  return { text: loginText(url), link: { url, box: deps.primaryBox } };
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
    const state = boxState(b, now);
    const dot = stateDot(state);
    lines.push(
      `${dot} <code>${escapeHtml(b.id)}</code> · ${state} · synced ${escapeHtml(fmtAgo(now - b.last_seen))} · epoch ${b.epoch}`,
    );
  }
  return lines.join("\n");
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

// The failed link, the Go bot's callback answer: "⚠️ <b>Link failed:</b> …"
// (internal/tg/buttons.go). The fleet is fine; the link is not.
function linkFailedText(err: unknown): string {
  return `⚠️ <b>Link failed:</b> ${escapeHtml(errorText(err))}`;
}

// The tap link, the Go bot's FleetLinkText.
function linkText(url: string, box: string): string {
  return `🔑 <a href="${escapeHtml(url)}">Tap to log in to <code>${escapeHtml(box)}</code></a>`;
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

// The primary box's link, the Go bot's /login answer. The brain does not
// state a duration: the box decides when a link dies, and the brain must
// not repeat the box's TTL as its own.
function loginText(url: string): string {
  return `🔑 <b>OpenCode ready</b> — one tap · single use\n<a href="${escapeHtml(url)}">🚀 Open OpenCode</a>`;
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

// The revoke prompt: the credentials rotate, so the owner confirms.
function revokeConfirmText(box: string): string {
  return `☠️ <b>Revoke box ${escapeHtml(box)}?</b> Its credentials rotate.\nConfirm: <code>/frevoke ${escapeHtml(box)} YES</code>`;
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

// The enroll code, the Go bot's FleetEnrollCodeText.
function enrollCodeText(box: string, command: string): string {
  return (
    `🔑 Enroll code for <code>${escapeHtml(box)}</code> (15 min, single use):\n\n` +
    `<code>${escapeHtml(command)}</code>\n\n` +
    "Paste it into a terminal on that machine — it enrolls itself."
  );
}

// The status, the Go bot's /status answer. The box reports one line, so
// the brain relays that line instead of splitting it into fields it
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
