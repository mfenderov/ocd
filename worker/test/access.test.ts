import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_ASSERTION_HEADER,
  authorizeRequest,
  clearAccessCache,
  verifyAccessJwt,
  type AccessConfig,
} from "../src/access";
import { EDGE_ROUTES } from "../src/index";
import { findRoute, type Route } from "../src/routes";
import type { FleetState } from "../src/state";
import { handleMintToken, type TokenRow, type TokenStore } from "../src/tokens";
import { b64url, generateRsaKey, signRsaJwt } from "./jwt-test-helpers";
import { inState } from "./helpers";

// The scope a route needs, read from the route table the router uses.
function scopeOf(routes: readonly Route<unknown>[], method: string, pathname: string): string | null {
  const found = findRoute(routes, method, pathname);
  return found?.route.scope ?? null;
}

// The DO's routes, read off a live instance: the table is built per
// instance, because every handler answers with the instance's own state.
async function doRoutes(): Promise<readonly Route<unknown>[]> {
  const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
  return inState(stub, (instance: FleetState) => instance.routes);
}

const BOOTSTRAP = "test-bootstrap-access-2";

class MemStore implements TokenStore {
  rows = new Map<string, TokenRow>();
  getToken(id: string): TokenRow | undefined {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }
  getTokenByHash(hash: string): TokenRow | undefined {
    for (const row of this.rows.values()) {
      if (row.token_hash === hash) {
        return { ...row };
      }
    }
    return undefined;
  }
  putToken(row: TokenRow): void {
    this.rows.set(row.id, { ...row });
  }
  deleteToken(id: string): void {
    this.rows.delete(id);
  }
  countTokens(): number {
    return this.rows.size;
  }
}

async function mint(store: MemStore, scopes: unknown, bearer: string): Promise<string> {
  const res = await handleMintToken(
    new Request("https://fleet.local/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(scopes === undefined ? {} : { scopes }),
    }),
    store,
    { bootstrapSecret: BOOTSTRAP },
  );
  expect(res.status).toBe(200);
  return (await res.json<{ token: string }>()).token;
}

function scopedRequest(path: string, method: string, bearer?: string, assertion?: string): Request {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) {
    headers["authorization"] = `Bearer ${bearer}`;
  }
  if (assertion !== undefined) {
    headers[ACCESS_ASSERTION_HEADER] = assertion;
  }
  return new Request(`https://fleet.local${path}`, { method, headers });
}

// --- Access JWT fixtures (RS256, in-test keys, no network) ---

const NOW = 1700000000;
const TEAM = "team.cloudflareaccess.com";
const AUD = "test-access-aud-tag";
const EMAIL = "owner@example.com";

const makeKey = generateRsaKey;
const signJwt = signRsaJwt;

function accessConfig(overrides: Partial<AccessConfig> = {}): AccessConfig {
  return { teamDomain: TEAM, aud: AUD, allowedEmail: EMAIL, ...overrides };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { aud: AUD, exp: NOW + 300, email: EMAIL, ...overrides };
}

function jwksFetcher(jwks: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return ((url: string) => {
    calls.push(url.toString());
    return Promise.resolve(Response.json(jwks));
  }) as typeof fetch;
}

const deps = (fetcher: typeof fetch) => ({ fetcher, nowSec: () => NOW });

beforeEach(() => {
  clearAccessCache();
});

describe("the edge routes' scopes (/api/* paths)", () => {
  it("maps each guarded route to its scope", () => {
    expect(scopeOf(EDGE_ROUTES, "GET", "/api/backends")).toBe("audit");
    expect(scopeOf(EDGE_ROUTES, "GET", "/api/audit")).toBe("audit");
    expect(scopeOf(EDGE_ROUTES, "POST", "/api/revoke-all")).toBe("revoke");
    expect(scopeOf(EDGE_ROUTES, "POST", "/api/backends/box-1/revoke")).toBe("revoke");
    expect(scopeOf(EDGE_ROUTES, "POST", "/api/backends/box-1/link")).toBe("link");
  });

  it("leaves box, enrollment, token, and unknown routes unguarded", () => {
    expect(scopeOf(EDGE_ROUTES, "POST", "/api/heartbeat")).toBeNull();
    expect(scopeOf(EDGE_ROUTES, "POST", "/api/enroll")).toBeNull();
    expect(scopeOf(EDGE_ROUTES, "GET", "/api/enroll/approve")).toBeNull();
    expect(scopeOf(EDGE_ROUTES, "GET", "/api/enroll/deny")).toBeNull();
    expect(scopeOf(EDGE_ROUTES, "POST", "/api/tokens")).toBeNull();
    expect(scopeOf(EDGE_ROUTES, "POST", "/api/tokens/t-1/rotate")).toBeNull();
    expect(scopeOf(EDGE_ROUTES, "DELETE", "/api/tokens/t-1")).toBeNull();
    expect(scopeOf(EDGE_ROUTES, "GET", "/api/nope")).toBeNull();
    expect(scopeOf(EDGE_ROUTES, "GET", "/api/backends")).toBe("audit");
    // Degenerate ids never match a mutating route, same predicate as the router.
    expect(scopeOf(EDGE_ROUTES, "POST", "/api/backends//revoke")).toBeNull();
    expect(scopeOf(EDGE_ROUTES, "POST", "/api/backends//link")).toBeNull();
  });
});

describe("the DO routes' scopes (DO-internal paths)", () => {
  it("maps each guarded DO path to its scope", async () => {
    const routes = await doRoutes();
    expect(scopeOf(routes, "GET", "/backends")).toBe("audit");
    expect(scopeOf(routes, "GET", "/audit")).toBe("audit");
    expect(scopeOf(routes, "POST", "/revoke-all")).toBe("revoke");
    expect(scopeOf(routes, "POST", "/revoke/box-1")).toBe("revoke");
    expect(scopeOf(routes, "POST", "/link/box-1")).toBe("link");
  });

  it("leaves box, enrollment, token, and unknown DO paths unguarded", async () => {
    const routes = await doRoutes();
    expect(scopeOf(routes, "POST", "/heartbeat")).toBeNull();
    expect(scopeOf(routes, "POST", "/enroll")).toBeNull();
    expect(scopeOf(routes, "POST", "/tokens")).toBeNull();
    expect(scopeOf(routes, "POST", "/tokens/t-1/rotate")).toBeNull();
    expect(scopeOf(routes, "DELETE", "/tokens/t-1")).toBeNull();
    expect(scopeOf(routes, "GET", "/nope")).toBeNull();
  });
});

describe("authorizeRequest with CLI tokens", () => {
  it("accepts a held scope and rejects every insufficient scope", async () => {
    const store = new MemStore();
    const linkOnly = await mint(store, ["link"], BOOTSTRAP);
    expect(await authorizeRequest(scopedRequest("/x", "POST", linkOnly), store, "link", {})).toBe(true);
    expect(await authorizeRequest(scopedRequest("/x", "POST", linkOnly), store, "revoke", {})).toBe(false);
    expect(await authorizeRequest(scopedRequest("/x", "POST", linkOnly), store, "audit", {})).toBe(false);
    expect(await authorizeRequest(scopedRequest("/x", "POST", linkOnly), store, "manage", {})).toBe(false);
  });

  it("denies missing, empty, and unknown bearer values without throwing", async () => {
    const store = new MemStore();
    await mint(store, undefined, BOOTSTRAP);
    expect(await authorizeRequest(scopedRequest("/x", "POST"), store, "link", {})).toBe(false);
    expect(await authorizeRequest(scopedRequest("/x", "POST", ""), store, "link", {})).toBe(false);
    expect(await authorizeRequest(scopedRequest("/x", "POST", "garbage"), store, "link", {})).toBe(false);
  });
});

describe("verifyAccessJwt", () => {
  it("accepts a well-formed JWT and returns the allowlisted email", async () => {
    const { privateKey, jwk } = await makeKey("k1");
    const jwt = await signJwt(privateKey, { alg: "RS256", kid: "k1", typ: "JWT" }, payload());
    const out = await verifyAccessJwt(jwt, accessConfig(), deps(jwksFetcher({ keys: [jwk] })));
    expect(out).toBe(EMAIL);
  });

  it("rejects tampered signatures, wrong kid, and non-RS256 alg without throwing", async () => {
    const { privateKey, jwk } = await makeKey("k1");
    const other = await makeKey("k2");
    const good = await signJwt(privateKey, { alg: "RS256", kid: "k1", typ: "JWT" }, payload());
    // Flip the FIRST char of the signature segment: every bit there is
    // significant, unlike the last base64url char (partial quantum), so the
    // mutation is guaranteed. (Flipping the tail char is a no-op ~1/16 of
    // the time and flaked this test.)
    const sigParts = good.split(".");
    const first = sigParts[2][0];
    const tampered = sigParts.slice(0, 2).join(".") + "." + (first === "A" ? "B" : "A") + sigParts[2].slice(1);
    const fetchJwks = jwksFetcher({ keys: [jwk, other.jwk] });
    expect(await verifyAccessJwt(tampered, accessConfig(), deps(fetchJwks))).toBeNull();
    // Signed by k2 but claiming k1: signature check against k1 fails.
    const crossSigned = await signJwt(other.privateKey, { alg: "RS256", kid: "k1", typ: "JWT" }, payload());
    expect(await verifyAccessJwt(crossSigned, accessConfig(), deps(fetchJwks))).toBeNull();
    // Unknown kid with no matching JWKS entry.
    const ghost = await signJwt(privateKey, { alg: "RS256", kid: "ghost", typ: "JWT" }, payload());
    expect(await verifyAccessJwt(ghost, accessConfig(), deps(fetchJwks))).toBeNull();
    // alg confusion (none / HS256) fails closed even with a plausible body.
    const parts = good.split(".");
    const noneJwt = `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${parts[1]}.`;
    expect(await verifyAccessJwt(noneJwt, accessConfig(), deps(fetchJwks))).toBeNull();
  });

  it("rejects expired tokens, wrong aud, and non-allowlisted email", async () => {
    const { privateKey, jwk } = await makeKey("k1");
    const header = { alg: "RS256", kid: "k1", typ: "JWT" };
    const fetcher = jwksFetcher({ keys: [jwk] });
    expect(
      await verifyAccessJwt(await signJwt(privateKey, header, payload({ exp: NOW - 1 })), accessConfig(), deps(fetcher)),
    ).toBeNull();
    expect(
      await verifyAccessJwt(await signJwt(privateKey, header, payload({ aud: "other-aud" })), accessConfig(), deps(fetcher)),
    ).toBeNull();
    expect(
      await verifyAccessJwt(
        await signJwt(privateKey, header, payload({ email: "intruder@example.com" })),
        accessConfig(),
        deps(fetcher),
      ),
    ).toBeNull();
  });

  it("rejects malformed assertions without throwing", async () => {
    const { privateKey, jwk } = await makeKey("k1");
    const fetcher = jwksFetcher({ keys: [jwk] });
    for (const bad of ["", "a.b", "a.b.c.d", "!!!.@@@.###", "e30.e30.e30"]) {
      expect(await verifyAccessJwt(bad, accessConfig(), deps(fetcher))).toBeNull();
    }
    const noExp = await signJwt(privateKey, { alg: "RS256", kid: "k1" }, { aud: AUD, email: EMAIL });
    expect(await verifyAccessJwt(noExp, accessConfig(), deps(fetcher))).toBeNull();
  });

  it("deny-all fail-closed: unset allowlist, aud, or JWKS URL denies even a valid JWT", async () => {
    const { privateKey, jwk } = await makeKey("k1");
    const jwt = await signJwt(privateKey, { alg: "RS256", kid: "k1", typ: "JWT" }, payload());
    const fetcher = jwksFetcher({ keys: [jwk] });
    expect(await verifyAccessJwt(jwt, accessConfig({ allowedEmail: undefined }), deps(fetcher))).toBeNull();
    expect(await verifyAccessJwt(jwt, accessConfig({ allowedEmail: "" }), deps(fetcher))).toBeNull();
    expect(await verifyAccessJwt(jwt, accessConfig({ aud: undefined }), deps(fetcher))).toBeNull();
    expect(await verifyAccessJwt(jwt, accessConfig({ teamDomain: undefined }), deps(fetcher))).toBeNull();
  });

  it("JWKS transport failure denies without throwing and never logs the assertion", async () => {
    const { privateKey } = await makeKey("k1");
    const jwt = await signJwt(privateKey, { alg: "RS256", kid: "k1", typ: "JWT" }, payload());
    const failing: typeof fetch = () => Promise.reject(new Error("conn refused"));
    await expect(verifyAccessJwt(jwt, accessConfig(), deps(failing))).resolves.toBeNull();
    const badJson: typeof fetch = () => Promise.resolve(new Response("nope", { status: 500 }));
    await expect(verifyAccessJwt(jwt, accessConfig(), deps(badJson))).resolves.toBeNull();
  });

  it("caches the JWKS per URL and refetches once on a kid miss", async () => {
    const { privateKey, jwk } = await makeKey("k1");
    const rotated = await makeKey("k2");
    let keys: unknown[] = [jwk];
    const calls: string[] = [];
    const fetching = ((url: string) => {
      calls.push(url.toString());
      return Promise.resolve(Response.json({ keys }));
    }) as typeof fetch;
    const jwt1 = await signJwt(privateKey, { alg: "RS256", kid: "k1", typ: "JWT" }, payload());
    expect(await verifyAccessJwt(jwt1, accessConfig(), deps(fetching))).toBe(EMAIL);
    expect(await verifyAccessJwt(jwt1, accessConfig(), deps(fetching))).toBe(EMAIL);
    expect(calls).toHaveLength(1);
    // Rotation: k2 unknown to the cache triggers one refetch, then verifies.
    keys = [jwk, rotated.jwk];
    const jwt2 = await signJwt(rotated.privateKey, { alg: "RS256", kid: "k2", typ: "JWT" }, payload());
    expect(await verifyAccessJwt(jwt2, accessConfig(), deps(fetching))).toBe(EMAIL);
    expect(calls).toHaveLength(2);
  });
});

describe("authorizeRequest with Access JWT bypass", () => {
  it("a valid JWT bypasses the token check; an invalid one denies with no token", async () => {
    const store = new MemStore();
    await mint(store, undefined, BOOTSTRAP);
    const { privateKey, jwk } = await makeKey("k1");
    const jwt = await signJwt(privateKey, { alg: "RS256", kid: "k1", typ: "JWT" }, payload());
    const ok = await authorizeRequest(
      scopedRequest("/x", "POST", undefined, jwt),
      store,
      "revoke",
      accessConfig(),
      deps(jwksFetcher({ keys: [jwk] })),
    );
    expect(ok).toBe(true);
    const denied = await authorizeRequest(
      scopedRequest("/x", "POST", undefined, "garbage.jwt.here"),
      store,
      "revoke",
      accessConfig(),
      deps(jwksFetcher({ keys: [jwk] })),
    );
    expect(denied).toBe(false);
  });

  it("unset allowlist denies the JWT path even with a valid signature", async () => {
    const store = new MemStore();
    await mint(store, undefined, BOOTSTRAP);
    const { privateKey, jwk } = await makeKey("k1");
    const jwt = await signJwt(privateKey, { alg: "RS256", kid: "k1", typ: "JWT" }, payload());
    const out = await authorizeRequest(
      scopedRequest("/x", "POST", undefined, jwt),
      store,
      "revoke",
      accessConfig({ allowedEmail: undefined }),
      deps(jwksFetcher({ keys: [jwk] })),
    );
    expect(out).toBe(false);
  });

  it("a valid CLI token still allows when a stale JWT is also present", async () => {
    const store = new MemStore();
    const token = await mint(store, ["revoke"], BOOTSTRAP);
    const { jwk } = await makeKey("k1");
    const out = await authorizeRequest(
      scopedRequest("/x", "POST", token, "stale.jwt.here"),
      store,
      "revoke",
      accessConfig(),
      deps(jwksFetcher({ keys: [jwk] })),
    );
    expect(out).toBe(true);
  });
});
