import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BoxRow } from "../src/boxes";
import { hashToken } from "../src/heartbeat";
import type { FleetState } from "../src/state";
import type { LinkRow } from "../src/events";
import type { OwnerChat } from "../src/owner";
import { inState } from "./helpers";

// The brain's clock in the tests: a fixed second, so "200 seconds ago"
// means what it says.
const NOW = 1_700_000_000;

// The owner's chat: the brain talks to one chat and to no other.
const OWNER_CHAT = 7;

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

// The client that remembers the messages the brain sent.
class RecordingTelegram implements OwnerChat {
  readonly messages: Array<{ chatId: number; text: string }> = [];
  readonly edits: Array<{ chatId: number; messageId: number; text: string }> = [];

  say(chatId: number, text: string): Promise<{ id: number }> {
    this.messages.push({ chatId, text });
    return Promise.resolve({ id: this.messages.length });
  }

  replace(chatId: number, messageId: number, text: string): Promise<boolean> {
    this.edits.push({ chatId, messageId, text });
    return Promise.resolve(true);
  }

  answerTap(): Promise<void> {
    return Promise.resolve();
  }
}

describe("the alarm", () => {
  it("runs the owed edits and the prune every time it fires", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-alarm"));
    const telegram = new RecordingTelegram();

    // The brain's first request arms the alarm.
    await stub.fetch(new Request("https://do/backends"));

    await inState(stub, (instance: FleetState) => {
      instance.putBox(SILENT_BOX);
      // A dedup row and a link from yesterday: both are pruned.
      instance.markUpdateSeen(4242, NOW - 90000);
      instance.putLink(link({ token: "tok-old", created_at: NOW - 90000 }));
      // A spent link whose edit never landed: the alarm must drive it.
      instance.putLink(link({ token: "tok-owed", state: "used", used_at: NOW - 10, used_ip: "1.2.3.4" }));
      // The alarm's own dependencies: the client lands every message.
      instance.alarmDeps = {
        telegram,
        nowSec: () => NOW,
      };
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // The owed edit was re-driven: the message says the link is spent.
    expect(telegram.edits).toHaveLength(1);
    expect(telegram.edits[0].text).toContain("1.2.3.4");

    await inState(stub, (instance: FleetState) => {
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
});

// Offline is a normal state for this fleet — both boxes sleep — so the
// brain never announces it. A box that goes quiet and comes back must
// produce zero Telegram messages: no offline notice, no recovery.
describe("the silent fleet", () => {
  it("a box that goes quiet and comes back sends nothing", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-silence"));
    const telegram = new RecordingTelegram();
    const hbToken = "hb-silence-secret";

    // The brain's first request arms the alarm.
    await stub.fetch(new Request("https://do/backends"));
    await inState(stub, async (instance: FleetState) => {
      instance.putBox({
        ...SILENT_BOX,
        id: "quiet",
        heartbeat_token_hash: await hashToken(hbToken),
      });
      instance.alarmDeps = {
        telegram,
        nowSec: () => NOW,
      };
    });

    // The quiet tick: the box has not heartbeated for 200 seconds.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // The box comes back: a real heartbeat, replay guard and all.
    const back = await stub.fetch(
      new Request("https://do/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${hbToken}` },
        body: JSON.stringify({ id: "quiet", seq: 2, box_now: 1, epoch: 1 }),
      }),
    );
    expect(back.status).toBe(200);

    // The back tick: the box is talking again.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // A full quiet-and-back cycle, and the owner heard nothing: the
    // board already renders 🟢/🔴 straight from last_seen, so there is
    // nothing to announce.
    expect(telegram.messages).toEqual([]);
    expect(telegram.edits).toEqual([]);
  });
});
