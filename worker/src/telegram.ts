// Telegram Bot API client for the brain: the one place that knows the Bot
// API's HTTP shape. (The enrollment notifier in enroll.ts still carries
// its own copy until later work replaces it.) Every call POSTs JSON to
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
      throw new Error(`telegram: ${method} failed (network)`, { cause: err });
    }
    let envelope: TelegramEnvelope | null = null;
    try {
      envelope = (await res.json()) as TelegramEnvelope | null;
    } catch {
      // No body to read: the status is all we know.
    }
    if (!envelope || envelope.ok !== true) {
      const description = typeof envelope?.description === "string" ? envelope.description : undefined;
      const reason = description ? `status ${res.status}: ${description}` : `status ${res.status}`;
      throw new Error(`telegram: ${method} failed (${reason})`);
    }
    return envelope.result as T;
  }

  return {
    async sendMessage(chatId, text, opts) {
      const body: Record<string, unknown> = { chat_id: chatId, text, ...RENDER_OPTS };
      if (opts?.replyMarkup !== undefined) {
        body["reply_markup"] = opts.replyMarkup;
      }
      return call<{ message_id: number }>("sendMessage", body);
    },

    async editMessageText(chatId, messageId, text) {
      const result = await call<unknown>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...RENDER_OPTS,
      });
      // Telegram answers `true`; an inline-message edit answers with the
      // message itself. Both mean the edit landed.
      return result === true || (typeof result === "object" && result !== null);
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
