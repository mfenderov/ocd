import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fetchBox,
  fetchUrlPinned,
  hashToken,
  pinnedHostname,
  pinnedRegistry,
} from "../src/heartbeat";
import type { BoxRow } from "../src/state";

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
  return runInDurableObject(stub, async (instance) => {
    const box: BoxRow = {
      id,
      hostname: `${id}.example.com`,
      heartbeat_token_hash: HB_HASH,
      admin_token_hash: ADMIN_HASH,
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
  return runInDurableObject(stub, async (instance) => instance.getBox(id));
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
    const registry = await runInDurableObject(stub, async (instance) =>
      pinnedRegistry(instance.listBackends()),
    );
    expect(pinnedHostname(registry, "hb-pin")).toBe("hb-pin.example.com");
    expect(() => pinnedHostname(registry, "ghost")).toThrow();
    // Heartbeat-supplied URL is never fetched: refused before any network call.
    await expect(fetchUrlPinned(registry, "https://evil.example/pwn")).rejects.toThrow();
    await expect(fetchBox(registry, "ghost", "/admin/audit")).rejects.toThrow();
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
    const hostname = await runInDurableObject(stub, async (instance) =>
      instance.pinnedHostname("hb-do"),
    );
    expect(hostname).toBe("hb-do.example.com");
    await expect(
      runInDurableObject(stub, async (instance) => instance.pinnedHostname("ghost")),
    ).rejects.toThrow();
  });
});
