import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_ASSERTION_HEADER,
  authorizeRequest,
  clearAccessCache,
  scopeForDoRoute,
  scopeForEdgeRoute,
  verifyAccessJwt,
  type AccessConfig,
} from "../src/access";
import { handleMintToken, type TokenRow, type TokenStore } from "../src/tokens";

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
  return ((await res.json()) as { token: string }).token;
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

// --- Access JWT crafting (RS256, in-test keys, no network) ---

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const NOW = 1700000000;
const TEAM = "team.cloudflareaccess.com";
const AUD = "test-access-aud-tag";
const EMAIL = "owner@example.com";

function accessConfig(overrides: Partial<AccessConfig> = {}): AccessConfig {
  return { teamDomain: TEAM, aud: AUD, allowedEmail: EMAIL, ...overrides };
}

interface KeyPair {
  privateKey: CryptoKey;
  jwk: JsonWebKey;
}

async function makeKey(kid: string): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid?: string };
  jwk.kid = kid;
  jwk.alg = "RS256";
  return { privateKey: pair.privateKey, jwk };
}

async function signJwt(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, new TextEncoder().encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { aud: AUD, exp: NOW + 300, email: EMAIL, ...overrides };
}

function jwksFetcher(jwks: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(url.toString());
    return Response.json(jwks);
  }) as typeof fetch;
}

const deps = (fetcher: typeof fetch) => ({ fetcher, nowSec: () => NOW });

beforeEach(() => {
  clearAccessCache();
});

describe("scopeForEdgeRoute (/api/* paths)", () => {
  it("maps each guarded route to its scope", () => {
    expect(scopeForEdgeRoute("GET", "/api/backends")).toBe("audit");
    expect(scopeForEdgeRoute("GET", "/api/audit")).toBe("audit");
    expect(scopeForEdgeRoute("POST", "/api/revoke-all")).toBe("revoke");
    expect(scopeForEdgeRoute("POST", "/api/backends/box-1/revoke")).toBe("revoke");
    expect(scopeForEdgeRoute("POST", "/api/backends/box-1/link")).toBe("link");
  });

  it("leaves box, enrollment, token, and unknown routes unguarded", () => {
    expect(scopeForEdgeRoute("POST", "/api/heartbeat")).toBeNull();
    expect(scopeForEdgeRoute("POST", "/api/enroll")).toBeNull();
    expect(scopeForEdgeRoute("GET", "/api/enroll/approve")).toBeNull();
    expect(scopeForEdgeRoute("GET", "/api/enroll/deny")).toBeNull();
    expect(scopeForEdgeRoute("POST", "/api/tokens")).toBeNull();
    expect(scopeForEdgeRoute("POST", "/api/tokens/t-1/rotate")).toBeNull();
    expect(scopeForEdgeRoute("DELETE", "/api/tokens/t-1")).toBeNull();
    expect(scopeForEdgeRoute("GET", "/api/nope")).toBeNull();
    expect(scopeForEdgeRoute("GET", "/api/backends")).toBe("audit");
    // Degenerate ids never match a mutating route, same predicate as the router.
    expect(scopeForEdgeRoute("POST", "/api/backends//revoke")).toBeNull();
    expect(scopeForEdgeRoute("POST", "/api/backends//link")).toBeNull();
  });
});

describe("scopeForDoRoute (DO-internal paths)", () => {
  it("maps each guarded DO path to its scope", () => {
    expect(scopeForDoRoute("GET", "/backends")).toBe("audit");
    expect(scopeForDoRoute("GET", "/audit")).toBe("audit");
    expect(scopeForDoRoute("POST", "/revoke-all")).toBe("revoke");
    expect(scopeForDoRoute("POST", "/revoke/box-1")).toBe("revoke");
    expect(scopeForDoRoute("POST", "/link/box-1")).toBe("link");
  });

  it("leaves box, enrollment, token, and unknown DO paths unguarded", () => {
    expect(scopeForDoRoute("POST", "/heartbeat")).toBeNull();
    expect(scopeForDoRoute("POST", "/enroll")).toBeNull();
    expect(scopeForDoRoute("POST", "/tokens")).toBeNull();
    expect(scopeForDoRoute("POST", "/tokens/t-1/rotate")).toBeNull();
    expect(scopeForDoRoute("DELETE", "/tokens/t-1")).toBeNull();
    expect(scopeForDoRoute("GET", "/nope")).toBeNull();
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
    const tampered = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
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
    const failing = (async () => {
      throw new Error("conn refused");
    }) as typeof fetch;
    await expect(verifyAccessJwt(jwt, accessConfig(), deps(failing))).resolves.toBeNull();
    const badJson = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(verifyAccessJwt(jwt, accessConfig(), deps(badJson))).resolves.toBeNull();
  });

  it("caches the JWKS per URL and refetches once on a kid miss", async () => {
    const { privateKey, jwk } = await makeKey("k1");
    const rotated = await makeKey("k2");
    let keys: unknown[] = [jwk];
    const calls: string[] = [];
    const fetching = (async (url: string) => {
      calls.push(url.toString());
      return Response.json({ keys });
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
