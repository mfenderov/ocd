import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sealAdminToken } from "../src/enroll";
import { handleHeartbeat, hashToken } from "../src/heartbeat";
import app from "../src/index";
import {
  handleRevoke,
  handleRevokeAll,
  revokeAllBoxes,
  revokeOneBox,
  type RevokeStore,
} from "../src/revoke";
import type { BoxRow } from "../src/state";
import type { TombstoneRow } from "../src/mint";

const SEAL_KEY = "test-seal-key-revoke-5";
const ADMIN_PLAIN = "revoke-admin-plaintext-5";

class MemStore implements RevokeStore {
  boxes = new Map<string, BoxRow>();
  tombstones = new Map<string, TombstoneRow>();
  getBox(id: string): BoxRow | undefined {
    return this.boxes.get(id);
  }
  putBox(box: BoxRow): void {
    this.boxes.set(box.id, { ...box });
  }
  listBackends(): BoxRow[] {
    return [...this.boxes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  getTombstone(boxId: string): TombstoneRow | undefined {
    return this.tombstones.get(boxId);
  }
  putTombstone(row: TombstoneRow): void {
    this.tombstones.set(row.box_id, { ...row });
  }
  deleteTombstone(boxId: string): void {
    this.tombstones.delete(boxId);
  }
}

async function seedBox(store: MemStore, id: string, epoch = 1): Promise<BoxRow> {
  const box: BoxRow = {
    id,
    hostname: `${id}.example.com`,
    heartbeat_token_hash: await hashToken("hb-token"),
    admin_token_hash: await hashToken(ADMIN_PLAIN),
    admin_token_sealed: await sealAdminToken(SEAL_KEY, ADMIN_PLAIN),
    epoch,
    last_seq: 7,
    last_ts: 1000,
    last_seen: 1700000000,
    enrolled: 1,
  };
  store.boxes.set(id, box);
  return box;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function confirmRequest(path: string, body: unknown): Request {
  return new Request(`https://fleet.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function epochFetcher(epoch: number, calls: FetchCall[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init ?? {} });
    return Response.json({ epoch });
  }) as typeof fetch;
}

const offlineFetcher = (async () => {
  throw new Error("conn refused");
}) as typeof fetch;

describe("revoke confirm gate (unit)", () => {
  it("missing confirm is 400 and never touches the box", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-confirm");
    const calls: FetchCall[] = [];
    for (const body of [{}, { confirm: false }, { confirm: "yes" }, null, []]) {
      const res = await handleRevoke("rev-confirm", confirmRequest("/x", body), store, {
        sealKey: SEAL_KEY,
        fetcher: epochFetcher(2, calls),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "confirm_required" });
    }
    expect(calls).toHaveLength(0);
    expect(store.getTombstone("rev-confirm")).toBeUndefined();
  });

  it("revoke-all without confirm is 400 with no per-box work", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-all-confirm");
    const calls: FetchCall[] = [];
    const res = await handleRevokeAll(confirmRequest("/x", {}), store, {
      sealKey: SEAL_KEY,
      fetcher: epochFetcher(2, calls),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("revoke single box (unit)", () => {
  it("online box: POSTs pinned /admin/revoke with confirm:true, writes greatest-stale tombstone", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-ok", 1);
    const calls: FetchCall[] = [];
    const result = await revokeOneBox("rev-ok", store, {
      sealKey: SEAL_KEY,
      fetcher: epochFetcher(2, calls),
    });
    expect(result).toMatchObject({ id: "rev-ok", status: "revoked", epoch: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://rev-ok.example.com/admin/revoke");
    expect(calls[0].init.method).toBe("POST");
    expect(await new Request(calls[0].url, calls[0].init).json()).toEqual({ confirm: true });
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${ADMIN_PLAIN}`);
    // Greatest stale epoch: box rotated 1 -> 2, so 1 stays tainted.
    expect(store.getTombstone("rev-ok")).toEqual({ box_id: "rev-ok", epoch: 1 });
  });

  it("offline box gets a sticky tombstone at its last-known epoch, never a silent skip", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-off", 1);
    const result = await revokeOneBox("rev-off", store, {
      sealKey: SEAL_KEY,
      fetcher: offlineFetcher,
    });
    expect(result).toMatchObject({ id: "rev-off", status: "tombstoned", epoch: 1 });
    expect(store.getTombstone("rev-off")).toEqual({ box_id: "rev-off", epoch: 1 });
  });

  it("box timeout also tombstones (deadline), not a silent skip", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-timeout", 3);
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "TimeoutError")));
      })) as typeof fetch;
    const result = await revokeOneBox("rev-timeout", store, {
      sealKey: SEAL_KEY,
      fetcher: hanging,
      deadlineMs: 20,
    });
    expect(result).toMatchObject({ id: "rev-timeout", status: "tombstoned", epoch: 3 });
    expect(store.getTombstone("rev-timeout")).toEqual({ box_id: "rev-timeout", epoch: 3 });
  });

  it("200 with unparseable epoch fails closed: tombstoned with box_bad_epoch", async () => {
    const bodies = [
      "ok",
      JSON.stringify({}),
      JSON.stringify({ epoch: "2" }),
      JSON.stringify({ epoch: -1 }),
      JSON.stringify(null),
    ];
    for (const body of bodies) {
      const store = new MemStore();
      await seedBox(store, "rev-badepoch", 1);
      const fetcher = (async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      const result = await revokeOneBox("rev-badepoch", store, { sealKey: SEAL_KEY, fetcher });
      expect(result).toMatchObject({
        id: "rev-badepoch",
        status: "tombstoned",
        epoch: 1,
        detail: "box_bad_epoch",
      });
      expect(store.getTombstone("rev-badepoch")).toEqual({ box_id: "rev-badepoch", epoch: 1 });
    }
  });

  it("success never lowers a pre-existing higher tombstone", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-keep", 1);
    store.putTombstone({ box_id: "rev-keep", epoch: 5 });
    const calls: FetchCall[] = [];
    const result = await revokeOneBox("rev-keep", store, {
      sealKey: SEAL_KEY,
      fetcher: epochFetcher(2, calls),
    });
    expect(result).toMatchObject({ id: "rev-keep", status: "revoked", epoch: 2 });
    expect(store.getTombstone("rev-keep")).toEqual({ box_id: "rev-keep", epoch: 5 });
  });

  it("unknown box is unknown_box without fetching", async () => {
    const store = new MemStore();
    const calls: FetchCall[] = [];
    const result = await revokeOneBox("ghost", store, {
      sealKey: SEAL_KEY,
      fetcher: epochFetcher(2, calls),
    });
    expect(result).toMatchObject({ id: "ghost", status: "unknown_box" });
    expect(calls).toHaveLength(0);
  });

  it("box non-200 is a per-box box_error with no tombstone", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-err", 1);
    const fetcher = (async () => new Response("mint first", { status: 409 })) as typeof fetch;
    const result = await revokeOneBox("rev-err", store, { sealKey: SEAL_KEY, fetcher });
    expect(result).toMatchObject({ id: "rev-err", status: "box_error", box_status: 409 });
    expect(store.getTombstone("rev-err")).toBeUndefined();
  });

  it("missing seal key or admin token is misconfigured without fetching", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-noseal", 1);
    const calls: FetchCall[] = [];
    expect(
      await revokeOneBox("rev-noseal", store, { fetcher: epochFetcher(2, calls) }),
    ).toMatchObject({ status: "misconfigured" });
    const box = store.getBox("rev-noseal");
    if (box) {
      store.boxes.set("rev-noseal", { ...box, admin_token_sealed: "" });
    }
    expect(
      await revokeOneBox("rev-noseal", store, { sealKey: SEAL_KEY, fetcher: epochFetcher(2, calls) }),
    ).toMatchObject({ status: "misconfigured" });
    expect(calls).toHaveLength(0);
    expect(store.getTombstone("rev-noseal")).toBeUndefined();
  });
});

describe("revoke-all (unit)", () => {
  it("returns a per-box result for every box: online revoked, offline tombstoned", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-all-on", 1);
    await seedBox(store, "rev-all-off", 4);
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.toString().includes("rev-all-off")) {
        throw new Error("conn refused");
      }
      return Response.json({ epoch: 2 });
    }) as typeof fetch;
    const results = await revokeAllBoxes(store, { sealKey: SEAL_KEY, fetcher });
    expect(results).toEqual([
      { id: "rev-all-off", status: "tombstoned", epoch: 4, detail: "box_unreachable" },
      { id: "rev-all-on", status: "revoked", epoch: 2 },
    ]);
    expect(store.getTombstone("rev-all-off")).toEqual({ box_id: "rev-all-off", epoch: 4 });
    expect(store.getTombstone("rev-all-on")).toEqual({ box_id: "rev-all-on", epoch: 1 });
  });
});

describe("heartbeat taint signal (unit)", () => {
  function hbRequest(id: string, seq: number, boxNow: number, epoch: number, token = "hb-token"): Request {
    return new Request("https://fleet.local/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, seq, box_now: boxNow, epoch }),
    });
  }

  it("stale-epoch heartbeat reads tainted; rotated epoch heals and clears the tombstone", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-hb", 1);
    store.putTombstone({ box_id: "rev-hb", epoch: 1 });
    const stale = await handleHeartbeat(hbRequest("rev-hb", 8, 2000, 1), store, () => 1700000300);
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ id: "rev-hb", tainted: true });
    expect(store.getTombstone("rev-hb")).toEqual({ box_id: "rev-hb", epoch: 1 });
    const healed = await handleHeartbeat(hbRequest("rev-hb", 9, 3000, 2), store, () => 1700000400);
    expect(healed.status).toBe(200);
    expect(await healed.json()).toMatchObject({ id: "rev-hb", tainted: false });
    expect(store.getTombstone("rev-hb")).toBeUndefined();
  });

  it("heartbeat without a tombstone reads clean", async () => {
    const store = new MemStore();
    await seedBox(store, "rev-hb-clean", 1);
    const res = await handleHeartbeat(hbRequest("rev-hb-clean", 8, 2000, 1), store, () => 1700000300);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "rev-hb-clean", tainted: false });
  });
});

describe("revoke routes through the worker + DO", () => {
  it("POST /api/backends/:id/revoke without confirm is 400", async () => {
    const res = await SELF.fetch("https://fleet.local/api/backends/route-revoke-nc/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/backends/:id/revoke on unknown box is 404", async () => {
    const res = await SELF.fetch("https://fleet.local/api/backends/route-revoke-ghost/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/revoke-all without confirm is 400", async () => {
    const res = await SELF.fetch("https://fleet.local/api/revoke-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // Test env carries no seal secret (by design — Worker secrets are never
  // committed), so the route pins the fail-loud degraded behavior: 500
  // misconfigured with no tombstone and no box contact. The tombstoned path
  // is covered at unit level above.
  it("offline box via the route fails loud without a seal key, writes nothing", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    await runInDurableObject(stub, async (instance) => {
      instance.putBox({
        id: "route-revoke-off",
        hostname: "route-revoke-off.invalid",
        heartbeat_token_hash: await hashToken("hb-token"),
        admin_token_hash: await hashToken(ADMIN_PLAIN),
        admin_token_sealed: await sealAdminToken(SEAL_KEY, ADMIN_PLAIN),
        epoch: 1,
        last_seq: 7,
        last_ts: 1000,
        last_seen: 1700000000,
        enrolled: 1,
      });
    });
    const res = await SELF.fetch("https://fleet.local/api/backends/route-revoke-off/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ id: "route-revoke-off", status: "misconfigured" });
    const tombstone = await runInDurableObject(stub, async (instance) =>
      instance.getTombstone("route-revoke-off"),
    );
    expect(tombstone).toBeUndefined();
  });

  it("stale-epoch heartbeat through the route reads tainted", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    await runInDurableObject(stub, async (instance) => {
      instance.putBox({
        id: "route-revoke-hb",
        hostname: "route-revoke-hb.example.com",
        heartbeat_token_hash: await hashToken("hb-route-token"),
        admin_token_hash: await hashToken(ADMIN_PLAIN),
        admin_token_sealed: "",
        epoch: 1,
        last_seq: 7,
        last_ts: 1000,
        last_seen: 1700000000,
        enrolled: 1,
      });
      instance.putTombstone({ box_id: "route-revoke-hb", epoch: 1 });
    });
    const res = await SELF.fetch("https://fleet.local/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer hb-route-token" },
      body: JSON.stringify({ id: "route-revoke-hb", seq: 8, box_now: 2000, epoch: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "route-revoke-hb", tainted: true });
  });

  it("fails loud when the FLEET_STATE binding is missing", async () => {
    const single = await app.fetch(
      new Request("http://x/api/backends/b/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(single.status).toBe(500);
    expect(await single.text()).toContain("FLEET_STATE");
    const all = await app.fetch(
      new Request("http://x/api/revoke-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(all.status).toBe(500);
    expect(await all.text()).toContain("FLEET_STATE");
  });
});
