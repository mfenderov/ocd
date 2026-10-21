import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  handleTelegramUpdate,
  handleTelegramWebhook,
  parseOwnerChatId,
  resolveBrainConfig,
  type BotCommand,
  type BotStore,
} from "../src/bot";
import app, { type Env as EdgeEnv } from "../src/index";
import type { TelegramClient } from "../src/telegram";
import { inState } from "./helpers";

// The router answers one thing itself: a tap it drops. The command
// layer owns every other reply. The client is here because the brain
// owns every message.
const TELEGRAM: TelegramClient = {
  sendMessage: async () => ({ message_id: 1 }),
  editMessageText: async () => true,
  answerCallbackQuery: async () => {},
  setWebhook: async () => {},
};

// The client that remembers the taps it answered: a tap that is not
// answered leaves the owner's button spinning.
function recordingTelegram(): { telegram: TelegramClient; answered: string[] } {
  const answered: string[] = [];
  return {
    answered,
    telegram: {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => true,
      answerCallbackQuery: async (callbackId) => {
        answered.push(callbackId);
      },
      setWebhook: async () => {},
    },
  };
}

// A store that remembers the updates it handled, like the DO's
// seen_updates table: seenUpdate is true while the update is new.
class MemoryStore implements BotStore {
  readonly seen = new Set<number>();

  seenUpdate(updateId: number): boolean {
    return !this.seen.has(updateId);
  }

  markUpdateSeen(updateId: number): void {
    this.seen.add(updateId);
  }
}

function recordingDispatch(): { commands: BotCommand[]; dispatch: (cmd: BotCommand) => Promise<void> } {
  const commands: BotCommand[] = [];
  return {
    commands,
    dispatch: async (cmd) => {
      commands.push(cmd);
    },
  };
}

describe("the gate", () => {
  it("drops an update from a chat that is not the owner's", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();

    await handleTelegramUpdate(
      { update_id: 1, message: { text: "/fleet", chat: { id: 999, type: "private" } } },
      { telegram: TELEGRAM, store, ownerChatId: 7, dispatch },
    );

    expect(commands).toEqual([]);
  });

  it("drops a group message even when the text is a command", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();

    await handleTelegramUpdate(
      { update_id: 2, message: { text: "/fleet", chat: { id: -1001234, type: "supergroup" } } },
      { telegram: TELEGRAM, store, ownerChatId: 7, dispatch },
    );

    expect(commands).toEqual([]);
  });

  it("drops a tap that came from another chat", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();

    await handleTelegramUpdate(
      {
        update_id: 3,
        callback_query: { id: "cb-1", data: "link:mac", message: { chat: { id: 999 }, message_id: 12 } },
      },
      { telegram: TELEGRAM, store, ownerChatId: 7, dispatch },
    );

    expect(commands).toEqual([]);
  });

  it("falls back to the message's chat when the tap carries none", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();

    await handleTelegramUpdate(
      { update_id: 4, message: { chat: { id: 7 } }, callback_query: { id: "cb-1", data: "link:mac" } },
      { telegram: TELEGRAM, store, ownerChatId: 7, dispatch },
    );

    expect(commands).toHaveLength(1);
  });

  it("drops a tap that carries no chat at all", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();

    await handleTelegramUpdate(
      { update_id: 5, callback_query: { id: "cb-1", data: "link:mac" } },
      { telegram: TELEGRAM, store, ownerChatId: 7, dispatch },
    );

    expect(commands).toEqual([]);
  });
});

describe("the command", () => {
  it("splits a typed command into its name and its arguments", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();

    await handleTelegramUpdate(
      { update_id: 10, message: { text: "/flink mac", chat: { id: 7, type: "private" } } },
      { telegram: TELEGRAM, store, ownerChatId: 7, dispatch },
    );

    expect(commands).toEqual([{ name: "/flink", args: ["mac"], chatId: 7 }]);
  });

  it("ignores a message that is not a command", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();

    await handleTelegramUpdate(
      { update_id: 11, message: { text: "good morning", chat: { id: 7, type: "private" } } },
      { telegram: TELEGRAM, store, ownerChatId: 7, dispatch },
    );

    expect(commands).toEqual([]);
  });

  it("carries a tap's action, box, callback id and message id", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();

    await handleTelegramUpdate(
      {
        update_id: 12,
        callback_query: { id: "cb-1", data: "link:mac", message: { chat: { id: 7 }, message_id: 42 } },
      },
      { telegram: TELEGRAM, store, ownerChatId: 7, dispatch },
    );

    expect(commands).toEqual([
      { name: "link", args: ["mac"], chatId: 7, callbackId: "cb-1", messageId: 42 },
    ]);
  });

  // The payload has one reader (botbuttons.parseCallback): the action,
  // and the box it names. The tail is the box, whole.
  it("reads the whole tail of the payload as the box", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();

    await handleTelegramUpdate(
      {
        update_id: 13,
        callback_query: { id: "cb-1", data: "link:mac:extra", message: { chat: { id: 7 }, message_id: 42 } },
      },
      { telegram: TELEGRAM, store, ownerChatId: 7, dispatch },
    );

    expect(commands).toEqual([
      { name: "link", args: ["mac:extra"], chatId: 7, callbackId: "cb-1", messageId: 42 },
    ]);
  });

  // A tap the brain cannot act on still gets an answer: Telegram spins
  // the button until the answer comes, and a stale button from an older
  // message would spin forever.
  it("answers a tap that carries no data", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();
    const { telegram, answered } = recordingTelegram();

    await handleTelegramUpdate(
      { update_id: 14, callback_query: { id: "cb-2", data: "", message: { chat: { id: 7 } } } },
      { telegram, store, ownerChatId: 7, dispatch },
    );

    expect(answered).toEqual(["cb-2"]);
    expect(commands).toEqual([]);
  });

  it("answers a tap that names no action", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();
    const { telegram, answered } = recordingTelegram();

    await handleTelegramUpdate(
      { update_id: 15, callback_query: { id: "cb-3", data: ":mac", message: { chat: { id: 7 } } } },
      { telegram, store, ownerChatId: 7, dispatch },
    );

    expect(answered).toEqual(["cb-3"]);
    expect(commands).toEqual([]);
  });
});

describe("the dedup", () => {
  it("runs the command once when Telegram retries the same update", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();
    const update = { update_id: 5, message: { text: "/flink mac", chat: { id: 7, type: "private" } } };

    await handleTelegramUpdate(update, { telegram: TELEGRAM, store, ownerChatId: 7, dispatch });
    await handleTelegramUpdate(update, { telegram: TELEGRAM, store, ownerChatId: 7, dispatch });

    // A retried /link must not mint two links.
    expect(commands).toHaveLength(1);
  });

  // A retried tap is dropped by the dedup, but the button still spins
  // until it is answered: the owner would tap again, and the second tap
  // mints a second link.
  it("answers a retried tap even though the command does not run again", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();
    const { telegram, answered } = recordingTelegram();
    const update = {
      update_id: 30,
      callback_query: { id: "cb-retry", data: "link:mac", message: { chat: { id: 7 }, message_id: 42 } },
    };

    await handleTelegramUpdate(update, { telegram, store, ownerChatId: 7, dispatch });
    await handleTelegramUpdate(update, { telegram, store, ownerChatId: 7, dispatch });

    // The retry is dropped by the dedup, but its tap is answered: the
    // command ran once, and the button got its answer.
    expect(answered).toEqual(["cb-retry"]);
    expect(commands).toHaveLength(1);
  });

  it("remembers the updates the brain handled", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-tg-dedup"));
    await inState(stub, async (instance) => {
      // New until it is recorded; then the retry is recognised.
      expect(instance.seenUpdate(42)).toBe(true);
      instance.markUpdateSeen(42, 1700000000);
      expect(instance.seenUpdate(42)).toBe(false);
      // Another update is new again.
      expect(instance.seenUpdate(43)).toBe(true);
    });
  });
});

describe("the webhook", () => {
  const SECRET = "s3cret";

  function webhookRequest(body: unknown, secret: string | null = SECRET): Request {
    const headers = new Headers({ "content-type": "application/json" });
    if (secret !== null) {
      headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
    }
    return new Request("https://fleet.local/tg/webhook", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("answers 401 when the secret header is missing or wrong", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();
    const config = { secret: SECRET, ownerChatId: 7, telegram: TELEGRAM, dispatch };

    const missing = await handleTelegramWebhook(webhookRequest({ update_id: 1 }, null), store, config);
    expect(missing.status).toBe(401);

    const wrong = await handleTelegramWebhook(webhookRequest({ update_id: 1 }, "nope"), store, config);
    expect(wrong.status).toBe(401);

    expect(commands).toEqual([]);
  });

  it("answers 400 when the body is not an update", async () => {
    const store = new MemoryStore();
    const config = { secret: SECRET, ownerChatId: 7, telegram: TELEGRAM, dispatch: async () => {} };

    const notJson = await handleTelegramWebhook(webhookRequest("not json"), store, config);
    expect(notJson.status).toBe(400);

    const noUpdateId = await handleTelegramWebhook(webhookRequest({ message: "hi" }), store, config);
    expect(noUpdateId.status).toBe(400);
  });

  it("runs the update and answers 200", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();
    const config = { secret: SECRET, ownerChatId: 7, telegram: TELEGRAM, dispatch };

    const res = await handleTelegramWebhook(
      webhookRequest({ update_id: 20, message: { text: "/fleet", chat: { id: 7 } } }),
      store,
      config,
    );

    expect(res.status).toBe(200);
    expect(commands).toEqual([{ name: "/fleet", args: [], chatId: 7 }]);
  });

  it("runs a retried update only once", async () => {
    const store = new MemoryStore();
    const { commands, dispatch } = recordingDispatch();
    const config = { secret: SECRET, ownerChatId: 7, telegram: TELEGRAM, dispatch };
    const body = { update_id: 21, message: { text: "/flink mac", chat: { id: 7 } } };

    await handleTelegramWebhook(webhookRequest(body), store, config);
    await handleTelegramWebhook(webhookRequest(body), store, config);

    expect(commands).toHaveLength(1);
  });
});

describe("the owner chat id", () => {
  it("parses the env string into the number the gate compares", () => {
    expect(parseOwnerChatId("7")).toBe(7);
  });

  it("refuses a value that is not a chat id", () => {
    expect(parseOwnerChatId(undefined)).toBeUndefined();
    expect(parseOwnerChatId("")).toBeUndefined();
    expect(parseOwnerChatId("  ")).toBeUndefined();
    expect(parseOwnerChatId("abc")).toBeUndefined();
    expect(parseOwnerChatId("7.5")).toBeUndefined();
    expect(parseOwnerChatId("0")).toBeUndefined();
    // The Go bot parses its owner id with strconv.ParseInt: only digits.
    expect(parseOwnerChatId("1e3")).toBeUndefined();
    expect(parseOwnerChatId("0x10")).toBeUndefined();
  });

  it("refuses a group id: the brain must never answer in a group", () => {
    expect(parseOwnerChatId("-1001234")).toBeUndefined();
  });
});

describe("the brain config", () => {
  it("resolves the token, the owner chat and the webhook secret", () => {
    const config = resolveBrainConfig({
      botToken: "TOKEN",
      ownerChatId: "7",
      webhookSecret: "s3cret",
    });

    expect(config?.ownerChatId).toBe(7);
    expect(config?.secret).toBe("s3cret");
    expect(config?.telegram).toBeDefined();
  });

  it("refuses a brain that is not configured", () => {
    expect(resolveBrainConfig({ ownerChatId: "7", webhookSecret: "s3cret" })).toBeUndefined();
    expect(resolveBrainConfig({ botToken: "TOKEN", webhookSecret: "s3cret" })).toBeUndefined();
    expect(resolveBrainConfig({ botToken: "TOKEN", ownerChatId: "7" })).toBeUndefined();
    expect(resolveBrainConfig({ botToken: "TOKEN", ownerChatId: "abc", webhookSecret: "s" })).toBeUndefined();
  });
});

describe("the edge", () => {
  interface ForwardedCall {
    method: string;
    path: string;
    body: string;
    secret: string | null;
  }

  // A fake DO namespace whose stub records what the edge forwarded.
  function recordingEnv(calls: ForwardedCall[]): EdgeEnv {
    return {
      FLEET_STATE: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (req: Request | string) => {
            const inner = req as Request;
            calls.push({
              method: inner.method,
              path: new URL(inner.url).pathname,
              body: await inner.text(),
              secret: inner.headers.get("x-telegram-bot-api-secret-token"),
            });
            return new Response("stub-ok");
          },
        }),
      },
    } as unknown as EdgeEnv;
  }

  it("forwards POST /tg/webhook to the DO's /tg path with the secret header", async () => {
    const calls: ForwardedCall[] = [];
    const body = JSON.stringify({ update_id: 1, message: { text: "/fleet", chat: { id: 7 } } });

    const res = await app.fetch(
      new Request("https://fleet.local/tg/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret" },
        body,
      }),
      recordingEnv(calls),
    );

    expect(await res.text()).toBe("stub-ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/tg");
    expect(calls[0].body).toBe(body);
    expect(calls[0].secret).toBe("s3cret");
  });
});

describe("the DO's door", () => {
  // The brain is configured in the test env (the Telegram settings live
  // in vitest.config.ts), so the door checks the secret header first: a
  // request without it is refused before any update runs.
  it("answers 401 when the webhook secret is missing", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-tg-door"));
    const res = await stub.fetch(
      new Request("https://do/tg", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update_id: 1 }),
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  // The production chain: edge → DO → secret check → config → dispatch.
  // The update carries no command, so the brain answers nothing and the
  // test never reaches the real Bot API.
  it("answers 200 for an update that carries no command, and records it as seen", async () => {
    const sent: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      // A Telegram answer that lands: a reply that went out is a call
      // this test must see.
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const res = await SELF.fetch("https://fleet.local/tg/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "test-webhook-secret",
        },
        body: JSON.stringify({
          update_id: 4242,
          message: { text: "good morning", chat: { id: 7, type: "private" } },
        }),
      });

      expect(res.status).toBe(200);
      // No reply was sent: the update carried no command.
      expect(sent).toEqual([]);

      const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
      await inState(stub, async (instance) => {
        // The update is recorded as seen: a retry would not run it again.
        expect(instance.seenUpdate(4242)).toBe(false);
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
