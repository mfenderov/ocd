import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BoxPublic, BoxRow } from "../src/boxes";
import { boxState } from "../src/botbuttons";
import { BOX_API, BOX_READ_DEADLINE_MS, relayToBox } from "../src/boxapi";
import { sealAdminToken } from "../src/enroll";
import { sweepLiveness, type LivenessStore } from "../src/liveness";
import type { FleetState } from "../src/state";
import type { LinkRow } from "../src/events";
import { handleMintToken } from "../src/tokens";
import type { TelegramClient } from "../src/telegram";
import { inState, requestedUrl } from "./helpers";

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

  sendMessage(chatId: number, text: string): Promise<{ message_id: number }> {
    this.messages.push({ chatId, text });
    return Promise.resolve({ message_id: this.messages.length });
  }

  editMessageText(chatId: number, messageId: number, text: string): Promise<boolean> {
    this.edits.push({ chatId, messageId, text });
    return Promise.resolve(true);
  }

  answerCallbackQuery(): Promise<void> {
    return Promise.resolve();
  }

  setWebhook(): Promise<void> {
    return Promise.resolve();
  }
}

describe("the liveness sweep", () => {
  it("tells the owner once that a silent box is suspected offline", async () => {
    const store = new FakeStore();
    store.boxes.push(box("home", NOW - 200));
    const telegram = new RecordingTelegram();
    const deps = {
      telegram,
      ownerChatId: OWNER_CHAT,
      probePresence: () => Promise.resolve(false),
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
      probePresence: () => Promise.resolve(true),
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
      probePresence: (boxId) => {
        probes.push(boxId);
        return Promise.resolve(false);
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

  // A box the owner revoked on purpose is retired, not offline: the
  // board calls it tombstoned and the mint gate refuses it. Reporting
  // it as offline would put two views of the same fleet against each
  // other.
  it("never reports a box the owner retired", async () => {
    const store = new FakeStore();
    store.boxes.push({ ...box("home", NOW - 200), tombstoned: true });
    const telegram = new RecordingTelegram();
    const probes: string[] = [];

    await sweepLiveness(store, {
      telegram,
      ownerChatId: OWNER_CHAT,
      probePresence: (boxId) => {
        probes.push(boxId);
        return Promise.resolve(false);
      },
      nowSec: () => NOW,
      offlineAfterSec: 90,
    });

    expect(probes).toEqual([]);
    expect(telegram.messages).toEqual([]);
    // No mark either: a later re-enrolment inherits no stale notice.
    expect(store.isSuspectedOffline("home")).toBe(false);
  });

  // The board and the sweep must call the same box ok and offline at
  // the same second.
  it("agrees with the board at the threshold", async () => {
    const store = new FakeStore();
    store.boxes.push(box("home", NOW - 90));
    const telegram = new RecordingTelegram();
    const probes: string[] = [];

    await sweepLiveness(store, {
      telegram,
      ownerChatId: OWNER_CHAT,
      probePresence: (boxId) => {
        probes.push(boxId);
        return Promise.resolve(false);
      },
      nowSec: () => NOW,
      offlineAfterSec: 90,
    });

    expect(boxState(store.boxes[0], NOW)).toBe("ok");
    expect(probes).toEqual([]);
    expect(telegram.messages).toEqual([]);
  });

  // A misconfiguration is the brain's problem, not the box's: the box
  // must not be called dead when the brain could not even ask.
  it("does not call a box dead when the brain could not ask", async () => {
    const store = new FakeStore();
    store.boxes.push(box("home", NOW - 200));
    const telegram = new RecordingTelegram();

    await sweepLiveness(store, {
      telegram,
      ownerChatId: OWNER_CHAT,
      probePresence: () =>
        Promise.reject(new Error("the presence probe cannot run (misconfigured)")),
      nowSec: () => NOW,
      offlineAfterSec: 90,
    });

    expect(telegram.messages).toEqual([]);
    expect(store.isSuspectedOffline("home")).toBe(false);
  });
});

// The box the alarm finds: it stopped heartbeating 200 seconds ago.
const SILENT_BOX: BoxRow = {
  id: "home",
  hostname: "oc-tap-home.buyallmemes.com",
  heartbeat_token_hash: "hb-hash",
  admin_token_hash: "admin-hash",
  admin_token_sealed: "sealed-blob",
  tunnel_id: "",
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

    await inState(stub, (instance: FleetState) => {
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
        probePresence: (boxId: string) => {
          probes.push(boxId);
          return Promise.resolve(false);
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

    await inState(stub, (instance: FleetState) => {
      // The box is marked: the owner was told it went dark.
      expect(instance.isSuspectedOffline("home")).toBe(true);
      // The prune ran: yesterday's dedup row and link are gone.
      expect(instance.seenUpdate(4242)).toBe(true);
      expect(instance.linkRow("tok-old")).toBeUndefined();
      // The edited link is marked: its message says it now.
      expect(instance.linkRow("tok-owed")?.edited).toBe(1);
    });
  });

  // The prune is the cheapest work and the one that must never be
  // skipped, so it runs first: a link past the prune window is dropped
  // before the sweep can edit it. (Its tap link is dead to the box by
  // then too — the box prunes its own link tokens on the same
  // schedule.)
  it("prunes before it edits", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-prune-order"));
    const telegram = new RecordingTelegram();

    await stub.fetch(new Request("https://do/backends"));
    await inState(stub, (instance: FleetState) => {
      instance.putLink(
        link({ token: "tok-ancient", state: "used", used_at: NOW - 90000, created_at: NOW - 90000 }),
      );
      instance.alarmDeps = {
        telegram,
        ownerChatId: OWNER_CHAT,
        probePresence: () => Promise.resolve(false),
        nowSec: () => NOW,
      };
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // The prune came first: the old link is gone and was never edited.
    expect(telegram.edits).toEqual([]);
    await inState(stub, (instance: FleetState) => {
      expect(instance.linkRow("tok-ancient")).toBeUndefined();
    });
  });

  // The owed links are edited oldest first, and at most fifty of them
  // per tick: the alarm must stay short, and a link whose edit fails
  // for good must not hold the queue.
  it("edits the oldest owed links first, and at most fifty of them", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-owed-order"));
    const telegram = new RecordingTelegram();

    await stub.fetch(new Request("https://do/backends"));
    await inState(stub, (instance: FleetState) => {
      // Three named links, oldest first, then a bulk of newer ones.
      instance.putLink(link({ token: "tok-old", message_id: 1, state: "used", used_at: NOW - 300, created_at: NOW - 300 }));
      instance.putLink(link({ token: "tok-mid", message_id: 2, state: "used", used_at: NOW - 250, created_at: NOW - 250 }));
      instance.putLink(link({ token: "tok-new", message_id: 3, state: "used", used_at: NOW - 200, created_at: NOW - 200 }));
      for (let i = 0; i < 60; i++) {
        instance.putLink(
          link({ token: `tok-bulk-${i}`, message_id: 100 + i, state: "expired", created_at: NOW - 100 + i }),
        );
      }
      instance.alarmDeps = {
        telegram,
        ownerChatId: OWNER_CHAT,
        probePresence: () => Promise.resolve(false),
        nowSec: () => NOW,
      };
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // Fifty edits at most, and the oldest owed links first.
    expect(telegram.edits).toHaveLength(50);
    expect(telegram.edits[0].messageId).toBe(1);
    expect(telegram.edits[1].messageId).toBe(2);
    expect(telegram.edits[2].messageId).toBe(3);
    await inState(stub, (instance: FleetState) => {
      // The oldest owed link was edited and marked.
      expect(instance.linkRow("tok-old")?.edited).toBe(1);
      // The link past the cap waits for the next tick.
      expect(instance.linkRow("tok-bulk-47")?.edited).toBe(0);
    });
  });

  // Every step of the alarm gets its own boundary: a step that throws
  // must not skip the steps behind it. A broken owed-edit sweep must
  // not cost the fleet its liveness tick.
  it("a broken owed-edit sweep does not skip the liveness sweep", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-alarm-boundary"));
    const telegram = new RecordingTelegram();
    const probes: string[] = [];

    await stub.fetch(new Request("https://do/backends"));
    await inState(stub, (instance: FleetState) => {
      instance.putBox(SILENT_BOX);
      // The owed-edit sweep breaks: the links cannot be read.
      instance.owedLinks = () => {
        throw new Error("the links table is gone");
      };
      instance.alarmDeps = {
        telegram,
        ownerChatId: OWNER_CHAT,
        probePresence: (boxId: string) => {
          probes.push(boxId);
          return Promise.resolve(false);
        },
        nowSec: () => NOW,
      };
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // The liveness sweep still ran: the box was probed and the owner told.
    expect(probes).toEqual(["home"]);
    expect(telegram.messages).toHaveLength(1);
  });

  // The Durable Object's own probe: a box the brain cannot ask is not a
  // box the brain may call dead. Every other alarm test injects its own
  // probe, so nothing would catch a probe that stopped throwing.
  it("the DO's own probe leaves a box it cannot ask unjudged, and sends no notice", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-probe-seam"));
    const sent: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL) => {
      sent.push(requestedUrl(input));
      // A Telegram answer that lands: a notice that went out would mark
      // the box, so the mark below is a second witness.
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    try {
      // The brain's first request arms the alarm.
      await stub.fetch(new Request("https://do/backends"));
      await inState(stub, async (instance: FleetState) => {
        // A box with no sealed admin token: the brain cannot ask it.
        instance.putBox({ ...SILENT_BOX, id: "noseal", admin_token_sealed: "" });
        // The DO's own probe throws before any network call.
        await expect(instance.alarmDeps.probePresence("noseal")).rejects.toThrow(/misconfigured/);
      });

      // The alarm runs the DO's own probe: alarmDeps is left alone.
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      // Nothing was asked and nothing was sent: the probe never reached
      // for the box, and the owner was not told it is dead.
      expect(sent).toEqual([]);
      await inState(stub, (instance: FleetState) => {
        // The box stays unjudged: no mark, so the owner hears about it
        // once the brain can really ask.
        expect(instance.isSuspectedOffline("noseal")).toBe(false);
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  // A brain that cannot talk to the owner says so: silence would hide
  // a misconfigured brain.
  it("says so when the brain cannot talk to the owner", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-quiet"));
    const errors: string[] = [];

    await stub.fetch(new Request("https://do/backends"));
    await inState(stub, (instance: FleetState) => {
      instance.alarmDeps = {
        // No Telegram client: the brain has nobody to tell.
        probePresence: () => Promise.resolve(false),
        nowSec: () => NOW,
      };
      const globals = globalThis as unknown as Record<string, unknown>;
      globals["__prevError"] = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(String(args[0]));
      };
    });
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    } finally {
      await inState(stub, () => {
        const globals = globalThis as unknown as Record<string, unknown>;
        console.error = globals["__prevError"] as typeof console.error;
        delete globals["__prevError"];
      });
    }

    expect(errors.join("\n")).toContain("the liveness sweep stays quiet");
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
  tunnel_id: "",
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
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, authorization: request.headers.get("authorization") });
      return Promise.resolve(
        new Response('{"id":"home","epoch":1,"version":"dev","taps_24h":0}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

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
    const failing: typeof fetch = () => Promise.reject(new Error("connection refused"));

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
      return (await res.json<{ token: string }>()).token;
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
