import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCESS_ASSERTION_HEADER, clearAccessCache } from "../src/access";
import app, { type Env } from "../src/index";
import { generateRsaKey, signRsaJwt } from "./jwt-test-helpers";

// Must match vitest.config.ts miniflare bindings (edge reads the Worker env
// for the /console Access check, same threading as the DO guard in
// scopes.test.ts).
const ACCESS_TEAM = "test-team.cloudflareaccess.com";
const ACCESS_AUD = "test-access-aud-tag";
const ACCESS_EMAIL = "owner@example.com";

function jwksUrl(): string {
  return `https://${ACCESS_TEAM}/cdn-cgi/access/certs`;
}

// /console never touches the DO: env carries only the Access config.
function consoleEnv(): Env {
  return {
    ACCESS_TEAM_DOMAIN: ACCESS_TEAM,
    ACCESS_AUD: ACCESS_AUD,
    ACCESS_ALLOWED_EMAIL: ACCESS_EMAIL,
  } as unknown as Env;
}

async function craftJwt(): Promise<{ jwt: string; jwks: { keys: unknown[] } }> {
  const { privateKey, jwk } = await generateRsaKey("console-k1");
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = await signRsaJwt(
    privateKey,
    { alg: "RS256", kid: "console-k1", typ: "JWT" },
    { aud: ACCESS_AUD, exp: nowSec + 600, email: ACCESS_EMAIL },
  );
  return { jwt, jwks: { keys: [jwk] } };
}

// Stub only the Access certs URL; everything else falls through so a
// fallback fetch would fail loud, never silently allow.
async function withJwks<T>(jwks: object, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === jwksUrl()) {
      return Response.json(jwks);
    }
    return prev(input as string, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

function consoleRequest(path: string, jwt?: string, method = "GET"): Request {
  const headers: Record<string, string> = {};
  if (jwt !== undefined) {
    headers[ACCESS_ASSERTION_HEADER] = jwt;
  }
  return new Request(`https://fleet.local${path}`, { method, headers });
}

beforeEach(() => {
  clearAccessCache();
});

describe("console page access (Task 2 story: browser Access session, no CLI token)", () => {
  it("anonymous GET /console 401s through the full edge path (SELF)", async () => {
    const res = await SELF.fetch("https://fleet.local/console");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("anonymous GET /console/* subpaths 401 (no ungated prefix)", async () => {
    for (const path of ["/console/", "/console/audit"]) {
      const res = await SELF.fetch(`https://fleet.local${path}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
    }
  });

  it("anonymous direct fetch 401s (unit level, no DO roundtrip)", async () => {
    const res = await app.fetch(consoleRequest("/console"), consoleEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("forged assertion denies, never serves the page", async () => {
    const res = await app.fetch(consoleRequest("/console", "stale.jwt.here"), consoleEnv());
    expect(res.status).toBe(401);
  });

  it("production config without ACCESS_* vars denies even a valid JWT (fail-closed)", async () => {
    // wrangler.toml ships no ACCESS_* defaults: with an empty env (what a
    // deploy without overrides gets) accessConfig is incomplete and even a
    // correctly signed allowlisted JWT must 401, never serve the page.
    const { jwt, jwks } = await craftJwt();
    await withJwks(jwks, async () => {
      const res = await app.fetch(consoleRequest("/console", jwt), {} as unknown as Env);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
    });
  });
});

describe("console offline threshold (90s fleet heartbeat contract)", () => {
  async function serveHtml(): Promise<string> {
    const { jwt, jwks } = await craftJwt();
    return withJwks(jwks, async () => {
      const res = await app.fetch(consoleRequest("/console", jwt), consoleEnv());
      expect(res.status).toBe(200);
      return await res.text();
    });
  }

  it("pins OFFLINE_AFTER_SEC = 90, never the old 5-minute value", async () => {
    const html = await serveHtml();
    expect(html).toContain("OFFLINE_AFTER_SEC = 90");
    expect(html).not.toContain("OFFLINE_AFTER_SEC = 300");
    const m = html.match(/var OFFLINE_AFTER_SEC = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(90);
  });

  it("boxState compares staleness with strict > on the named constant", async () => {
    // Strictly-exceeds semantics on the 90s contract: 91s stale reads off,
    // 89s and exactly-90s read on. Pinned against the shipped source (the
    // classifier is inline page JS, so the test asserts its exact shape).
    const html = await serveHtml();
    const fn = html.match(/function boxState\(box\) \{([\s\S]*?)\n\}/);
    expect(fn).not.toBeNull();
    const body = fn![1];
    expect(body).toMatch(/-\s*box\.last_seen\s*>\s*OFFLINE_AFTER_SEC/);
  });

  it("boxState keeps the server-side tombstone ahead of staleness", async () => {
    // A tombstoned box that also went quiet stays tombstoned/pending: the
    // block is the binding fact, staleness is secondary.
    const html = await serveHtml();
    const fn = html.match(/function boxState\(box\) \{([\s\S]*?)\n\}/);
    expect(fn).not.toBeNull();
    const body = fn![1];
    expect(body.indexOf("tombstoned")).toBeLessThan(body.indexOf("OFFLINE_AFTER_SEC"));
  });
});

describe("console page content", () => {
  it("valid Access JWT serves 200 HTML with board markers", async () => {
    const { jwt, jwks } = await craftJwt();
    const html = await withJwks(jwks, async () => {
      const res = await app.fetch(consoleRequest("/console", jwt), consoleEnv());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      return await res.text();
    });
    // Board contract markers: board root, backend fetch, big LOGIN tap,
    // per-box revoke confirm, audit filter, last-synced offline marker,
    // tainted/revoke-pending state, server-side tombstone marker,
    // phone-first viewport.
    for (const marker of [
      "fleet console",
      'id="board"',
      "/api/backends",
      "LOGIN",
      "confirm",
      "/api/audit",
      "last-synced",
      "revoke pending",
      "tombstoned",
      "until the box returns",
      "viewport",
    ]) {
      expect(html.toLowerCase()).toContain(marker.toLowerCase());
    }
  });

  it("served HTML embeds no secret material or credential headers", async () => {
    const { jwt, jwks } = await craftJwt();
    const html = await withJwks(jwks, async () => {
      const res = await app.fetch(consoleRequest("/console", jwt), consoleEnv());
      expect(res.status).toBe(200);
      return await res.text();
    });
    const lower = html.toLowerCase();
    for (const secret of [
      "heartbeat_token",
      "admin_token",
      "token_hash",
      "bootstrap",
      "seal",
      "cf-access",
      "authorization",
      "bearer",
    ]) {
      expect(lower).not.toContain(secret);
    }
  });

  it("valid JWT on /console/ serves the same page; POST /console is 404, never 500", async () => {
    const { jwt, jwks } = await craftJwt();
    await withJwks(jwks, async () => {
      const slash = await app.fetch(consoleRequest("/console/", jwt), consoleEnv());
      expect(slash.status).toBe(200);
      expect(slash.headers.get("content-type")).toContain("text/html");
      const post = await app.fetch(consoleRequest("/console", jwt, "POST"), consoleEnv());
      expect(post.status).toBe(404);
    });
  });
});
