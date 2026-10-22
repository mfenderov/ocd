// Telegram Bot API client for the brain: the one place that knows the
// Bot API's HTTP shape — and the one place the client is built. The
// notifier that tells the owner something rides on it too.
//
// Every call POSTs JSON to https://api.telegram.org/bot<token>/<method>
// and rejects when the API answers ok:false, so the caller decides what
// a failed message means: the owner ping sink swallows it, the brain
// logs it.
//
// The token rides in the URL, so it is scrubbed out of everything this
// module reports: the error's message, its stack, the cause chain and
// Telegram's own description. A cause that is neither an Error nor a
// string is passed through as it came in. The errors name the method
// and, when Telegram answered, its status and its own description.
import type { NotifyFn, OwnerButtons, OwnerChat, SentMessage } from "./owner";

const API_BASE = "https://api.telegram.org";

// The brain's messages are HTML-parse-mode like the Go bot's — that is
// why the brain escapes every value it sends (see html.ts). The link
// previews stay off like the Go bot's link messages: a preview makes
// Telegram fetch the URL and show it as a card, and the tap links are
// one-time secrets.
const RENDER_OPTS = {
  parse_mode: "HTML",
  link_preview_options: { is_disabled: true },
};

// The client the adapter builds: the port's three operations and the
// one the brain's front door needs — registering the webhook. The port
// says nothing about that one: the domain never registers the webhook.
export interface TelegramApi extends OwnerChat {
  setWebhook(url: string, secret: string): Promise<void>;
}

interface TelegramEnvelope {
  ok?: boolean;
  result?: unknown;
  description?: string;
}

// The one error the client throws. `reason` is the bare, safe summary —
// "network", "status 429" — so a caller that logs the reason alone never
// logs the response body. Telegram's own description is in the message,
// not in the reason.
//
// The class is the adapter's own: the domain reads a failure through
// the message it carries, never through this class.
class TelegramError extends Error {
  readonly method: string;
  readonly reason: string;

  constructor(method: string, reason: string, options?: ErrorOptions & { detail?: string }) {
    const detail = options?.detail;
    super(`telegram: ${method} failed (${reason}${detail ? `: ${detail}` : ""})`, options);
    this.name = "TelegramError";
    this.method = method;
    this.reason = reason;
  }
}

// The reason a failed message carries, or "unknown error" when the
// failure carries none. Only this module's own failure has a reason:
// the class is the adapter's, so nothing outside can read one.
function messageFailureReason(err: unknown): string {
  if (err instanceof TelegramError) {
    return err.reason;
  }
  return "unknown error";
}

const REDACTED = "[redacted]";

// Nothing that leaves this module may carry the token: it rides in the
// URL, and a transport error's message can carry the URL.
function redact(text: string, token: string): string {
  return token ? text.replaceAll(token, REDACTED) : text;
}

// A transport failure is worth keeping for debugging, so its cause stays
// attached — with the token taken out of it, and out of every Error cause
// under it, first. A cause that is neither an Error nor a string is passed
// through as it came in.
function redactToken(err: unknown, token: string, depth = 0): unknown {
  if (typeof err === "string") {
    return redact(err, token);
  }
  if (!(err instanceof Error)) {
    return err;
  }
  err.message = redact(err.message, token);
  if (typeof err.stack === "string") {
    err.stack = redact(err.stack, token);
  }
  // The chain is short (a transport error and its one cause); the depth
  // cap is there for a cycle, not for a long story.
  if (err.cause !== undefined && depth < 8) {
    err.cause = redactToken(err.cause, token, depth + 1);
  }
  return err;
}

export function createTelegramClient(token: string, fetcher: typeof fetch = fetch): TelegramApi {
  // One Bot API call: POST the body, read the envelope, and turn every
  // refusal into a rejected promise.
  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetcher(`${API_BASE}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new TelegramError(method, "network", { cause: redactToken(err, token) });
    }
    let envelope: TelegramEnvelope | null = null;
    try {
      envelope = await res.json<TelegramEnvelope | null>();
    } catch {
      // No body to read: the status is all we know.
    }
    if (!envelope || envelope.ok !== true) {
      const description = typeof envelope?.description === "string" ? envelope.description : undefined;
      throw new TelegramError(method, `status ${res.status}`, {
        detail: description === undefined ? undefined : redact(description, token),
      });
    }
    return envelope.result as T;
  }

  return {
    async say(chatId, text, buttons): Promise<SentMessage> {
      const body: Record<string, unknown> = { chat_id: chatId, text, ...RENDER_OPTS };
      const markup = replyMarkup(buttons);
      if (markup !== undefined) {
        body["reply_markup"] = markup;
      }
      const result = await call<unknown>("sendMessage", body);
      const messageId = (result as { message_id?: unknown } | null | undefined)?.message_id;
      if (typeof messageId !== "number") {
        // The call succeeded but the answer carried no id to edit the
        // message with later — that is a failure, not an empty success.
        throw new TelegramError("sendMessage", "the answer carried no message id");
      }
      return { id: messageId };
    },

    async replace(chatId, messageId, text) {
      const result = await call<unknown>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...RENDER_OPTS,
      });
      // Telegram answers a chat edit with the edited Message, and an
      // inline-message edit with `true`. This method only ever issues a
      // chat edit, but both shapes mean the edit landed — the Go client
      // reads them the same way (bot.editMethodRequest).
      return result === true || (typeof result === "object" && result !== null);
    },

    async answerTap(tapId, text) {
      const body: Record<string, unknown> = { callback_query_id: tapId };
      if (text !== undefined) {
        body["text"] = text;
      }
      await call<unknown>("answerCallbackQuery", body);
    },

    async setWebhook(url, secret) {
      await call<unknown>("setWebhook", {
        url,
        secret_token: secret,
        // The buttons' taps arrive as callback queries: without this the
        // webhook would carry the messages only and the buttons would
        // never fire.
        allowed_updates: ["message", "callback_query"],
      });
    },
  };
}

// The Bot API's keyboard: the brain's buttons in the Bot API's shape.
// The shape is the adapter's business — the brain says what a button
// does, not how Telegram spells it.
function replyMarkup(buttons: OwnerButtons | undefined): Record<string, unknown> | undefined {
  if (!buttons || buttons.length === 0) {
    return undefined;
  }
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) =>
        "tap" in button
          ? { text: button.label, callback_data: button.tap }
          : { text: button.label, url: button.link },
      ),
    ),
  };
}

// Owner ping, sent through the owner's chat — the one place that
// knows the Bot API's shape. The contract is unchanged: the ping never
// throws, a failure is reported as false, and the log carries the
// reason alone — never the URL (it embeds the token), the body, or the
// chat id.
//
// The log says "owner:" because the notifier is the owner's notice
// sink: the enrolment's pings, the heartbeat's warnings and the DNS
// failure report all go through it. The prefix names what the line is
// about, like every other log line in the brain.
export async function sendTelegramMessage(
  client: OwnerChat,
  chatId: string,
  text: string,
): Promise<boolean> {
  // The env carries the chat id as a string, the client takes a number —
  // the Go bot parses its owner id the same way.
  const chat = Number(chatId);
  if (!Number.isInteger(chat)) {
    console.error("owner: telegram send failed (bad chat id)");
    return false;
  }
  try {
    await client.say(chat, text);
    return true;
  } catch (err) {
    console.error(`owner: telegram send failed (${messageFailureReason(err)})`);
    return false;
  }
}

// The notifier the brain hands to the domain: it tells the owner, and
// it never throws.
//
// A brain without a client has nobody to tell: the ping is dropped and
// the log says so. The client itself is built by the wiring
// (state.ts) — this module only speaks it.
export function telegramNotifier(
  client: OwnerChat | undefined,
  chatId: string | undefined,
): NotifyFn {
  if (!client || !chatId) {
    // The notifier still answers with a promise: the caller awaits it.
    return () => {
      console.error("owner: telegram not configured; ping dropped");
      return Promise.resolve();
    };
  }
  return async (text: string) => {
    await sendTelegramMessage(client, chatId, text);
  };
}
