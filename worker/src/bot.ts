import { parseCallback } from "./botbuttons";
import { hashToken, tokenMatches } from "./heartbeat";
import type { OwnerChat } from "./owner";

// The header Telegram sends the secret token in. It is the only
// credential the webhook carries: the route path holds none.
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

// The brain's front door: one Telegram update in, one command out.
//
// Two rules run before any command:
//
//   1. The gate — the brain talks to exactly one chat, the owner's. In a
//      DM the chat id IS the user id, so the chat id is the sender
//      check. A group message carries another chat id and is dropped
//      here, silently, before any command runs.
//
//   2. The dedup — Telegram retries a webhook it thinks failed. The
//      brain records the update ids it handled, so a retried /fleet
//      cannot mint two boards' links.
//
// The router answers one thing itself: a tap it drops. Telegram spins
// the button until the answer comes, so a tap the brain cannot act on —
// and a retried update the dedup drops — still gets its callback
// answered. Every other reply comes from the command layer.

export interface BotUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id?: number; type?: string }; from?: { id?: number } };
  callback_query?: { id?: string; data?: string; message?: { chat?: { id?: number }; message_id?: number } };
}

// The brain's memory of what it handled. seenUpdate is true while the
// update is new and turns false once the update is recorded — the
// caller must not run the command twice.
export interface BotStore {
  seenUpdate(updateId: number): boolean;      // false when it was already handled
  markUpdateSeen(updateId: number, at: number): void;
}

// One command for the command layer to run. A typed command is
// "/name arg arg". A tap carries its action instead ("link", "board",
// ...) with the box id in args: the command layer maps the action to a
// command and answers the tap.
export interface BotCommand {
  name: string;         // "/fleet", "/status", ...
  args: string[];
  chatId: number;
  messageId?: number;
  callbackId?: string;
}

export interface BotDeps {
  // The brain's Telegram client: the brain owns every reply, and the
  // command layer answers with this client. The router uses it for one
  // thing only — answering a tap it drops.
  telegram: OwnerChat;
  store: BotStore;
  ownerChatId: number;
  dispatch: (cmd: BotCommand) => Promise<void>;
}

// The brain's Telegram settings, straight from the Worker env.
export interface BotEnv {
  botToken?: string;
  // The owner chat id, as the env carries it: a string.
  ownerChatId?: string;
  webhookSecret?: string;
}

// The resolved settings: the client, the owner chat and the shared
// secret (TELEGRAM_WEBHOOK_SECRET) — the same value registered as
// Telegram's secret_token.
export interface BotConfig {
  telegram: OwnerChat;
  ownerChatId: number;
  secret: string;
}

export interface WebhookConfig extends BotConfig {
  dispatch: (cmd: BotCommand) => Promise<void>;
}

// The DO's timestamps are Unix seconds (last_seen, created_at), and the
// dedup table is pruned on the same clock.
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// The chat the update belongs to. A tap (callback query) carries its own
// chat; a message carries the chat it was sent in. A tap with no chat at
// all (an inline-mode query) has no chat to check, so it never passes
// the gate.
function chatOf(update: BotUpdate): number | undefined {
  const tap = update.callback_query;
  if (tap) {
    return tap.message?.chat?.id ?? update.message?.chat?.id;
  }
  return update.message?.chat?.id;
}

// The command an update carries, if any. A typed command is the first
// word plus its arguments; a tap carries "<action>:<boxId>" in the
// callback data and reaches the command layer as the action with the box
// as its argument.
//
// The payload has one reader: botbuttons.parseCallback. The action and
// the box it names are decided there, not here, so a change to the
// format cannot leave the brain speaking two formats.
function commandOf(update: BotUpdate, chatId: number): BotCommand | undefined {
  const tap = update.callback_query;
  if (tap) {
    return tapCommand(tap, chatId);
  }
  return typedCommand(update, chatId);
}

// A tap's command: the action it names, with the box it names as the
// command's argument.
function tapCommand(
  tap: NonNullable<BotUpdate["callback_query"]>,
  chatId: number,
): BotCommand | undefined {
  const data = tap.data;
  if (typeof data !== "string") {
    return undefined;
  }
  const parsed = parseCallback(data);
  if (!parsed) {
    return undefined;
  }
  const cmd: BotCommand = { name: parsed.action, args: parsed.boxId ? [parsed.boxId] : [], chatId };
  if (tap.id) {
    cmd.callbackId = tap.id;
  }
  if (tap.message?.message_id !== undefined) {
    cmd.messageId = tap.message.message_id;
  }
  return cmd;
}

// A typed command: the first word plus its arguments.
function typedCommand(update: BotUpdate, chatId: number): BotCommand | undefined {
  const text = update.message?.text;
  if (typeof text !== "string") {
    return undefined;
  }
  const fields = text.trim().split(/\s+/).filter((field) => field !== "");
  const name = fields[0];
  // Plain text is not a command: the owner chatting is not a request.
  if (!name || !name.startsWith("/")) {
    return undefined;
  }
  return { name, args: fields.slice(1), chatId };
}

export async function handleTelegramUpdate(update: BotUpdate, deps: BotDeps): Promise<void> {
  // The gate: one chat, the owner's. Everything else is dropped without
  // a word — a stranger must not learn that the brain exists.
  const chatId = chatOf(update);
  if (chatId === undefined || chatId !== deps.ownerChatId) {
    return;
  }
  // The dedup: Telegram retries a webhook it thinks failed. An update
  // that was handled already must not run the command again — a retried
  // /link would mint two links. The tap is still answered: Telegram
  // spins the button until the answer comes, and a silent drop leaves
  // the owner tapping again — and the second tap mints a second link.
  if (!deps.store.seenUpdate(update.update_id)) {
    await answerDroppedTap(update, deps);
    return;
  }
  deps.store.markUpdateSeen(update.update_id, nowSec());
  const cmd = commandOf(update, chatId);
  if (!cmd) {
    // A tap the brain cannot act on still gets an answer: Telegram spins
    // the button until the answer comes, and a stale button from an
    // older message would spin forever. A message that is not a command
    // carries no callback, so nothing is sent for it.
    await answerDroppedTap(update, deps);
    return;
  }
  await deps.dispatch(cmd);
}

// The answer for a tap the brain drops. A failure to answer is logged
// and swallowed: the tap is already lost, and a throw here would make
// Telegram retry an update that can never be acted on.
async function answerDroppedTap(update: BotUpdate, deps: BotDeps): Promise<void> {
  const callbackId = update.callback_query?.id;
  if (!callbackId) {
    return;
  }
  try {
    await deps.telegram.answerTap(callbackId);
  } catch (err) {
    console.error(`bot: the dropped tap was not answered (${String(err)})`);
  }
}

// Telegram's webhook: the brain's one entry point. The secret header
// decides, then the body is read as an update and routed.
export async function handleTelegramWebhook(
  request: Request,
  store: BotStore,
  config: WebhookConfig,
): Promise<Response> {
  const presented = request.headers.get(SECRET_HEADER);
  // The secret is a shared secret: compare it the way the tokens are
  // compared, without leaking how far the match went.
  if (!presented || !(await tokenMatches(presented, await hashToken(config.secret)))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const update = parseUpdate(await readJson(request));
  if (!update) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  await handleTelegramUpdate(update, {
    telegram: config.telegram,
    store,
    ownerChatId: config.ownerChatId,
    dispatch: config.dispatch,
  });
  return Response.json({ ok: true });
}

// The owner chat id: a private chat's id is the user's id, and it is
// positive. A group id is negative, and the brain must never answer in
// a group — so a negative id is refused, not honoured. A value that is
// not a chat id at all is refused too: a brain that cannot tell the
// owner from a stranger must fail loud, not drop every update quietly.
// The digits rule is the Go bot's (strconv.ParseInt): "1e3" and "0x10"
// are not chat ids here either.
export function parseOwnerChatId(raw?: string): number | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!/^\+?\d+$/.test(trimmed)) {
    return undefined;
  }
  const chatId = Number(trimmed);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    return undefined;
  }
  return chatId;
}

// Resolves the brain's Telegram settings, or names what is missing in
// the log. A brain without a token, an owner chat or a webhook secret
// cannot work, and the route says so out loud instead of dropping
// every update silently.
//
// The client rides in: the wiring (state.ts) builds it — this is the
// one place that knows the Bot API's shape — and hands it over.
export function resolveBrainConfig(env: BotEnv, telegram: OwnerChat | undefined): BotConfig | undefined {
  const ownerChatId = parseOwnerChatId(env.ownerChatId);
  if (!env.botToken || !telegram) {
    console.error("bot: TELEGRAM_BOT_TOKEN not configured");
    return undefined;
  }
  if (ownerChatId === undefined) {
    console.error("bot: TELEGRAM_OWNER_CHAT_ID is not a chat id");
    return undefined;
  }
  if (!env.webhookSecret) {
    console.error("bot: TELEGRAM_WEBHOOK_SECRET not configured");
    return undefined;
  }
  return {
    telegram,
    ownerChatId,
    secret: env.webhookSecret,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

// Telegram's update: an object with an update_id. The rest is read
// defensively — a malformed body must not crash the brain.
function parseUpdate(body: unknown): BotUpdate | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const update = body as Partial<BotUpdate>;
  if (typeof update.update_id !== "number" || !Number.isInteger(update.update_id)) {
    return undefined;
  }
  return update as BotUpdate;
}
