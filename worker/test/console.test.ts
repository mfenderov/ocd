import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCESS_ASSERTION_HEADER, clearAccessCache } from "../src/access";
import app, { type Env } from "../src/index";
import { generateRsaKey, signRsaJwt } from "./jwt-test-helpers";

// Must match wrangler.toml [vars] (edge reads the Worker env for the
// /console Access check, same threading as the DO guard in scopes.test.ts).
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
    // tainted/revoke-pending state, phone-first viewport.
    for (const marker of [
      "fleet console",
      'id="board"',
      "/api/backends",
      "LOGIN",
      "confirm",
      "/api/audit",
      "last-synced",
      "revoke pending",
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
