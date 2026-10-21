import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BoxRow } from "../src/boxes";
import {
  fetchBox,
  fetchUrlPinned,
  handleHeartbeat,
  hashToken,
  pinnedHostname,
  pinnedRegistry,
  reenrollPingText,
  REENROLL_SEQ_THRESHOLD,
  shouldPingMismatch,
} from "../src/heartbeat";
import { inState, requestedUrl } from "./helpers";

const TOKEN = "hb-test-secret-1";
const ADMIN_TOKEN = "admin-test-secret-1";
let HB_HASH = "";
let ADMIN_HASH = "";

beforeAll(async () => {
  HB_HASH = await hashToken(TOKEN);
  ADMIN_HASH = await hashToken(ADMIN_TOKEN);
});

function seedBox(id: string, overrides: Partial<BoxRow> = {}): Promise<BoxRow> {
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  return inState(stub, (instance) => {
    const box: BoxRow = {
      id,
      hostname: `${id}.example.com`,
      heartbeat_token_hash: HB_HASH,
      admin_token_hash: ADMIN_HASH,
      admin_token_sealed: "",
      tunnel_id: "",
      epoch: 1,
      last_seq: 7,
      last_ts: 0,
      last_seen: 1700000000,
      enrolled: 1,
    };
    Object.assign(box, overrides);
    instance.putBox(box);
    return box;
  });
}

function readBox(id: string): Promise<BoxRow | undefined> {
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  return inState(stub, (instance) => instance.getBox(id));
}

function postHeartbeat(body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return SELF.fetch("https://fleet.local/api/heartbeat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("heartbeat ingest", () => {
  it("accepts a fresh heartbeat and updates presence", async () => {
    await seedBox("hb-ok");
    const before = Math.floor(Date.now() / 1000);
    const res = await postHeartbeat({
      id: "hb-ok",
      seq: 8,
      box_now: 1700000030,
      epoch: 1,
      version: "0.1.0",
      taps_24h: 3,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "hb-ok", enrolled: true });
    const row = await readBox("hb-ok");
    expect(row?.last_seq).toBe(8);
    expect(row?.last_seen).toBeGreaterThanOrEqual(before);
  });

  it("rejects a stale seq without touching presence", async () => {
    await seedBox("hb-stale");
    for (const seq of [7, 3]) {
      const res = await postHeartbeat({ id: "hb-stale", seq, box_now: 1700000030, epoch: 1 });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "stale_seq" });
    }
    expect((await readBox("hb-stale"))?.last_seq).toBe(7);
  });

  it("rejects a replayed box timestamp even with a fresh seq", async () => {
    await seedBox("hb-replay");
    const first = await postHeartbeat({ id: "hb-replay", seq: 8, box_now: 1000, epoch: 1 });
    expect(first.status).toBe(200);
    for (const body of [
      { id: "hb-replay", seq: 9, box_now: 1000, epoch: 1 },
      { id: "hb-replay", seq: 10, box_now: 999, epoch: 1 },
    ]) {
      const res = await postHeartbeat(body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "replayed_timestamp" });
    }
    expect((await readBox("hb-replay"))?.last_seq).toBe(8);
  });

  it("rejects bad, missing, admin, and unknown-id credentials", async () => {
    await seedBox("hb-auth");
    const bad: Array<{ body: unknown; token: string | null }> = [
      { body: { id: "hb-auth", seq: 8, box_now: 1700000030, epoch: 1 }, token: "wrong" },
      { body: { id: "hb-auth", seq: 8, box_now: 1700000030, epoch: 1 }, token: null },
      { body: { id: "hb-auth", seq: 8, box_now: 1700000030, epoch: 1 }, token: ADMIN_TOKEN },
      { body: { id: "ghost", seq: 8, box_now: 1700000030, epoch: 1 }, token: TOKEN },
    ];
    for (const { body, token } of bad) {
      const res = await postHeartbeat(body, token);
      expect(res.status).toBe(401);
    }
    expect((await readBox("hb-auth"))?.last_seq).toBe(7);
  });

  it("rejects malformed heartbeat bodies", async () => {
    await seedBox("hb-ok");
    const res = await postHeartbeat({ id: "hb-ok" });
    expect(res.status).toBe(400);
  });

  it("refuses fetches to unknown or heartbeat-supplied hostnames", async () => {
    await seedBox("hb-pin");
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    const registry = await inState(stub, (instance) =>
      pinnedRegistry(instance.listBackends()),
    );
    expect(pinnedHostname(registry, "hb-pin")).toBe("hb-pin.example.com");
    expect(() => pinnedHostname(registry, "ghost")).toThrow();
    // Heartbeat-supplied URL is never fetched: refused before any network call.
    await expect(fetchUrlPinned(registry, "https://evil.example/pwn")).rejects.toThrow();
    await expect(fetchBox(registry, "ghost", "/_oc/audit")).rejects.toThrow();
  });

  it("ignores heartbeat-supplied hostname/URL and keeps the pinned one", async () => {
    await seedBox("hb-ssrf", { hostname: "real.example.com" });
    const res = await postHeartbeat({
      id: "hb-ssrf",
      seq: 8,
      box_now: 2000,
      epoch: 1,
      hostname: "evil.example",
      url: "https://evil.example/x",
    });
    expect(res.status).toBe(200);
    expect((await readBox("hb-ssrf"))?.hostname).toBe("real.example.com");
  });

  it("resolves pinned hostnames from the DO and throws on unknown ids", async () => {
    await seedBox("hb-do");
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    const hostname = await inState(stub, (instance) =>
      instance.pinnedHostname("hb-do"),
    );
    expect(hostname).toBe("hb-do.example.com");
    await expect(
      inState(stub, (instance) => instance.pinnedHostname("ghost")),
    ).rejects.toThrow();
  });
});

describe("seq-reset re-enroll signal", () => {
  const TOKEN = "hb-reenroll-token-1";

  class HbMemStore {
    boxes = new Map<string, BoxRow>();
    constructor(box: BoxRow) {
      this.boxes.set(box.id, { ...box });
    }
    getBox(id: string): BoxRow | undefined {
      return this.boxes.get(id);
    }
    putBox(box: BoxRow): void {
      this.boxes.set(box.id, { ...box });
    }
  }

  async function resetStore(id: string, lastSeq: number): Promise<HbMemStore> {
    return new HbMemStore({
      id,
      hostname: `${id}.buyallmemes.com`,
      heartbeat_token_hash: await hashToken(TOKEN),
      admin_token_hash: "",
      admin_token_sealed: "",
      tunnel_id: "",
      epoch: 1,
      last_seq: lastSeq,
      last_ts: 9000,
      last_seen: 1700000000,
      enrolled: 1,
    });
  }

  function hbRequest(id: string, seq: number): Request {
    return new Request("https://fleet.local/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id, seq, box_now: 9999, epoch: 1 }),
    });
  }

  it("low incoming seq on stale_seq 409s with re_enroll_required + exactly one ping", async () => {
    const store = await resetStore("hb-reset", 500);
    const pings: string[] = [];
    const res = await handleHeartbeat(hbRequest("hb-reset", 1), store, () => 1700000400, undefined, (id: string) => {
      pings.push(reenrollPingText(id));
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_seq", code: "re_enroll_required" });
    expect(pings).toHaveLength(1);
    expect(pings[0]).toContain("hb-reset");
    expect(pings[0]).not.toContain(TOKEN);
    // Nothing accepted: presence untouched, still bricked on retry, still pinging.
    expect(store.getBox("hb-reset")?.last_seq).toBe(500);
  });

  it("threshold-boundary seq still signals; high stale_seq 409s silently", async () => {
    const store = await resetStore("hb-edge", 500);
    const pings: string[] = [];
    const onReenroll = (id: string) => {
      pings.push(reenrollPingText(id));
    };
    const edge = await handleHeartbeat(hbRequest("hb-edge", REENROLL_SEQ_THRESHOLD), store, () => 1700000400, undefined, onReenroll);
    expect(edge.status).toBe(409);
    expect(await edge.json()).toMatchObject({ code: "re_enroll_required" });
    expect(pings).toHaveLength(1);
    const high = await handleHeartbeat(hbRequest("hb-edge", 499), store, () => 1700000400, undefined, onReenroll);
    expect(high.status).toBe(409);
    expect(await high.json()).toEqual({ error: "stale_seq" });
    expect(pings).toHaveLength(1);
    expect(store.getBox("hb-edge")?.last_seq).toBe(500);
  });

  it("wrong token never signals re-enroll (401 + mismatch path only)", async () => {
    const store = await resetStore("hb-authe", 500);
    const pings: string[] = [];
    const mismatches: string[] = [];
    const bad = new Request("https://fleet.local/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ id: "hb-authe", seq: 1, box_now: 9999, epoch: 1 }),
    });
    const res = await handleHeartbeat(
      bad,
      store,
      () => 1700000400,
      (id: string) => {
        mismatches.push(id);
      },
      (id: string) => {
        pings.push(reenrollPingText(id));
      },
    );
    expect(res.status).toBe(401);
    expect(mismatches).toEqual(["hb-authe"]);
    expect(pings).toHaveLength(0);
  });
});

describe("mismatch ping dedup", () => {
  it("pings once per window, then again after", () => {
    const seen = new Map<string, number>();
    expect(shouldPingMismatch(seen, "box-1", 1_000, 900_000)).toBe(true);
    expect(shouldPingMismatch(seen, "box-1", 2_000, 900_000)).toBe(false);
    expect(shouldPingMismatch(seen, "box-2", 3_000, 900_000)).toBe(true);
    expect(shouldPingMismatch(seen, "box-1", 1_000 + 900_001, 900_000)).toBe(true);
  });
});

describe("the owner's pings", () => {
  const TOKEN = "hb-owner-ping-token";
  const BOX = "hb-owner-ping";

  // The owner's Telegram sink, counted: every send is one owner ping.
  // The stub answers like the Bot API, so the ping really goes out.
  function countOwnerPings(): string[] {
    const sent: string[] = [];
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestedUrl(input);
      if (!url.includes("api.telegram.org")) {
        return Promise.reject(new Error(`the test suite made an outbound fetch: ${url}`));
      }
      // The body is JSON text: the brain sends text, never a blob.
      const body = JSON.parse((init?.body ?? "{}") as string) as { text?: string };
      sent.push(body.text ?? "");
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    return sent;
  }

  // The brain's own Durable Object, so the ping ledgers of a test are its
  // own.
  async function seedBoxIn(name: string, id: string, lastSeq: number): Promise<void> {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName(name));
    await inState(stub, async (instance) => {
      instance.putBox({
        id,
        hostname: `${id}.example.com`,
        heartbeat_token_hash: await hashToken(TOKEN),
        admin_token_hash: "",
        admin_token_sealed: "",
        tunnel_id: "",
        epoch: 1,
        last_seq: lastSeq,
        last_ts: 9000,
        last_seen: 1893499200,
        enrolled: 1,
      });
    });
  }

  function beat(name: string, body: unknown, token: string = TOKEN): Promise<Response> {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName(name));
    return stub.fetch(
      new Request("https://do/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
  }

  it("pings the owner once per window, then again after the window", async () => {
    const sent = countOwnerPings();
    await seedBoxIn("owner-ping-window", BOX, 500);

    // Only Date is faked, so the brain's clock can be walked without
    // waiting for it. The fake now is in the future: the brain's alarm
    // never comes due while the test runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));

      // The box lost its DB: every heartbeat is rejected with the same
      // 409, and the owner hears about it once — not once per heartbeat.
      for (let i = 0; i < 5; i++) {
        const res = await beat("owner-ping-window", { id: BOX, seq: 1, box_now: 9999, epoch: 1 });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: "stale_seq", code: "re_enroll_required" });
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(BOX);
      expect(sent[0]).not.toContain(TOKEN);

      // The window closes: the next rejected heartbeat pings again.
      vi.setSystemTime(new Date("2030-01-01T12:16:00Z"));
      const later = await beat("owner-ping-window", { id: BOX, seq: 1, box_now: 9999, epoch: 1 });
      expect(later.status).toBe(409);
      expect(sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // A wrong token and a lost DB are different facts about the same box.
  // Each has its own ledger, so neither warning may silence the other.
  it("a mismatch ping does not silence the seq-reset ping", async () => {
    const sent = countOwnerPings();
    await seedBoxIn("owner-ping-both", BOX, 500);

    // The wrong token: the mismatch warning.
    const wrong = await beat(
      "owner-ping-both",
      { id: BOX, seq: 1, box_now: 9999, epoch: 1 },
      "not-the-box-token",
    );
    expect(wrong.status).toBe(401);

    // The same box with the right token and a reset-looking seq: the
    // seq-reset warning, which must not be swallowed by the first one.
    const reset = await beat("owner-ping-both", { id: BOX, seq: 1, box_now: 9999, epoch: 1 });
    expect(reset.status).toBe(409);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("Auth mismatch");
    expect(sent[1]).toContain("seq reset suspected");
  });
});
