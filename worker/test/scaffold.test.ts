import { describe, expect, it } from "vitest";
import app from "../src/index";

// minimal fetch handler test: no FLEET_STATE binding must fail loud, never silent []
describe("backends", () => {
  it("fails loud when the FLEET_STATE binding is missing", async () => {
    const res = await app.fetch(new Request("http://x/api/backends"));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("FLEET_STATE");
  });
});
