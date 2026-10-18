import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ACCESS_ASSERTION_HEADER, scopeForEdgeRoute } from "../src/access";
import { handleMintToken } from "../src/tokens";
import { generateRsaKey, signRsaJwt } from "./jwt-test-helpers";

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

  it("a malformed Access assertion denies (never a bypass)", async () => {
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

describe("guarded-route exhaustiveness (anonymous must 401 everywhere)", () => {
  // Explicit route table — there is no shared router table, so this MUST
  // mirror the guarded branches in worker/src/index.ts fetch() (edge
  // fast-path) and the scopeForDoRoute dispatch in worker/src/access.ts (DO
  // enforcement). ADD NEW GUARDED ROUTES HERE when the router gains them:
  // a mutating route missing from both mappers serves anonymous callers and
  // must fail these tests.
  const GUARDED: Array<{ method: string; path: string; body?: unknown }> = [
    { method: "GET", path: "/api/backends" },
    { method: "GET", path: "/api/audit" },
    { method: "POST", path: "/api/revoke-all", body: {} },
    { method: "POST", path: "/api/backends/rt-exhaust/link" },
    { method: "POST", path: "/api/backends/rt-exhaust/revoke", body: { confirm: true } },
  ];

  it("every listed route maps to an edge scope (mapper parity with the router)", () => {
    for (const route of GUARDED) {
      expect(scopeForEdgeRoute(route.method, route.path)).not.toBeNull();
    }
  });

  it("anonymous requests 401 with an unauthorized body on every guarded route", async () => {
    for (const route of GUARDED) {
      const res = await selfFetch(apiRequest(route.path, route.method, route.body));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
    }
  });

  it("garbage-bearer requests 401 on every guarded route (DO validity, not just edge presence)", async () => {
    // A bearer value passes the edge presence check, so only DO-side scope
    // validation can 401 these. If the DO mapper misses a route the edge
    // covers, the handler runs and the status differs (404/400/200).
    for (const route of GUARDED) {
      const res = await selfFetch(apiRequest(route.path, route.method, route.body, "garbage-token"));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
    }
  });
});

// Must match vitest.config.ts miniflare bindings (the DO under test is
// constructed with the test env): this is the env threading the valid-JWT
// test proves end-to-end.
const ACCESS_TEAM = "test-team.cloudflareaccess.com";
const ACCESS_AUD = "test-access-aud-tag";
const ACCESS_EMAIL = "owner@example.com";

function jwksUrl(): string {
  return `https://${ACCESS_TEAM}/cdn-cgi/access/certs`;
}

describe("valid Access JWT end-to-end (env threading)", () => {
  it("a valid JWT allows a guarded route via SELF and direct DO fetch", async () => {
    const { privateKey, jwk } = await generateRsaKey("route-e2e-k1");
    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = await signRsaJwt(
      privateKey,
      { alg: "RS256", kid: "route-e2e-k1", typ: "JWT" },
      { aud: ACCESS_AUD, exp: nowSec + 600, email: ACCESS_EMAIL },
    );
    const jwks = { keys: [jwk] };
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));

    // Stub the JWKS fetch inside the DO isolate (runInDurableObject executes
    // there): anything but the certs URL falls through to the real fetch.
    // Left active across the SELF call below so the full edge + DO path is
    // proven; restored in finally.
    await runInDurableObject(stub, async () => {
      const globals = globalThis as unknown as Record<string, unknown>;
      globals["__prevFetch"] = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (input.toString() === jwksUrl()) {
          return Response.json(jwks);
        }
        return (globals["__prevFetch"] as typeof fetch)(input, init);
      }) as typeof fetch;
    });
    try {
      // Direct DO route: proves constructor env → accessConfig → verify.
      const direct = await runInDurableObject(stub, async (instance) => {
        const res = await instance.fetch(
          new Request("http://do/link/scope-jwt-ghost", {
            method: "POST",
            headers: { [ACCESS_ASSERTION_HEADER]: jwt },
          }),
        );
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      });
      // Unknown box: auth passed, the link handler ran and 404d.
      expect(direct.status).toBe(404);
      expect(direct.body).toMatchObject({ error: "unknown_box" });

      // Full edge path: the edge presence check forwards JWT-bearing
      // requests and the DO allows them — 404 ghost, never 401.
      const viaEdge = await selfFetch(
        apiRequest("/api/backends/scope-jwt-ghost/link", "POST", undefined, undefined, jwt),
      );
      expect(viaEdge.status).toBe(404);
      expect(await viaEdge.json()).toMatchObject({ error: "unknown_box" });
    } finally {
      await runInDurableObject(stub, async () => {
        const globals = globalThis as unknown as Record<string, unknown>;
        globalThis.fetch = globals["__prevFetch"] as typeof fetch;
        delete globals["__prevFetch"];
      });
    }
  });
});
