import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BoxRow } from "../src/state";

const BOX: BoxRow = {
  id: "box-1",
  hostname: "host-1",
  heartbeat_token_hash: "hb-hash",
  admin_token_hash: "admin-hash",
  epoch: 1,
  last_seq: 7,
  last_seen: 1700000000,
  enrolled: 1,
};

describe("fleet DO (real SQLite backend)", () => {
  it("GET /api/backends returns [] on fresh state from the DO path", async () => {
    const fresh = await SELF.fetch("https://fleet.local/api/backends");
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual([]);

    // Seed the real "fleet" DO behind the route. If the route served the
    // no-env fallback instead of the DO, this row would never appear.
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    await runInDurableObject(stub, async (instance) => {
      instance.putBox(BOX);
    });

    const seeded = await SELF.fetch("https://fleet.local/api/backends");
    expect(seeded.status).toBe(200);
    expect(await seeded.json()).toEqual([{ ...BOX }]);
  });

  it("writes a box row through FleetState and reads it back via listBackends", async () => {
    const stub = env.FLEET_STATE.get(
      env.FLEET_STATE.idFromName("fleet-write-read"),
    );
    const rows = await runInDurableObject(stub, async (instance) => {
      instance.putBox(BOX);
      return instance.listBackends();
    });
    expect(rows).toEqual([{ ...BOX }]);
  });
});
