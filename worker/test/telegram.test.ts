import { describe, expect, it } from "vitest";
import { createTelegramClient, escapeHtml } from "../src/telegram";

interface FetchCall {
  url: string;
  init: RequestInit;
}

// Fake fetcher: records the call and answers Telegram's envelope.
function stubFetcher(status: number, body: string, calls: FetchCall[]): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
}

function sentBody(call: FetchCall): Record<string, unknown> {
  // The body is JSON text: the client sends text, never a blob.
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

const OK_MESSAGE = JSON.stringify({ ok: true, result: { message_id: 42 } });

describe("telegram client", () => {
  it("sendMessage posts to the bot's sendMessage and resolves the message id", async () => {
    const calls: FetchCall[] = [];
    const client = createTelegramClient("TOKEN", stubFetcher(200, OK_MESSAGE, calls));

    const sent = await client.sendMessage(7, "hi");

    expect(sent).toEqual({ message_id: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(calls[0].init.method).toBe("POST");
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
    const body = sentBody(calls[0]);
    expect(body["chat_id"]).toBe(7);
    expect(body["text"]).toBe("hi");
    // The brain's messages are HTML-parse-mode like the Go bot's, and the
    // previews stay off so Telegram never renders a card for a tap link.
    expect(body["parse_mode"]).toBe("HTML");
    expect(body["link_preview_options"]).toEqual({ is_disabled: true });
  });

  it("sendMessage carries the reply markup only when the caller has buttons", async () => {
    const calls: FetchCall[] = [];
    const client = createTelegramClient("TOKEN", stubFetcher(200, OK_MESSAGE, calls));
    const markup = { inline_keyboard: [[{ text: "Open", callback_data: "link:mac" }]] };

    await client.sendMessage(7, "hi", { replyMarkup: markup });
    await client.sendMessage(7, "hi");

    expect(sentBody(calls[0])["reply_markup"]).toEqual(markup);
    expect(sentBody(calls[1])["reply_markup"]).toBeUndefined();
  });

  it("editMessageText posts the chat, the message and the new text", async () => {
    const calls: FetchCall[] = [];
    // A chat edit is answered with the edited Message, not with `true`.
    const client = createTelegramClient(
      "TOKEN",
      stubFetcher(200, JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 7 } } }), calls),
    );

    const edited = await client.editMessageText(7, 42, "✅ done");

    expect(edited).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botTOKEN/editMessageText");
    const body = sentBody(calls[0]);
    expect(body["chat_id"]).toBe(7);
    expect(body["message_id"]).toBe(42);
    expect(body["text"]).toBe("✅ done");
  });

  it("sendMessage rejects when the answer carries no message id", async () => {
    const noResult = createTelegramClient("TOKEN", stubFetcher(200, JSON.stringify({ ok: true }), []));
    await expect(noResult.sendMessage(7, "hi")).rejects.toThrow(/no message id/);

    const wrongType = createTelegramClient(
      "TOKEN",
      stubFetcher(200, JSON.stringify({ ok: true, result: { message_id: "42" } }), []),
    );
    await expect(wrongType.sendMessage(7, "hi")).rejects.toThrow(/no message id/);
  });

  it("editMessageText reads both answer shapes: the Message and the true", async () => {
    // A chat edit answers with the edited Message.
    const chatEdit = createTelegramClient(
      "TOKEN",
      stubFetcher(200, JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 7 } } }), []),
    );
    await expect(chatEdit.editMessageText(7, 42, "done")).resolves.toBe(true);

    // An inline-message edit answers `true`. This method never issues
    // one, but the shape must not read as a failure.
    const inlineEdit = createTelegramClient("TOKEN", stubFetcher(200, JSON.stringify({ ok: true, result: true }), []));
    await expect(inlineEdit.editMessageText(7, 42, "done")).resolves.toBe(true);

    const notEdited = createTelegramClient(
      "TOKEN",
      stubFetcher(200, JSON.stringify({ ok: true, result: false }), []),
    );
    await expect(notEdited.editMessageText(7, 42, "done")).resolves.toBe(false);
  });

  it("answerCallbackQuery posts the callback id and the toast text", async () => {
    const calls: FetchCall[] = [];
    const client = createTelegramClient("TOKEN", stubFetcher(200, JSON.stringify({ ok: true, result: true }), calls));

    await client.answerCallbackQuery("cb-1", "done");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botTOKEN/answerCallbackQuery");
    const body = sentBody(calls[0]);
    expect(body["callback_query_id"]).toBe("cb-1");
    expect(body["text"]).toBe("done");
  });

  it("setWebhook posts the url, the secret and the updates the buttons need", async () => {
    const calls: FetchCall[] = [];
    const client = createTelegramClient("TOKEN", stubFetcher(200, JSON.stringify({ ok: true, result: true }), calls));

    await client.setWebhook("https://fleet.example.com/tg/webhook", "s3cret");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botTOKEN/setWebhook");
    const body = sentBody(calls[0]);
    expect(body["url"]).toBe("https://fleet.example.com/tg/webhook");
    expect(body["secret_token"]).toBe("s3cret");
    // The button taps arrive as callback queries: without this the webhook
    // would only carry messages and the buttons would never fire.
    expect(body["allowed_updates"]).toEqual(["message", "callback_query"]);
  });

  it("a refused call rejects with telegram's own description", async () => {
    const client = createTelegramClient(
      "TOKEN",
      stubFetcher(400, JSON.stringify({ ok: false, description: "nope" }), []),
    );

    await expect(client.sendMessage(7, "hi")).rejects.toThrow(/nope/);
  });

  it("a failure never names the token", async () => {
    const client = createTelegramClient(
      "SECRET-TOKEN",
      stubFetcher(401, JSON.stringify({ ok: false, description: "Unauthorized" }), []),
    );

    const err = await client.sendMessage(7, "hi").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Unauthorized");
    expect((err as Error).message).not.toContain("SECRET-TOKEN");
  });

  it("an unreachable telegram rejects instead of resolving", async () => {
    const down: typeof fetch = () => Promise.reject(new Error("conn refused"));
    const client = createTelegramClient("TOKEN", down);

    await expect(client.sendMessage(7, "hi")).rejects.toThrow(/sendMessage/);
  });

  it("a network failure keeps the cause for debugging, but never the token", async () => {
    const inner = new Error("connect ECONNREFUSED https://api.telegram.org/botSECRET-TOKEN/sendMessage");
    const outer = new Error("fetch failed", { cause: inner });
    const down: typeof fetch = () => Promise.reject(outer);
    const client = createTelegramClient("SECRET-TOKEN", down);

    const err = await client.sendMessage(7, "hi").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("SECRET-TOKEN");
    // The cause is still there — a transport failure is worth reading.
    const cause = (err as Error).cause as Error;
    expect(cause.message).toContain("fetch failed");
    // The token is in the URL, and a transport error can quote the URL:
    // neither the cause nor its own cause may carry it.
    expect(cause.message).not.toContain("SECRET-TOKEN");
    expect(String(cause.stack)).not.toContain("SECRET-TOKEN");
    expect((cause.cause as Error).message).not.toContain("SECRET-TOKEN");
  });

  it("escapeHtml escapes the characters html parse mode cares about", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    // The double quote too: a value that lands inside an href="…"
    // attribute must not end that attribute.
    expect(escapeHtml('a "quoted" url')).toBe("a &quot;quoted&quot; url");
  });
});
