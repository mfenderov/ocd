import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
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
import type { BoxRow } from "../src/state";
import { inState } from "./helpers";

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
  return inState(stub, async (instance) => {
    const box: BoxRow = {
      id,
      hostname: `${id}.example.com`,
      heartbeat_token_hash: HB_HASH,
      admin_token_hash: ADMIN_HASH,
      admin_token_sealed: "",
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
  return inState(stub, async (instance) => instance.getBox(id));
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
    const registry = await inState(stub, async (instance) =>
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
    const hostname = await inState(stub, async (instance) =>
      instance.pinnedHostname("hb-do"),
    );
    expect(hostname).toBe("hb-do.example.com");
    await expect(
      inState(stub, async (instance) => instance.pinnedHostname("ghost")),
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
    const res = await handleHeartbeat(hbRequest("hb-reset", 1), store, () => 1700000400, undefined, async (id: string) => {
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
    const onReenroll = async (id: string) => {
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
      async (id: string) => {
        mismatches.push(id);
      },
      async (id: string) => {
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
