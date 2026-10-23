// The probe must not trust the edge's error pages.
//
// When a box's tunnel dies, Cloudflare answers /_oc/presence itself:
// 530 "tunnel not connected" / "error 1033", or a plain-text
// "error code: NNN" page on a status the box also uses. fetch resolves,
// so without an edge check the probe reads answered and the sweep stays
// blind: never red, never green.
import { describe, expect, it } from "vitest";
import { boxAdapter } from "../src/boxapi";
import type { BoxRow } from "../src/boxes";

const BOX: BoxRow = {
  id: "home",
  hostname: "oc-tap-home.buyallmemes.com",
  heartbeat_token_hash: "hb-hash",
  admin_token_hash: "admin-hash",
  admin_token_sealed: "sealed-blob",
  tunnel_id: "",
  epoch: 1,
  last_seq: 1,
  last_ts: 0,
  last_seen: 0,
  enrolled: 1,
};

const STORE = {
  getBox: (id: string): BoxRow | undefined => (id === BOX.id ? BOX : undefined),
};

const TOKEN = "admin-secret";

function edgeFetcher(status: number, body: string): typeof fetch {
  return () => Promise.resolve(new Response(body, { status, headers: { "content-type": "text/html" } }));
}

describe("the presence probe against the edge", () => {
  it("a 530 edge page is silence, not an answer", async () => {
    const fetcher = edgeFetcher(
      530,
      "<html><body>Web server is returning an unknown error<br/>error code: 1033</body></html>",
    );
    const reply = await boxAdapter(STORE, { fetcher }).presence(BOX.id, TOKEN);
    expect(reply).toEqual({ kind: "silent", reason: "box_unreachable" });
  });

  it("an error-code body is silence even on a box status", async () => {
    const fetcher = edgeFetcher(403, "error code: 1033");
    const reply = await boxAdapter(STORE, { fetcher }).presence(BOX.id, TOKEN);
    expect(reply).toEqual({ kind: "silent", reason: "box_unreachable" });
  });

  it("a 200 from the box still answers", async () => {
    const fetcher = edgeFetcher(200, '{"id":"home","epoch":1}');
    const reply = await boxAdapter(STORE, { fetcher }).presence(BOX.id, TOKEN);
    expect(reply.kind).toBe("answered");
  });

  it("a thrown fetch is still silence with its reason", async () => {
    const failing = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
    const reply = await boxAdapter(STORE, { fetcher: failing }).presence(BOX.id, TOKEN);
    expect(reply).toEqual({ kind: "silent", reason: "box_unreachable" });
  });

  it("the status relay shares the probe's distrust of the edge", async () => {
    const fetcher = edgeFetcher(530, "error code: 1016");
    const reply = await boxAdapter(STORE, { fetcher }).status(BOX.id, TOKEN);
    expect(reply).toEqual({ kind: "silent", reason: "box_unreachable" });
  });
});
