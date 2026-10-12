import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ACCESS_ASSERTION_HEADER } from "../src/access";
import { handleMintToken } from "../src/tokens";

const BOOTSTRAP = "test-bootstrap-scopes-2";

let allToken = "";
let linkToken = "";
let revokeToken = "";
let auditToken = "";

async function mintDirect(scopes: string[] | undefined, bearer: string): Promise<string> {
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  return runInDurableObject(stub, async (instance) => {
    const res = await handleMintToken(
      new Request("https://fleet.local/tokens", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify(scopes === undefined ? {} : { scopes }),
      }),
      instance,
      { bootstrapSecret: BOOTSTRAP },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  });
}

beforeAll(async () => {
  allToken = await mintDirect(undefined, BOOTSTRAP);
  linkToken = await mintDirect(["link"], allToken);
  revokeToken = await mintDirect(["revoke"], allToken);
  auditToken = await mintDirect(["audit"], allToken);
});

function apiRequest(path: string, method: string, body?: unknown, bearer?: string, assertion?: string): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {};
  let bodyText: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    bodyText = JSON.stringify(body);
  }
  if (bearer !== undefined) {
    headers["authorization"] = `Bearer ${bearer}`;
  }
  if (assertion !== undefined) {
    headers[ACCESS_ASSERTION_HEADER] = assertion;
  }
  return { url: `https://fleet.local${path}`, init: { method, headers, body: bodyText } };
}

async function selfFetch(req: { url: string; init: RequestInit }): Promise<Response> {
  return SELF.fetch(req.url, req.init);
}

describe("scope guards through the worker + DO", () => {
  it("GET /api/backends needs audit scope: 401 without, 401 on link token, 200 on audit token", async () => {
    const anon = await selfFetch(apiRequest("/api/backends", "GET"));
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ error: "unauthorized" });
    const wrong = await selfFetch(apiRequest("/api/backends", "GET", undefined, linkToken));
    expect(wrong.status).toBe(401);
    const ok = await selfFetch(apiRequest("/api/backends", "GET", undefined, auditToken));
    expect(ok.status).toBe(200);
    expect(Array.isArray(await ok.json())).toBe(true);
  });

  it("GET /api/audit needs audit scope: 401 without, 401 on revoke token, 404 ghost on audit token", async () => {
    const anon = await selfFetch(apiRequest("/api/audit?box=scope-ghost", "GET"));
    expect(anon.status).toBe(401);
    const wrong = await selfFetch(apiRequest("/api/audit?box=scope-ghost", "GET", undefined, revokeToken));
    expect(wrong.status).toBe(401);
    const ghost = await selfFetch(apiRequest("/api/audit?box=scope-ghost", "GET", undefined, auditToken));
    expect(ghost.status).toBe(404);
  });

  it("POST /api/backends/:id/link needs link scope: 401 without, 401 on audit token, 404 ghost on link token", async () => {
    const anon = await selfFetch(apiRequest("/api/backends/scope-ghost/link", "POST"));
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ error: "unauthorized" });
    const wrong = await selfFetch(apiRequest("/api/backends/scope-ghost/link", "POST", undefined, auditToken));
    expect(wrong.status).toBe(401);
    const ghost = await selfFetch(apiRequest("/api/backends/scope-ghost/link", "POST", undefined, linkToken));
    expect(ghost.status).toBe(404);
  });

  it("POST /api/backends/:id/revoke needs revoke scope: 401 without, 401 on link token, 404 ghost on revoke token", async () => {
    const body = { confirm: true };
    const anon = await selfFetch(apiRequest("/api/backends/scope-ghost/revoke", "POST", body));
    expect(anon.status).toBe(401);
    const wrong = await selfFetch(apiRequest("/api/backends/scope-ghost/revoke", "POST", body, linkToken));
    expect(wrong.status).toBe(401);
    const ghost = await selfFetch(apiRequest("/api/backends/scope-ghost/revoke", "POST", body, revokeToken));
    expect(ghost.status).toBe(404);
  });

  it("POST /api/revoke-all needs revoke scope: 401 without, 401 on audit token, 400 no-confirm on revoke token", async () => {
    const anon = await selfFetch(apiRequest("/api/revoke-all", "POST", {}));
    expect(anon.status).toBe(401);
    const wrong = await selfFetch(apiRequest("/api/revoke-all", "POST", {}, auditToken));
    expect(wrong.status).toBe(401);
    const noConfirm = await selfFetch(apiRequest("/api/revoke-all", "POST", {}, revokeToken));
    expect(noConfirm.status).toBe(400);
  });

  it("an unconfigured Access allowlist denies the JWT path (fail-closed)", async () => {
    // Test env carries no ACCESS_* vars by design, so any assertion denies.
    const res = await selfFetch(apiRequest("/api/backends", "GET", undefined, undefined, "stale.jwt.here"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("unguarded box and token-lifecycle routes keep their own auth, not the scope guard", async () => {
    // Heartbeat with a garbage box token is still the heartbeat 401, not a scope 401.
    const hb = await selfFetch(
      apiRequest("/api/heartbeat", "POST", { id: "scope-hb-ghost", seq: 1, box_now: 100, epoch: 0 }, "garbage"),
    );
    expect(hb.status).toBe(401);
    // Token rotate with a garbage token is still the lifecycle 403, not a scope 401.
    const rotate = await selfFetch(apiRequest("/api/tokens/route-ghost/rotate", "POST", {}, "garbage"));
    expect(rotate.status).toBe(403);
  });
});
