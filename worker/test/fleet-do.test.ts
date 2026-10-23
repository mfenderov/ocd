import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { boxAdapter, BOX_READ_DEADLINE_MS } from "../src/boxapi";
import type { BoxRow } from "../src/boxes";
import { sealAdminToken, unsealAdminToken } from "../src/sealedtoken";
import type { FleetState } from "../src/state";
import type { OwnerChat } from "../src/owner";
import { handleMintToken } from "../src/tokens";
import { inState, requestedUrl } from "./helpers";

// The seal secret the test env configures (vitest.config.ts): the brain
// reads the box's admin token with it.
const SEAL_KEY = "test-admin-seal-secret";

const BOX: BoxRow = {
  id: "box-1",
  hostname: "host-1",
  heartbeat_token_hash: "hb-hash",
  admin_token_hash: "admin-hash",
  admin_token_sealed: "sealed-blob",
  tunnel_id: "",
  epoch: 1,
  last_seq: 7,
  last_ts: 0,
  last_seen: 1700000000,
  enrolled: 1,
};

const PUBLIC_BOX = {
  id: "box-1",
  hostname: "host-1",
  epoch: 1,
  last_seq: 7,
  last_ts: 0,
  last_seen: 1700000000,
  enrolled: 1,
  tombstoned: false,
};

// Token minted in the first test (bootstrap is single-use: once a token
// exists the bootstrap bearer 403s, so later tests reuse this bearer).
let backendsToken = "";

describe("fleet DO (real SQLite backend)", () => {
  it("GET /api/backends returns [] on fresh state from the DO path", async () => {
    // Guarded backends reads need an audit-scope token; the first fetch pins
    // the 401 for anonymous callers before the seeded read below.
    const anon = await SELF.fetch("https://fleet.local/api/backends");
    expect(anon.status).toBe(401);
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    const routeToken = await inState(stub, async (instance) => {
      const res = await handleMintToken(
        new Request("https://fleet.local/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer test-bootstrap-backends-2" },
          body: JSON.stringify({}),
        }),
        instance,
        { bootstrapSecret: "test-bootstrap-backends-2" },
      );
      expect(res.status).toBe(200);
      return (await res.json<{ token: string }>()).token;
    });
    const authed = { authorization: `Bearer ${routeToken}` };
    backendsToken = routeToken;
    const fresh = await SELF.fetch("https://fleet.local/api/backends", { headers: authed });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual([]);

    // Seed the real "fleet" DO behind the route. If the route served the
    // no-env fallback instead of the DO, this row would never appear.
    await inState(stub, (instance) => {
      instance.putBox(BOX);
    });

    const seeded = await SELF.fetch("https://fleet.local/api/backends", { headers: authed });
    expect(seeded.status).toBe(200);
    const rows = await seeded.json<Array<Record<string, unknown>>>();
    expect(rows).toEqual([PUBLIC_BOX]);
    // Secret material must never leave the DO over this route.
    for (const row of rows) {
      expect(row).not.toHaveProperty("heartbeat_token_hash");
      expect(row).not.toHaveProperty("admin_token_hash");
      expect(row).not.toHaveProperty("admin_token_sealed");
    }
    expect(JSON.stringify(rows)).not.toContain("hb-hash");
    expect(JSON.stringify(rows)).not.toContain("admin-hash");
    expect(JSON.stringify(rows)).not.toContain("sealed-blob");
  });

  it("listBackends projects the public shape; listBoxes keeps the full row", async () => {
    const stub = env.FLEET_STATE.get(
      env.FLEET_STATE.idFromName("fleet-write-read"),
    );
    const rows = await inState(stub, (instance) => {
      instance.putBox(BOX);
      return instance.listBackends();
    });
    expect(rows).toEqual([PUBLIC_BOX]);
    const full = await inState(stub, (instance) => instance.listBoxes());
    expect(full).toEqual([{ ...BOX }]);
  });

  it("keeps the tunnel id on the box row and on the pending row", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-tunnel"));
    // The columns live in the DO's own SQLite: a row that names a tunnel
    // must come back with it.
    const rows = await inState(stub, (instance) => {
      instance.putBox({ ...BOX, id: "tun-box", tunnel_id: "tunnel-abc" });
      instance.putPending({
        id: "tun-pending",
        hostname: "oc-tap-tun-pending.buyallmemes.com",
        heartbeat_token_hash: "hb-hash",
        admin_token_sealed: "",
        tunnel_id: "tunnel-pending-id",
        first_seen: 1700000000,
        trusted: 0,
      });
      return {
        box: instance.getBox("tun-box")?.tunnel_id,
        pending: instance.getPending("tun-pending")?.tunnel_id,
      };
    });
    expect(rows).toEqual({ box: "tunnel-abc", pending: "tunnel-pending-id" });
  });

  it("GET /api/backends marks a server-side tombstoned box tombstoned:true", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    // Tombstone at the box's own epoch: isTainted holds, no heartbeat heal.
    await inState(stub, (instance) => {
      instance.putBox({ ...BOX, id: "box-tomb-1", hostname: "host-tomb-1" });
      instance.putTombstone({ box_id: "box-tomb-1", epoch: 1 });
    });
    const res = await SELF.fetch("https://fleet.local/api/backends", {
      headers: { authorization: `Bearer ${backendsToken}` },
    });
    expect(res.status).toBe(200);
    const rows = await res.json<Array<Record<string, unknown>>>();
    const tomb = rows.find((r) => r["id"] === "box-tomb-1");
    expect(tomb).toMatchObject({ id: "box-tomb-1", tombstoned: true });
    // Untombstoned boxes stay false so the console can tell them apart.
    expect(rows.find((r) => r["id"] === "box-1")).toMatchObject({ tombstoned: false });
  });
});

// The Telegram client is the seam the command layer answers through: the
// test records what the brain would have sent to the owner.
function recordingTelegram(replies: string[]): OwnerChat {
  return {
    say: (_chatId, text) => {
      replies.push(text);
      return Promise.resolve({ id: replies.length });
    },
    replace: () => Promise.resolve(true),
    answerTap: () => Promise.resolve(),
  };
}

// The /status relay: the brain asks the box and prints the box's own
// line. Nothing else drives it, so nothing else proves it works.
describe("the /status relay", () => {
  it("prints the line the box answered with", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-status"));
    const asked: string[] = [];
    const replies: string[] = [];
    await inState(stub, async (instance) => {
      const globals = globalThis as unknown as Record<string, unknown>;
      globals["__prevFetch"] = globalThis.fetch;
      globalThis.fetch = (input: RequestInfo | URL) => {
        asked.push(requestedUrl(input));
        return Promise.resolve(
          new Response("running\n", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        );
      };
      instance.putBox({
        ...BOX,
        id: "home",
        hostname: "status-box.example",
        admin_token_sealed: await sealAdminToken(SEAL_KEY, "admin-plain"),
      });
    });
    try {
      await inState(stub, async (instance) => {
        await instance.dispatchCommand({ name: "/status", args: [], chatId: 7 }, recordingTelegram(replies));
      });
      // The box was asked over its pinned hostname, on the status route.
      expect(asked).toEqual(["https://status-box.example/_oc/status"]);
      expect(replies[0]).toContain("running");
    } finally {
      await inState(stub, () => {
        const globals = globalThis as unknown as Record<string, unknown>;
        globalThis.fetch = globals["__prevFetch"] as typeof fetch;
        delete globals["__prevFetch"];
      });
    }
  });

  it("says the box did not answer when the box is gone", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-status-gone"));
    const replies: string[] = [];
    await inState(stub, async (instance) => {
      const globals = globalThis as unknown as Record<string, unknown>;
      globals["__prevFetch"] = globalThis.fetch;
      globalThis.fetch = () => Promise.reject(new Error("the box is gone"));
      instance.putBox({
        ...BOX,
        id: "home",
        hostname: "status-box.example",
        admin_token_sealed: await sealAdminToken(SEAL_KEY, "admin-plain"),
      });
    });
    try {
      await inState(stub, async (instance) => {
        await instance.dispatchCommand({ name: "/status", args: [], chatId: 7 }, recordingTelegram(replies));
      });
      // The owner is told the box did not answer, not that the status is
      // empty: an empty line would read as a healthy box.
      expect(replies[0]).toContain("the box did not answer");
    } finally {
      await inState(stub, () => {
        const globals = globalThis as unknown as Record<string, unknown>;
        globalThis.fetch = globals["__prevFetch"] as typeof fetch;
        delete globals["__prevFetch"];
      });
    }
  });
});

// The box relay: the Worker calls the box over its pinned hostname with
// the sealed admin token.
const RELAY_SEAL_KEY = "test-seal-key-relay";
const RELAY_ADMIN_TOKEN = "admin-secret-relay";
const RELAY_SEALED_ADMIN = await sealAdminToken(RELAY_SEAL_KEY, RELAY_ADMIN_TOKEN);
const RELAY_NOW = 1_700_000_000;

const RELAY_BOX: BoxRow = {
  id: "home",
  hostname: "oc-tap-home.buyallmemes.com",
  heartbeat_token_hash: "hb-hash",
  admin_token_hash: "admin-hash",
  admin_token_sealed: RELAY_SEALED_ADMIN,
  tunnel_id: "",
  epoch: 1,
  last_seq: 1,
  last_ts: 0,
  last_seen: RELAY_NOW,
  enrolled: 1,
};

const RELAY_STORE = {
  getBox: (id: string): BoxRow | undefined => (id === RELAY_BOX.id ? RELAY_BOX : undefined),
};

// The admin token the brain carries to the box: sealed at rest, opened
// at call time.
async function relayToken(): Promise<string> {
  const token = await unsealAdminToken(RELAY_SEAL_KEY, RELAY_SEALED_ADMIN);
  if (token === null) {
    throw new Error("the sealed admin token did not unseal");
  }
  return token;
}

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

    const relay = await boxAdapter(RELAY_STORE, { fetcher }).presence("home", await relayToken());

    expect(relay.kind).toBe("answered");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oc-tap-home.buyallmemes.com/_oc/presence");
    // The admin token is sealed in the brain and plaintext only on the
    // wire to the box.
    expect(calls[0].authorization).toBe(`Bearer ${RELAY_ADMIN_TOKEN}`);
  });

  it("gives up on a box that never answers", async () => {
    // The deadline the controller set: a dead box must not hold the
    // request open. The mint relay's 15 seconds is far too long here.
    expect(BOX_READ_DEADLINE_MS).toBe(3000);

    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;

    const relay = await boxAdapter(RELAY_STORE, { deadlineMs: 20, fetcher: hanging }).presence(
      "home",
      await relayToken(),
    );

    expect(relay).toEqual({ kind: "silent", reason: "box_timeout" });
  });

  it("says a box that cannot be reached is unreachable", async () => {
    const failing: typeof fetch = () => Promise.reject(new Error("connection refused"));

    const relay = await boxAdapter(RELAY_STORE, { fetcher: failing }).presence("home", await relayToken());

    expect(relay).toEqual({ kind: "silent", reason: "box_unreachable" });
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
