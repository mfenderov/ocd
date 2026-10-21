import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { BoxRow } from "../src/boxes";
import { hashToken } from "../src/heartbeat";
import { sealAdminToken } from "../src/enroll";
import { handleMintLink, isTainted, type MintStore, type TombstoneRow } from "../src/mint";
import { handleMintToken } from "../src/tokens";
import { inState } from "./helpers";

const SEAL_KEY = "test-seal-key-mint-4";
const ADMIN_PLAIN = "mint-admin-plaintext-9";
const BOOTSTRAP = "test-bootstrap-mint-route-2";

// Guarded link routes need a link-scope token; one all-scopes token covers
// this file (narrow-scope denials live in scopes.test.ts).
let routeToken = "";

beforeAll(async () => {
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  routeToken = await inState(stub, async (instance) => {
    const res = await handleMintToken(
      new Request("https://fleet.local/tokens", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${BOOTSTRAP}` },
        body: JSON.stringify({}),
      }),
      instance,
      { bootstrapSecret: BOOTSTRAP },
    );
    expect(res.status).toBe(200);
    return (await res.json<{ token: string }>()).token;
  });
});

class MemStore implements MintStore {
  boxes = new Map<string, BoxRow>();
  tombstones = new Map<string, TombstoneRow>();
  getBox(id: string): BoxRow | undefined {
    return this.boxes.get(id);
  }
  getTombstone(boxId: string): TombstoneRow | undefined {
    return this.tombstones.get(boxId);
  }
}

async function seedBox(store: MemStore, id: string, epoch = 1): Promise<BoxRow> {
  const box: BoxRow = {
    id,
    hostname: `${id}.example.com`,
    heartbeat_token_hash: await hashToken("hb-token"),
    admin_token_hash: await hashToken(ADMIN_PLAIN),
    admin_token_sealed: await sealAdminToken(SEAL_KEY, ADMIN_PLAIN),
    tunnel_id: "",
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

function stubFetcher(status: number, body: string, calls: FetchCall[]): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
}

describe("mint relay idempotency (unit)", () => {
  it("same console retry reuses one key: box sees a single key, same URL twice", async () => {
    const store = new MemStore();
    await seedBox(store, "mint-retry");
    const calls: FetchCall[] = [];
    const fetcher = stubFetcher(200, "https://proxy.example/?t=tok-1", calls);
    const first = await handleMintLink("mint-retry", "console-key-abc", store, {
      sealKey: SEAL_KEY,
      fetcher,
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("https://proxy.example/?t=tok-1");
    const second = await handleMintLink("mint-retry", "console-key-abc", store, {
      sealKey: SEAL_KEY,
      fetcher,
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("https://proxy.example/?t=tok-1");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://mint-retry.example.com/_oc/mint");
    const keys = calls.map((c) => new Headers(c.init.headers).get("idempotency-key"));
    expect(keys).toEqual(["console-key-abc", "console-key-abc"]);
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${ADMIN_PLAIN}`);
  });

  it("generates one key per console request when the console sends none", async () => {
    const store = new MemStore();
    await seedBox(store, "mint-gen");
    const calls: FetchCall[] = [];
    const fetcher = stubFetcher(200, "https://proxy.example/?t=tok-2", calls);
    await handleMintLink("mint-gen", null, store, { sealKey: SEAL_KEY, fetcher });
    await handleMintLink("mint-gen", null, store, { sealKey: SEAL_KEY, fetcher });
    const keys = calls.map((c) => new Headers(c.init.headers).get("idempotency-key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("tainted box is refused before any fetch", async () => {
    const store = new MemStore();
    await seedBox(store, "mint-taint", 1);
    store.tombstones.set("mint-taint", { box_id: "mint-taint", epoch: 1 });
    expect(isTainted(1, store.getTombstone("mint-taint"))).toBe(true);
    const calls: FetchCall[] = [];
    const res = await handleMintLink("mint-taint", "console-key-x", store, {
      sealKey: SEAL_KEY,
      fetcher: stubFetcher(200, "https://proxy.example/?t=nope", calls),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "tainted" });
    expect(calls).toHaveLength(0);
  });

  it("box rotated past the tombstone epoch is clean again", async () => {
    const store = new MemStore();
    await seedBox(store, "mint-healed", 2);
    store.tombstones.set("mint-healed", { box_id: "mint-healed", epoch: 1 });
    expect(isTainted(2, store.getTombstone("mint-healed"))).toBe(false);
    const calls: FetchCall[] = [];
    const res = await handleMintLink("mint-healed", "console-key-y", store, {
      sealKey: SEAL_KEY,
      fetcher: stubFetcher(200, "https://proxy.example/?t=tok-3", calls),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("box 429 surfaces verbatim", async () => {
    const store = new MemStore();
    await seedBox(store, "mint-429");
    const calls: FetchCall[] = [];
    const res = await handleMintLink("mint-429", "console-key-z", store, {
      sealKey: SEAL_KEY,
      fetcher: stubFetcher(429, "wait a bit before next link", calls),
    });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("wait a bit before next link");
  });

  it("box 502 surfaces verbatim", async () => {
    const store = new MemStore();
    await seedBox(store, "mint-502");
    const res = await handleMintLink("mint-502", "console-key-z", store, {
      sealKey: SEAL_KEY,
      fetcher: stubFetcher(502, "mint failed", []),
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("mint failed");
  });

  it("unknown box is 404 without fetching", async () => {
    const store = new MemStore();
    const calls: FetchCall[] = [];
    const res = await handleMintLink("ghost", "console-key-z", store, {
      sealKey: SEAL_KEY,
      fetcher: stubFetcher(200, "https://proxy.example/?t=nope", calls),
    });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("box timeout is 504, network failure is 502", async () => {
    const store = new MemStore();
    await seedBox(store, "mint-timeout");
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "TimeoutError")));
      })) as typeof fetch;
    const timedOut = await handleMintLink("mint-timeout", "k1", store, {
      sealKey: SEAL_KEY,
      fetcher: hanging,
      deadlineMs: 20,
    });
    expect(timedOut.status).toBe(504);
    const down: typeof fetch = () => Promise.reject(new Error("conn refused"));
    const unreachable = await handleMintLink("mint-timeout", "k2", store, {
      sealKey: SEAL_KEY,
      fetcher: down,
    });
    expect(unreachable.status).toBe(502);
  });

  it("missing seal key or missing admin token fails loud 500", async () => {
    const store = new MemStore();
    await seedBox(store, "mint-noseal");
    const calls: FetchCall[] = [];
    const noKey = await handleMintLink("mint-noseal", "k", store, {
      fetcher: stubFetcher(200, "https://proxy.example/?t=nope", calls),
    });
    expect(noKey.status).toBe(500);
    expect(calls).toHaveLength(0);
    const box = store.getBox("mint-noseal");
    if (box) {
      store.boxes.set("mint-noseal", { ...box, admin_token_sealed: "" });
    }
    const noToken = await handleMintLink("mint-noseal", "k", store, {
      sealKey: SEAL_KEY,
      fetcher: stubFetcher(200, "https://proxy.example/?t=nope", calls),
    });
    expect(noToken.status).toBe(500);
    expect(calls).toHaveLength(0);
  });
});

describe("mint route through the worker + DO", () => {
  it("POST /api/backends/:id/link on unknown box is 404", async () => {
    const res = await SELF.fetch("https://fleet.local/api/backends/route-ghost/link", {
      method: "POST",
      headers: { authorization: `Bearer ${routeToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/backends/:id/link on a tainted box is 409 without box contact", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    await inState(stub, async (instance) => {
      instance.putBox({
        id: "route-tainted",
        hostname: "route-tainted.example.com",
        heartbeat_token_hash: await hashToken("hb-token"),
        admin_token_hash: await hashToken(ADMIN_PLAIN),
        admin_token_sealed: await sealAdminToken(SEAL_KEY, ADMIN_PLAIN),
        tunnel_id: "",
        epoch: 1,
        last_seq: 7,
        last_ts: 1000,
        last_seen: 1700000000,
        enrolled: 1,
      });
      instance.putTombstone({ box_id: "route-tainted", epoch: 1 });
    });
    const res = await SELF.fetch("https://fleet.local/api/backends/route-tainted/link", {
      method: "POST",
      headers: { "idempotency-key": "route-key-1", authorization: `Bearer ${routeToken}` },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "tainted" });
  });
});
