import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AUDIT_DEADLINE_MS,
  fetchAudits,
  handleAudit,
  parseAuditN,
  UnknownBoxError,
} from "../src/audit";
import type { AuditStore } from "../src/audit";
import { sealAdminToken } from "../src/enroll";
import { hashToken } from "../src/heartbeat";
import app from "../src/index";
import type { TombstoneRow } from "../src/mint";
import type { BoxRow } from "../src/state";
import { handleMintToken } from "../src/tokens";
import { inState } from "./helpers";

const BOOTSTRAP = "test-bootstrap-audit-route-2";

// Guarded audit reads need an audit-scope token; one all-scopes token covers
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
    return ((await res.json()) as { token: string }).token;
  });
});

const SEAL_KEY = "test-seal-key-audit-6";
const ADMIN_PLAIN = "audit-admin-plaintext-6";

class MemStore implements AuditStore {
  boxes = new Map<string, BoxRow>();
  tombstones = new Map<string, TombstoneRow>();
  getBox(id: string): BoxRow | undefined {
    return this.boxes.get(id);
  }
  listBoxes(): BoxRow[] {
    return [...this.boxes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  getTombstone(boxId: string): TombstoneRow | undefined {
    return this.tombstones.get(boxId);
  }
}

async function seedBox(store: MemStore, id: string, overrides: Partial<BoxRow> = {}): Promise<BoxRow> {
  const box: BoxRow = {
    id,
    hostname: `${id}.example.com`,
    heartbeat_token_hash: await hashToken("hb-token"),
    admin_token_hash: await hashToken(ADMIN_PLAIN),
    admin_token_sealed: await sealAdminToken(SEAL_KEY, ADMIN_PLAIN),
    epoch: 1,
    last_seq: 7,
    last_ts: 1000,
    last_seen: 1700000000,
    enrolled: 1,
    ...overrides,
  };
  store.boxes.set(id, box);
  return box;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function seedRow(at: number, actor: string): Record<string, unknown> {
  return { at, actor, action: "tapped", device: "dev", ip: "127.0.0.1", result: "ok", ua: "curl/8" };
}

function rowsFetcher(entries: Array<[string, unknown]>, calls: FetchCall[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init ?? {} });
    for (const [part, body] of entries) {
      if (url.toString().includes(part)) {
        return Response.json(body);
      }
    }
    throw new Error("conn refused");
  }) as typeof fetch;
}

describe("audit n parsing (unit)", () => {
  it("defaults to 50, caps at 200, rejects garbage like the box contract", () => {
    expect(AUDIT_DEADLINE_MS).toBe(5_000);
    expect(parseAuditN(null)).toBe(50);
    expect(parseAuditN("")).toBe(50);
    expect(parseAuditN("abc")).toBe(50);
    expect(parseAuditN("0")).toBe(50);
    expect(parseAuditN("-5")).toBe(50);
    expect(parseAuditN("5")).toBe(5);
    expect(parseAuditN("200")).toBe(200);
    expect(parseAuditN("5000")).toBe(200);
  });
});

describe("audit merge (unit)", () => {
  it("sorts by box event time, not receipt order", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-a");
    await seedBox(store, "audit-b");
    const calls: FetchCall[] = [];
    const fetcher = rowsFetcher(
      [
        ["audit-a", [seedRow(1699999900, "a-new"), seedRow(1699999700, "a-old")]],
        ["audit-b", [seedRow(1699999800, "b-mid")]],
      ],
      calls,
    );
    const rows = await fetchAudits(store, { n: 50 }, { sealKey: SEAL_KEY, fetcher });
    expect(calls).toHaveLength(2);
    // Receipt order is [a-new, a-old, b-mid]; event-time desc is [a-new, b-mid, a-old].
    expect(rows.map((r) => (r as { actor?: string }).actor)).toEqual(["a-new", "b-mid", "a-old"]);
    expect(rows.map((r) => r.at)).toEqual([1699999900, 1699999800, 1699999700]);
  });

  it("a slow box hits its deadline while fast box rows still return", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-fast", { last_seen: 1700000001 });
    await seedBox(store, "audit-slow", { last_seen: 1700000002 });
    const start = Date.now();
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.includes("audit-slow")) {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "TimeoutError")));
        });
        throw new Error("unreachable after abort");
      }
      return Response.json([seedRow(1699999990, "fast-actor")]);
    }) as typeof fetch;
    const rows = await fetchAudits(store, { n: 50 }, { sealKey: SEAL_KEY, fetcher, deadlineMs: 30 });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(rows).toHaveLength(2);
    // Marker carries last-synced time, so it sorts first here.
    expect(rows[0]).toMatchObject({ box: "audit-slow", error: "box_timeout", last_seen: 1700000002 });
    expect(rows[1]).toMatchObject({ box: "audit-fast", actor: "fast-actor", tainted: false });
  });

  it("an offline box yields a last-synced marker, never a silent gap", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-off", { last_seen: 1700000123 });
    const failing = (async () => {
      throw new Error("conn refused");
    }) as typeof fetch;
    const rows = await fetchAudits(store, { n: 50 }, { sealKey: SEAL_KEY, fetcher: failing });
    expect(rows).toEqual([
      { box: "audit-off", at: 1700000123, error: "box_unreachable", last_seen: 1700000123, tainted: false },
    ]);
  });

  it("box non-200 and garbled 200s become per-box error rows", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-500");
    await seedBox(store, "audit-garbled");
    await seedBox(store, "audit-shaped");
    const fetcher = (async (url: string) => {
      if (url.includes("audit-500")) {
        return new Response("boom", { status: 500 });
      }
      if (url.includes("audit-garbled")) {
        return new Response("{oops", { status: 200 });
      }
      return Response.json({ at: 1 });
    }) as typeof fetch;
    const rows = await fetchAudits(store, { n: 50 }, { sealKey: SEAL_KEY, fetcher });
    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual(
      expect.objectContaining({ box: "audit-500", error: "box_error", detail: "status 500" }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ box: "audit-garbled", error: "box_error", detail: "box_bad_json" }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ box: "audit-shaped", error: "box_error", detail: "box_bad_json" }),
    );
  });

  it("a tainted box still returns rows, marked — tombstones never filter audit", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-tainted", { epoch: 1 });
    await seedBox(store, "audit-clean", { epoch: 2 });
    store.tombstones.set("audit-tainted", { box_id: "audit-tainted", epoch: 1 });
    const calls: FetchCall[] = [];
    const fetcher = rowsFetcher(
      [
        ["audit-tainted", [seedRow(1699999900, "tainted-actor")]],
        ["audit-clean", [seedRow(1699999800, "clean-actor")]],
      ],
      calls,
    );
    const rows = await fetchAudits(store, { n: 50 }, { sealKey: SEAL_KEY, fetcher });
    // Both boxes were fetched: taint refused nothing.
    expect(calls).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ box: "audit-tainted", actor: "tainted-actor", tainted: true });
    expect(rows[1]).toMatchObject({ box: "audit-clean", actor: "clean-actor", tainted: false });
  });

  it("an offline tainted box marker carries tainted:true", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-off-tainted", { epoch: 1, last_seen: 1700000123 });
    store.tombstones.set("audit-off-tainted", { box_id: "audit-off-tainted", epoch: 1 });
    const failing = (async () => {
      throw new Error("conn refused");
    }) as typeof fetch;
    const rows = await fetchAudits(store, { n: 50 }, { sealKey: SEAL_KEY, fetcher: failing });
    expect(rows).toEqual([
      { box: "audit-off-tainted", at: 1700000123, error: "box_unreachable", last_seen: 1700000123, tainted: true },
    ]);
  });

  it("event rows carry the box id plus the exact snake_case box fields", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-shape");
    const fetcher = rowsFetcher([["audit-shape", [seedRow(1699999900, "shaped")]]], []);
    const rows = await fetchAudits(store, { n: 50 }, { sealKey: SEAL_KEY, fetcher });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["action", "actor", "at", "box", "device", "ip", "result", "tainted", "ua"],
    );
  });

  it("?box= narrows the fan-out to one box without touching others", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-only-a");
    await seedBox(store, "audit-only-b");
    const calls: FetchCall[] = [];
    const fetcher = rowsFetcher([["audit-only-b", [seedRow(1699999900, "b-only")]]], calls);
    const rows = await fetchAudits(store, { boxId: "audit-only-b", n: 50 }, { sealKey: SEAL_KEY, fetcher });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://audit-only-b.example.com/_oc/audit?n=50");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer audit-admin-plaintext-6");
    expect(rows).toEqual([
      {
        box: "audit-only-b",
        at: 1699999900,
        actor: "b-only",
        action: "tapped",
        device: "dev",
        ip: "127.0.0.1",
        result: "ok",
        ua: "curl/8",
        tainted: false,
      },
    ]);
  });

  it("unknown ?box= is 404 without fetching", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-known");
    const calls: FetchCall[] = [];
    const res = await handleAudit(new Request("https://fleet.local/audit?box=ghost"), store, {
      sealKey: SEAL_KEY,
      fetcher: rowsFetcher([], calls),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_box" });
    expect(calls).toHaveLength(0);
  });

  it("n is forwarded to each box: explicit, defaulted, and capped", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-n");
    for (const [query, want] of [["?n=5", "n=5"], ["", "n=50"], ["?n=abc", "n=50"], ["?n=5000", "n=200"]] as const) {
      const calls: FetchCall[] = [];
      const res = await handleAudit(new Request(`https://fleet.local/audit${query}`), store, {
        sealKey: SEAL_KEY,
        fetcher: rowsFetcher([["audit-n", []]], calls),
      });
      expect(res.status).toBe(200);
      expect(Object.keys(await res.json())).toEqual(["rows"]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`https://audit-n.example.com/_oc/audit?${want}`);
    }
  });

  it("missing seal key or missing admin token yields per-box misconfigured rows, zero fetches", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-noseal");
    const calls: FetchCall[] = [];
    const noKey = await fetchAudits(store, { n: 50 }, { fetcher: rowsFetcher([["audit-noseal", []]], calls) });
    expect(noKey).toEqual([
      { box: "audit-noseal", at: 1700000000, error: "misconfigured", last_seen: 1700000000, tainted: false },
    ]);
    const box = store.getBox("audit-noseal");
    if (box) {
      store.boxes.set("audit-noseal", { ...box, admin_token_sealed: "" });
    }
    const noToken = await fetchAudits(store, { n: 50 }, { sealKey: SEAL_KEY, fetcher: rowsFetcher([["x", []]], calls) });
    expect(noToken).toEqual([
      { box: "audit-noseal", at: 1700000000, error: "misconfigured", last_seen: 1700000000, tainted: false },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("merged top-n cut keeps exactly the n newest events across boxes", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-cut-a");
    await seedBox(store, "audit-cut-b");
    const fetcher = rowsFetcher(
      [
        ["audit-cut-a", [seedRow(1699999900, "a1"), seedRow(1699999700, "a2"), seedRow(1699999600, "a3"), seedRow(1699999500, "a4"), seedRow(1699999400, "a5")]],
        ["audit-cut-b", [seedRow(1699999850, "b1"), seedRow(1699999750, "b2"), seedRow(1699999650, "b3"), seedRow(1699999550, "b4"), seedRow(1699999450, "b5")]],
      ],
      [],
    );
    const rows = await fetchAudits(store, { n: 4 }, { sealKey: SEAL_KEY, fetcher });
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => (r as { actor?: string }).actor)).toEqual(["a1", "b1", "b2", "a2"]);
    expect(rows.map((r) => r.at)).toEqual([1699999900, 1699999850, 1699999750, 1699999700]);
  });

  it("fetchAudits with an unknown boxId throws UnknownBoxError instead of a silent []", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-known");
    const calls: FetchCall[] = [];
    await expect(
      fetchAudits(store, { boxId: "ghost", n: 50 }, { sealKey: SEAL_KEY, fetcher: rowsFetcher([], calls) }),
    ).rejects.toThrow(UnknownBoxError);
    expect(calls).toHaveLength(0);
  });

  it("programmer errors propagate instead of masking as box_unreachable", async () => {
    const store = new MemStore();
    await seedBox(store, "audit-badfetch");
    const nullFetcher = (async () => null) as unknown as typeof fetch;
    await expect(
      fetchAudits(store, { n: 50 }, { sealKey: SEAL_KEY, fetcher: nullFetcher }),
    ).rejects.toThrow(TypeError);
  });
});

describe("audit routes through the worker + DO", () => {
  it("GET /api/audit?box=ghost is 404", async () => {
    const res = await SELF.fetch("https://fleet.local/api/audit?box=route-audit-ghost", {
      headers: { authorization: `Bearer ${routeToken}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_box" });
  });

  it("known box without a seal key yields a misconfigured marker row with 200", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    await inState(stub, async (instance) => {
      instance.putBox({
        id: "route-audit-known",
        hostname: "route-audit-known.example.com",
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
    const res = await SELF.fetch("https://fleet.local/api/audit?box=route-audit-known", {
      headers: { authorization: `Bearer ${routeToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [
        { box: "route-audit-known", at: 1700000000, error: "misconfigured", last_seen: 1700000000, tainted: false },
      ],
    });
  });

  it("unfiltered GET /api/audit is 200 with a rows array", async () => {
    const res = await SELF.fetch("https://fleet.local/api/audit", {
      headers: { authorization: `Bearer ${routeToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows).toContainEqual({
      box: "route-audit-known",
      at: 1700000000,
      error: "misconfigured",
      last_seen: 1700000000,
      tainted: false,
    });
  });

  it("fails loud when the FLEET_STATE binding is missing", async () => {
    const res = await app.fetch(new Request("http://x/api/audit?box=b"));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("FLEET_STATE");
  });
});
