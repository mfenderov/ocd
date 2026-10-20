import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BOX_API, BOX_READ_DEADLINE_MS, relayToBox } from "../src/boxapi";
import { sealAdminToken } from "../src/enroll";
import { sweepLiveness, type LivenessStore } from "../src/liveness";
import type { BoxPublic, BoxRow, FleetState } from "../src/state";
import type { LinkRow } from "../src/events";
import { handleMintToken } from "../src/tokens";
import type { TelegramClient } from "../src/telegram";
import { inState } from "./helpers";

// The brain's clock in the tests: a fixed second, so "200 seconds ago"
// means what it says.
const NOW = 1_700_000_000;

// The owner's chat: the brain talks to one chat and to no other.
const OWNER_CHAT = 7;

// A box the fleet knows: its id and the moment it was last seen.
function box(id: string, lastSeen: number): BoxPublic {
  return {
    id,
    hostname: `oc-tap-${id}.buyallmemes.com`,
    epoch: 1,
    last_seq: 1,
    last_ts: 0,
    last_seen: lastSeen,
    enrolled: 1,
    tombstoned: false,
  };
}

// The store the sweep writes to: the boxes it reads and the marks it
// leaves ("the owner was told this box went dark").
class FakeStore implements LivenessStore {
  readonly boxes: BoxPublic[] = [];
  readonly suspected = new Set<string>();

  listBoxes(): BoxPublic[] {
    return this.boxes;
  }

  markSuspectedOffline(boxId: string): void {
    this.suspected.add(boxId);
  }

  clearSuspectedOffline(boxId: string): boolean {
    return this.suspected.delete(boxId);
  }

  isSuspectedOffline(boxId: string): boolean {
    return this.suspected.has(boxId);
  }
}

// The client that remembers the messages the brain sent.
class RecordingTelegram implements TelegramClient {
  readonly messages: Array<{ chatId: number; text: string }> = [];
  readonly edits: Array<{ chatId: number; messageId: number; text: string }> = [];

  async sendMessage(chatId: number, text: string): Promise<{ message_id: number }> {
    this.messages.push({ chatId, text });
    return { message_id: this.messages.length };
  }

  async editMessageText(chatId: number, messageId: number, text: string): Promise<boolean> {
    this.edits.push({ chatId, messageId, text });
    return true;
  }

  async answerCallbackQuery(): Promise<void> {}

  async setWebhook(): Promise<void> {}
}

describe("the liveness sweep", () => {
  it("tells the owner once that a silent box is suspected offline", async () => {
    const store = new FakeStore();
    store.boxes.push(box("home", NOW - 200));
    const telegram = new RecordingTelegram();
    const deps = {
      telegram,
      ownerChatId: OWNER_CHAT,
      probePresence: async () => false,
      nowSec: () => NOW,
      offlineAfterSec: 90,
    };

    await sweepLiveness(store, deps);

    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0].chatId).toBe(OWNER_CHAT);
    expect(telegram.messages[0].text).toContain("home");
    expect(telegram.messages[0].text).toContain("offline");
    expect(store.isSuspectedOffline("home")).toBe(true);

    // The box stays down: the owner hears about it once, not every sweep.
    await sweepLiveness(store, deps);

    expect(telegram.messages).toHaveLength(1);
  });

  it("tells the owner once that the box is back", async () => {
    const store = new FakeStore();
    store.boxes.push(box("home", NOW - 200));
    // The owner was told this box went dark.
    store.markSuspectedOffline("home");
    const telegram = new RecordingTelegram();
    const deps = {
      telegram,
      ownerChatId: OWNER_CHAT,
      probePresence: async () => true,
      nowSec: () => NOW,
      offlineAfterSec: 90,
    };

    await sweepLiveness(store, deps);

    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0].chatId).toBe(OWNER_CHAT);
    expect(telegram.messages[0].text).toContain("home");
    expect(telegram.messages[0].text).toContain("back");
    // The mark is gone: the owner was told, so a later outage is a new
    // outage and gets its own notice.
    expect(store.isSuspectedOffline("home")).toBe(false);

    // The box stays up: the owner hears about the recovery once.
    await sweepLiveness(store, deps);

    expect(telegram.messages).toHaveLength(1);
  });

  // The box came back with a heartbeat, not with the probe. The owner
  // still hears about it — and the mark goes, so the next outage is
  // told about too.
  it("tells the owner that the box is back when it heartbeats again", async () => {
    const store = new FakeStore();
    store.boxes.push(box("home", NOW - 10));
    store.markSuspectedOffline("home");
    const telegram = new RecordingTelegram();
    const probes: string[] = [];

    await sweepLiveness(store, {
      telegram,
      ownerChatId: OWNER_CHAT,
      probePresence: async (boxId) => {
        probes.push(boxId);
        return false;
      },
      nowSec: () => NOW,
      offlineAfterSec: 90,
    });

    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0].text).toContain("back");
    expect(store.isSuspectedOffline("home")).toBe(false);
    // A box that is talking is never probed.
    expect(probes).toEqual([]);
  });
});

// The box the alarm finds: it stopped heartbeating 200 seconds ago.
const SILENT_BOX: BoxRow = {
  id: "home",
  hostname: "oc-tap-home.buyallmemes.com",
  heartbeat_token_hash: "hb-hash",
  admin_token_hash: "admin-hash",
  admin_token_sealed: "sealed-blob",
  epoch: 1,
  last_seq: 1,
  last_ts: 0,
  last_seen: NOW - 200,
  enrolled: 1,
};

// A link the brain handed out.
function link(overrides: Partial<LinkRow> = {}): LinkRow {
  return {
    token: "tok-1",
    box_id: "home",
    chat_id: OWNER_CHAT,
    message_id: 42,
    state: "issued",
    created_at: NOW,
    used_at: 0,
    used_ip: "",
    used_ua: "",
    edited: 0,
    ...overrides,
  };
}

describe("the alarm", () => {
  it("runs the sweep and the prune every time it fires", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-alarm"));
    const telegram = new RecordingTelegram();
    const probes: string[] = [];

    // The brain's first request arms the alarm.
    await stub.fetch(new Request("https://do/backends"));

    await inState(stub, async (instance: FleetState) => {
      instance.putBox(SILENT_BOX);
      // A dedup row and a link from yesterday: both are pruned.
      instance.markUpdateSeen(4242, NOW - 90000);
      instance.putLink(link({ token: "tok-old", created_at: NOW - 90000 }));
      // A spent link whose edit never landed: the alarm must drive it.
      instance.putLink(link({ token: "tok-owed", state: "used", used_at: NOW - 10, used_ip: "1.2.3.4" }));
      // The alarm's own dependencies: the probe answers without the
      // network, the client lands every message.
      instance.alarmDeps = {
        telegram,
        ownerChatId: OWNER_CHAT,
        probePresence: async (boxId: string) => {
          probes.push(boxId);
          return false;
        },
        nowSec: () => NOW,
      };
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // The sweep ran on every tick: the box was probed every time.
    expect(probes).toEqual(["home", "home"]);
    // The owner heard about the outage once, not once per tick.
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0].chatId).toBe(OWNER_CHAT);
    expect(telegram.messages[0].text).toContain("home");
    // The owed edit was re-driven: the message says the link is spent.
    expect(telegram.edits).toHaveLength(1);
    expect(telegram.edits[0].text).toContain("1.2.3.4");

    await inState(stub, async (instance: FleetState) => {
      // The box is marked: the owner was told it went dark.
      expect(instance.isSuspectedOffline("home")).toBe(true);
      // The prune ran: yesterday's dedup row and link are gone.
      expect(instance.seenUpdate(4242)).toBe(true);
      expect(instance.linkRow("tok-old")).toBeUndefined();
      // The edited link is marked: its message says it now.
      expect(instance.linkRow("tok-owed")?.edited).toBe(1);
    });
  });
});

// The box relay: the Worker calls the box over its pinned hostname with
// the sealed admin token.
const SEAL_KEY = "test-seal-key-relay";
const ADMIN_TOKEN = "admin-secret-relay";
const SEALED_ADMIN = await sealAdminToken(SEAL_KEY, ADMIN_TOKEN);

const RELAY_BOX: BoxRow = {
  id: "home",
  hostname: "oc-tap-home.buyallmemes.com",
  heartbeat_token_hash: "hb-hash",
  admin_token_hash: "admin-hash",
  admin_token_sealed: SEALED_ADMIN,
  epoch: 1,
  last_seq: 1,
  last_ts: 0,
  last_seen: NOW,
  enrolled: 1,
};

const RELAY_STORE = {
  getBox: (id: string): BoxRow | undefined => (id === RELAY_BOX.id ? RELAY_BOX : undefined),
};

describe("the box relay", () => {
  it("calls the box over its pinned hostname with the sealed admin token", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as string, init);
      calls.push({ url: request.url, authorization: request.headers.get("authorization") });
      return new Response('{"id":"home","epoch":1,"version":"dev","taps_24h":0}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const relay = await relayToBox(RELAY_STORE, "home", BOX_API.presence, {
      sealKey: SEAL_KEY,
      fetcher,
    });

    expect(relay.answered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oc-tap-home.buyallmemes.com/_oc/presence");
    // The admin token is sealed in the brain and plaintext only on the
    // wire to the box.
    expect(calls[0].authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it("gives up on a box that never answers", async () => {
    // The deadline the controller set: a dead box must not hold the
    // request open. The mint relay's 15 seconds is far too long here.
    expect(BOX_READ_DEADLINE_MS).toBe(3000);

    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;

    const relay = await relayToBox(RELAY_STORE, "home", BOX_API.presence, {
      sealKey: SEAL_KEY,
      deadlineMs: 20,
      fetcher: hanging,
    });

    expect(relay).toEqual({ answered: false, reason: "box_timeout" });
  });

  it("says a box that cannot be reached is unreachable", async () => {
    const failing = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    const relay = await relayToBox(RELAY_STORE, "home", BOX_API.presence, {
      sealKey: SEAL_KEY,
      fetcher: failing,
    });

    expect(relay).toEqual({ answered: false, reason: "box_unreachable" });
  });
});

describe("the console routes", () => {
  it("answers 404 for a box the fleet does not know", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-relay"));
    const token = await inState(stub, async (instance: FleetState) => {
      const res = await handleMintToken(
        new Request("https://fleet.local/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer test-bootstrap-relay" },
          body: JSON.stringify({ scopes: ["audit"] }),
        }),
        instance,
        { bootstrapSecret: "test-bootstrap-relay" },
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { token: string }).token;
    });
    const headers = { authorization: `Bearer ${token}` };

    const presence = await stub.fetch(new Request("https://do/presence/ghost", { headers }));
    expect(presence.status).toBe(404);
    expect(await presence.json()).toMatchObject({ error: "unknown_box" });

    const status = await stub.fetch(new Request("https://do/status/ghost", { headers }));
    expect(status.status).toBe(404);
    expect(await status.json()).toMatchObject({ error: "unknown_box" });
  });
});
