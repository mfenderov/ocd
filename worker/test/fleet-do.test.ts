import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BoxRow } from "../src/state";
import { handleMintToken } from "../src/tokens";
import { inState } from "./helpers";

const BOX: BoxRow = {
  id: "box-1",
  hostname: "host-1",
  heartbeat_token_hash: "hb-hash",
  admin_token_hash: "admin-hash",
  admin_token_sealed: "sealed-blob",
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
      return ((await res.json()) as { token: string }).token;
    });
    const authed = { authorization: `Bearer ${routeToken}` };
    backendsToken = routeToken;
    const fresh = await SELF.fetch("https://fleet.local/api/backends", { headers: authed });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual([]);

    // Seed the real "fleet" DO behind the route. If the route served the
    // no-env fallback instead of the DO, this row would never appear.
    await inState(stub, async (instance) => {
      instance.putBox(BOX);
    });

    const seeded = await SELF.fetch("https://fleet.local/api/backends", { headers: authed });
    expect(seeded.status).toBe(200);
    const rows = (await seeded.json()) as Array<Record<string, unknown>>;
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
    const rows = await inState(stub, async (instance) => {
      instance.putBox(BOX);
      return instance.listBackends();
    });
    expect(rows).toEqual([PUBLIC_BOX]);
    const full = await inState(stub, async (instance) => instance.listBoxes());
    expect(full).toEqual([{ ...BOX }]);
  });

  it("GET /api/backends marks a server-side tombstoned box tombstoned:true", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    // Tombstone at the box's own epoch: isTainted holds, no heartbeat heal.
    await inState(stub, async (instance) => {
      instance.putBox({ ...BOX, id: "box-tomb-1", hostname: "host-tomb-1" });
      instance.putTombstone({ box_id: "box-tomb-1", epoch: 1 });
    });
    const res = await SELF.fetch("https://fleet.local/api/backends", {
      headers: { authorization: `Bearer ${backendsToken}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const tomb = rows.find((r) => r["id"] === "box-tomb-1");
    expect(tomb).toMatchObject({ id: "box-tomb-1", tombstoned: true });
    // Untombstoned boxes stay false so the console can tell them apart.
    expect(rows.find((r) => r["id"] === "box-1")).toMatchObject({ tombstoned: false });
  });
});
