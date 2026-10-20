// Telegram Bot API client for the brain: the one place that knows the Bot
// API's HTTP shape. (The enrollment notifier in enroll.ts sends through
// this client too.) Every call POSTs JSON to
// https://api.telegram.org/bot<token>/<method> and rejects when the API
// answers ok:false, so the caller decides what a failed message means:
// the owner ping sink swallows it, the brain logs it.
//
// The token rides in the URL, so it never appears in an error message and
// never in a log line: the errors name the method, and when Telegram
// answered, its status and its own description.

const API_BASE = "https://api.telegram.org";

// The brain's messages are HTML-parse-mode like the Go bot's — that is
// why escapeHtml exists. The link previews stay off like the Go bot's
// link messages: a preview makes Telegram fetch the URL and show it as a
// card, and the tap links are one-time secrets.
const RENDER_OPTS = {
  parse_mode: "HTML",
  link_preview_options: { is_disabled: true },
};

export interface TelegramClient {
  sendMessage(chatId: number, text: string, opts?: { replyMarkup?: unknown }): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<boolean>;
  answerCallbackQuery(callbackId: string, text?: string): Promise<void>;
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
export class TelegramError extends Error {
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

const REDACTED = "[redacted]";

// Nothing that leaves this module may carry the token: it rides in the
// URL, and a transport error's message can carry the URL.
function redact(text: string, token: string): string {
  return token ? text.replaceAll(token, REDACTED) : text;
}

// A transport failure is worth keeping for debugging, so its cause stays
// attached — with the token taken out of it, and out of every cause
// under it, first.
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

// escapeHtml escapes the three characters Telegram's HTML parse mode
// reads as markup — the same three the Go bot's esc helper handles.
export function escapeHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function createTelegramClient(token: string, fetcher: typeof fetch = fetch): TelegramClient {
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
      envelope = (await res.json()) as TelegramEnvelope | null;
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
    async sendMessage(chatId, text, opts) {
      const body: Record<string, unknown> = { chat_id: chatId, text, ...RENDER_OPTS };
      if (opts?.replyMarkup !== undefined) {
        body["reply_markup"] = opts.replyMarkup;
      }
      const result = await call<unknown>("sendMessage", body);
      const messageId = (result as { message_id?: unknown } | null | undefined)?.message_id;
      if (typeof messageId !== "number") {
        // The call succeeded but the answer carried no id to edit the
        // message with later — that is a failure, not an empty success.
        throw new TelegramError("sendMessage", "the answer carried no message id");
      }
      return { message_id: messageId };
    },

    async editMessageText(chatId, messageId, text) {
      const result = await call<unknown>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...RENDER_OPTS,
      });
      // Telegram answers true when the edit landed, false when it did not.
      return result === true;
    },

    async answerCallbackQuery(callbackId, text) {
      const body: Record<string, unknown> = { callback_query_id: callbackId };
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
