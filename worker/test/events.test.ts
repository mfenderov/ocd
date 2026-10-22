import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BoxRow } from "../src/boxes";
import { handleEvents, type LinkRow } from "../src/events";
import { hashToken } from "../src/heartbeat";
import app, { type Env as EdgeEnv } from "../src/index";
import type { FleetState } from "../src/state";
import type { TelegramClient } from "../src/ports";
import { inState } from "./helpers";

// The box's heartbeat secret: the same secret the heartbeat uses, and the
// only credential a box needs to push its events.
const BOX_TOKEN = "hb-secret";
const BOX_HASH = await hashToken(BOX_TOKEN);

const BOX: BoxRow = {
  id: "home",
  hostname: "oc-tap-home.buyallmemes.com",
  heartbeat_token_hash: BOX_HASH,
  admin_token_hash: "admin-hash",
  admin_token_sealed: "",
  tunnel_id: "",
  epoch: 1,
  last_seq: 1,
  last_ts: 0,
  last_seen: 1700000000,
  enrolled: 1,
};

// The client that remembers the edits the brain made: the brain owns
// every message, so the edit is the thing the tests watch.
class RecordingTelegram implements TelegramClient {
  readonly edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  editLands = true;

  sendMessage(): Promise<{ message_id: number }> {
    return Promise.resolve({ message_id: 1 });
  }

  editMessageText(chatId: number, messageId: number, text: string): Promise<boolean> {
    this.edits.push({ chatId, messageId, text });
    return Promise.resolve(this.editLands);
  }

  answerCallbackQuery(): Promise<void> {
    return Promise.resolve();
  }
}

// The box's door: POST /api/events, the bearer and the box's own id.
function eventRequest(body: unknown, bearer: string | null): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (bearer !== null) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  return new Request("https://fleet.local/api/events", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// Push a batch of events into the brain's own store and answer with the
// status the door gave.
async function push(
  name: string,
  body: unknown,
  bearer: string | null,
  telegram: RecordingTelegram,
): Promise<number> {
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName(name));
  return await inState(stub, async (instance) => {
    instance.putBox(BOX);
    const res = await handleEvents(eventRequest(body, bearer), instance, {
      telegram,
      verifyBox: (id, token) => instance.verifyBoxToken(id, token),
    });
    return res.status;
  });
}

// Read the brain's own store, the way the sweeper and /faudit do.
async function readStore<R>(name: string, fn: (instance: FleetState) => R): Promise<R> {
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName(name));
  return await inState(stub, fn);
}

// A link the brain handed out: the token, the box and the message that
// carries it.
function link(overrides: Partial<LinkRow> = {}): LinkRow {
  return {
    token: "tok-1",
    box_id: "home",
    chat_id: 7,
    message_id: 42,
    state: "issued",
    created_at: 1700000000,
    used_at: 0,
    used_ip: "",
    used_ua: "",
    edited: 0,
    ...overrides,
  };
}

describe("the event door", () => {
  it("answers 401 when the bearer is not the box's token, and writes nothing", async () => {
    const telegram = new RecordingTelegram();

    const status = await push(
      "fleet-events-auth",
      { id: "home", events: [{ type: "link-used", token: "tok-1", ip: "1.2.3.4" }] },
      "not-the-box-token",
      telegram,
    );

    expect(status).toBe(401);
    await readStore("fleet-events-auth", (instance) => {
      expect(instance.linkRow("tok-1")).toBeUndefined();
      expect(instance.auditLogRows("", 10)).toEqual([]);
    });
    expect(telegram.edits).toEqual([]);
  });

  it("answers 401 when the bearer is missing", async () => {
    const telegram = new RecordingTelegram();

    const status = await push("fleet-events-no-bearer", { id: "home", events: [] }, null, telegram);

    expect(status).toBe(401);
    expect(telegram.edits).toEqual([]);
  });

  // The bearer is checked before the body: a body the brain cannot read
  // names no box, and a caller that names no box cannot be authenticated.
  it("answers 401 for a malformed body with a bad bearer", async () => {
    const telegram = new RecordingTelegram();

    const status = await push("fleet-events-malformed-auth", "not json", "not-the-box-token", telegram);

    expect(status).toBe(401);
    expect(telegram.edits).toEqual([]);
  });
});

describe("the edits", () => {
  it("edits the message it owns when the link was used", async () => {
    const telegram = new RecordingTelegram();
    await readStore("fleet-events-used", (instance) => {
      instance.putLink(link());
    });

    const status = await push(
      "fleet-events-used",
      { id: "home", events: [{ type: "link-used", token: "tok-1", ip: "1.2.3.4", ua: "Mozilla/5.0" }] },
      BOX_TOKEN,
      telegram,
    );

    expect(status).toBe(200);
    expect(telegram.edits).toHaveLength(1);
    expect(telegram.edits[0].chatId).toBe(7);
    expect(telegram.edits[0].messageId).toBe(42);
    expect(telegram.edits[0].text).toContain("✅");
    expect(telegram.edits[0].text).toContain("1.2.3.4");
  });

  it("edits the message it owns when the link died", async () => {
    const telegram = new RecordingTelegram();
    await readStore("fleet-events-expired", (instance) => {
      instance.putLink(link());
    });

    const status = await push(
      "fleet-events-expired",
      { id: "home", events: [{ type: "link-expired", token: "tok-1" }] },
      BOX_TOKEN,
      telegram,
    );

    expect(status).toBe(200);
    expect(telegram.edits).toHaveLength(1);
    expect(telegram.edits[0].chatId).toBe(7);
    expect(telegram.edits[0].messageId).toBe(42);
    expect(telegram.edits[0].text).toContain("⌛️");
  });
});

describe("the duplicates", () => {
  const USED = { type: "link-used", token: "tok-1", ip: "1.2.3.4", ua: "Mozilla/5.0" };

  it("edits once when the same link-used event is pushed twice", async () => {
    const telegram = new RecordingTelegram();
    await readStore("fleet-events-dup-link", (instance) => {
      instance.putLink(link());
    });

    await push("fleet-events-dup-link", { id: "home", events: [USED] }, BOX_TOKEN, telegram);
    await push("fleet-events-dup-link", { id: "home", events: [USED] }, BOX_TOKEN, telegram);

    expect(telegram.edits).toHaveLength(1);
  });

  it("keeps one row when the same audit row is pushed twice", async () => {
    const telegram = new RecordingTelegram();
    const row = {
      type: "audit",
      at: 1700000000,
      actor: "web:1.2.3.4",
      action: "tapped",
      device: "",
      ip: "1.2.3.4",
      result: "ok",
      ua: "Mozilla/5.0",
    };

    await push("fleet-events-dup-audit", { id: "home", events: [row] }, BOX_TOKEN, telegram);
    await push("fleet-events-dup-audit", { id: "home", events: [row] }, BOX_TOKEN, telegram);

    await readStore("fleet-events-dup-audit", (instance) => {
      expect(instance.auditLogRows("", 10)).toHaveLength(1);
    });
  });

  // The dedup key is box + at + action + token. The box's audit rows
  // carry no token, so the key is the box, the second and the action:
  // two rows with the same action in the same second collapse into one.
  // This is disclosed and accepted; the test pins it so it cannot change
  // silently.
  it("keeps one row when two audit rows share a second and an action", async () => {
    const telegram = new RecordingTelegram();
    const at = 1700000000;
    const events = [
      { type: "audit", at, actor: "web:1.2.3.4", action: "tapped", device: "", ip: "1.2.3.4", result: "ok", ua: "" },
      { type: "audit", at, actor: "web:5.6.7.8", action: "tapped", device: "", ip: "5.6.7.8", result: "denied", ua: "" },
    ];

    const status = await push("fleet-events-same-second", { id: "home", events }, BOX_TOKEN, telegram);

    expect(status).toBe(200);
    await readStore("fleet-events-same-second", (instance) => {
      const rows = instance.auditLogRows("", 10);
      expect(rows).toHaveLength(1);
      // The first row wins: the second one is the same key.
      expect(rows[0].ip).toBe("1.2.3.4");
    });
  });

  // The link is marked edited only when the edit landed, so a failed edit
  // is tried again by the next event.
  it("tries the edit again when it did not land", async () => {
    const telegram = new RecordingTelegram();
    telegram.editLands = false;
    await readStore("fleet-events-retry", (instance) => {
      instance.putLink(link());
    });

    await push("fleet-events-retry", { id: "home", events: [USED] }, BOX_TOKEN, telegram);
    expect(telegram.edits).toHaveLength(1);
    await readStore("fleet-events-retry", (instance) => {
      expect(instance.linkRow("tok-1")?.edited).toBe(0);
    });

    telegram.editLands = true;
    await push("fleet-events-retry", { id: "home", events: [USED] }, BOX_TOKEN, telegram);

    expect(telegram.edits).toHaveLength(2);
    await readStore("fleet-events-retry", (instance) => {
      expect(instance.linkRow("tok-1")?.edited).toBe(1);
    });
  });
});

describe("the events it cannot use", () => {
  it("ignores the malformed ones and keeps the usable ones", async () => {
    const telegram = new RecordingTelegram();
    await readStore("fleet-events-malformed", (instance) => {
      instance.putLink(link());
    });

    const status = await push(
      "fleet-events-malformed",
      {
        id: "home",
        events: [
          "not an object",
          { type: "nonsense" },
          { type: "link-used" },
          { type: "link-used", token: "tok-unknown" },
          { type: "audit", action: "tapped" },
          { type: "link-used", token: "tok-1", ip: "1.2.3.4" },
        ],
      },
      BOX_TOKEN,
      telegram,
    );

    expect(status).toBe(200);
    // The one usable event was applied.
    expect(telegram.edits).toHaveLength(1);
    expect(telegram.edits[0].text).toContain("1.2.3.4");
    // The audit row without a time cannot be keyed, so it is not a row.
    await readStore("fleet-events-malformed", (instance) => {
      expect(instance.auditLogRows("", 10)).toEqual([]);
    });
  });

  it("answers 400 when the body is not a batch of events", async () => {
    const telegram = new RecordingTelegram();

    const status = await push("fleet-events-bad-body", { id: "home", events: "nope" }, BOX_TOKEN, telegram);

    expect(status).toBe(400);
    expect(telegram.edits).toEqual([]);
  });

  it("keeps the user agent short", async () => {
    const telegram = new RecordingTelegram();

    await push(
      "fleet-events-ua",
      { id: "home", events: [{ type: "audit", at: 1700000000, action: "tapped", ua: "x".repeat(1000) }] },
      BOX_TOKEN,
      telegram,
    );

    await readStore("fleet-events-ua", (instance) => {
      const rows = instance.auditLogRows("", 10);
      expect(rows).toHaveLength(1);
      expect(rows[0].ua).toHaveLength(300);
    });
  });

  // An oversized batch must not pin the brain: the ingest applies what it
  // can and ignores the rest. The ingest takes at most 500 events.
  it("ignores the events past the cap", async () => {
    const telegram = new RecordingTelegram();
    const events = Array.from({ length: 600 }, (_unused, i) => ({
      type: "audit",
      at: 1700000000 + i,
      action: "tapped",
      ip: "1.2.3.4",
    }));

    const status = await push("fleet-events-oversized", { id: "home", events }, BOX_TOKEN, telegram);

    expect(status).toBe(200);
    await readStore("fleet-events-oversized", (instance) => {
      expect(instance.auditLogRows("", 1000)).toHaveLength(500);
    });
  });
});

describe("the edge", () => {
  it("forwards POST /api/events to the DO's /events path", async () => {
    const calls: Array<{ method: string; path: string; body: string; authorization: string | null }> = [];
    const edgeEnv = {
      FLEET_STATE: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (req: Request | string) => {
            const inner = req as Request;
            calls.push({
              method: inner.method,
              path: new URL(inner.url).pathname,
              body: await inner.text(),
              authorization: inner.headers.get("authorization"),
            });
            return new Response("stub-ok");
          },
        }),
      },
    } as unknown as EdgeEnv;

    const body = JSON.stringify({ id: "home", events: [] });
    const res = await app.fetch(
      new Request("https://fleet.local/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BOX_TOKEN}` },
        body,
      }),
      edgeEnv,
    );

    expect(await res.text()).toBe("stub-ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/events");
    expect(calls[0].body).toBe(body);
    // The box's own credential rides along: the DO checks it.
    expect(calls[0].authorization).toBe(`Bearer ${BOX_TOKEN}`);
  });
});

describe("the DO's door", () => {
  // The door takes the events even when the message edit cannot land:
  // only the edit needs Telegram, and the edit stays owed until the
  // alarm sweep drives it. A 500 here would make the boxes push into a
  // dead door.
  it("takes the events even when the edit cannot land", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-events-door"));
    await inState(stub, (instance) => {
      instance.putBox(BOX);
      instance.putLink(link());
    });

    const res = await stub.fetch(
      new Request("https://do/events", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BOX_TOKEN}` },
        body: JSON.stringify({
          id: "home",
          events: [
            { type: "link-used", token: "tok-1", ip: "1.2.3.4" },
            { type: "audit", at: 1700000000, action: "tapped", ip: "1.2.3.4" },
          ],
        }),
      }),
    );

    expect(res.status).toBe(200);
    await readStore("fleet-events-door", (instance) => {
      // The link's state advanced and the history kept the row.
      const row = instance.linkRow("tok-1");
      expect(row?.state).toBe("used");
      expect(row?.edited).toBe(0);
      expect(instance.auditLogRows("", 10)).toHaveLength(1);
    });
  });
});

describe("a brain without a Telegram client", () => {
  // Only the edit needs Telegram: the events land anyway, and the edit
  // stays owed until the alarm sweep drives it.
  it("takes the events and leaves the edit owed", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-events-noclient"));
    await inState(stub, async (instance) => {
      instance.putBox(BOX);
      instance.putLink(link());

      const res = await handleEvents(
        eventRequest({ id: "home", events: [{ type: "link-used", token: "tok-1", ip: "1.2.3.4" }] }, BOX_TOKEN),
        instance,
        { verifyBox: (id, token) => instance.verifyBoxToken(id, token) },
      );

      expect(res.status).toBe(200);
      // The event landed; the edit is still owed.
      expect(instance.linkRow("tok-1")?.state).toBe("used");
      expect(instance.linkRow("tok-1")?.edited).toBe(0);
    });
  });
});
