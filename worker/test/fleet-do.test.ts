import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BoxRow } from "../src/boxes";
import { sealAdminToken } from "../src/sealedtoken";
import type { TelegramClient } from "../src/ports";
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
function recordingTelegram(replies: string[]): TelegramClient {
  return {
    sendMessage: (_chatId, text) => {
      replies.push(text);
      return Promise.resolve({ message_id: replies.length });
    },
    editMessageText: () => Promise.resolve(true),
    answerCallbackQuery: () => Promise.resolve(),
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
