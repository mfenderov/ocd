import { describe, expect, it } from "vitest";
import app from "../src/index";

// minimal fetch handler test via miniflare-style stub
describe("backends", () => {
  it("returns empty list on fresh state", async () => {
    const res = await app.fetch(new Request("http://x/api/backends"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
