import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/heartbeat";
import app from "../src/index";
import {
  handleDeleteToken,
  handleMintToken,
  handleRotateToken,
  requireScope,
  type TokenRow,
  type TokenStore,
} from "../src/tokens";

const BOOTSTRAP = "test-bootstrap-secret-1";

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

function tokenRequest(path: string, method: string, body?: unknown, bearer?: string): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (bearer !== undefined) {
    headers["authorization"] = `Bearer ${bearer}`;
  }
  return new Request(`https://fleet.local${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function bootstrapMint(store: MemStore, scopes?: unknown): Promise<{ token: string; id: string }> {
  const res = await handleMintToken(tokenRequest("/tokens", "POST", { scopes }, BOOTSTRAP), store, {
    bootstrapSecret: BOOTSTRAP,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; id: string; scopes: string[] };
  return { token: body.token, id: body.id };
}

describe("token mint (unit)", () => {
  it("mint returns the value once and stores only its hash", async () => {
    const store = new MemStore();
    const res = await handleMintToken(tokenRequest("/tokens", "POST", {}, BOOTSTRAP), store, {
      bootstrapSecret: BOOTSTRAP,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; id: string; scopes: string[] };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(16);
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.scopes).toContain("manage");
    const row = store.getToken(body.id);
    expect(row).toBeDefined();
    // Hash stored, value shown once: the row carries the SHA-256 hex, and
    // the plaintext value appears nowhere in persisted state.
    expect(row?.token_hash).toBe(await hashToken(body.token));
    expect(JSON.stringify(row)).not.toContain(body.token);
  });

  it("wrong or missing bootstrap secret is 403 and stores nothing", async () => {
    const store = new MemStore();
    for (const bearer of ["wrong-secret", undefined]) {
      const res = await handleMintToken(tokenRequest("/tokens", "POST", {}, bearer), store, {
        bootstrapSecret: BOOTSTRAP,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    }
    expect(store.countTokens()).toBe(0);
  });

  it("empty store without a configured bootstrap secret fails loud, never mints", async () => {
    const store = new MemStore();
    const res = await handleMintToken(tokenRequest("/tokens", "POST", {}, BOOTSTRAP), store, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "misconfigured" });
    expect(store.countTokens()).toBe(0);
  });

  it("unknown or empty scopes are 400 and store nothing", async () => {
    const store = new MemStore();
    for (const scopes of [{ scopes: ["root"] }, { scopes: [] }, { scopes: "manage" }, { scopes: [123] }]) {
      const res = await handleMintToken(tokenRequest("/tokens", "POST", scopes, BOOTSTRAP), store, {
        bootstrapSecret: BOOTSTRAP,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }
    expect(store.countTokens()).toBe(0);
  });

  it("after the first token, mint needs a manage token — the bootstrap secret stops working", async () => {
    const store = new MemStore();
    const first = await bootstrapMint(store);
    // Bootstrap is a first-token flow only: reusing it is 403, not a mint.
    const reused = await handleMintToken(tokenRequest("/tokens", "POST", {}, BOOTSTRAP), store, {
      bootstrapSecret: BOOTSTRAP,
    });
    expect(reused.status).toBe(403);
    expect(store.countTokens()).toBe(1);
    // A manage token mints the second token.
    const second = await handleMintToken(tokenRequest("/tokens", "POST", { scopes: ["audit"] }, first.token), store, {
      bootstrapSecret: BOOTSTRAP,
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { token: string; id: string; scopes: string[] };
    expect(body.scopes).toEqual(["audit"]);
    expect(body.id).not.toBe(first.id);
    expect(store.countTokens()).toBe(2);
  });

  it("a token without manage scope cannot mint", async () => {
    const store = new MemStore();
    const scoped = await bootstrapMint(store, ["audit"]);
    const res = await handleMintToken(tokenRequest("/tokens", "POST", {}, scoped.token), store, {
      bootstrapSecret: BOOTSTRAP,
    });
    expect(res.status).toBe(403);
    expect(store.countTokens()).toBe(1);
  });
});

describe("token rotate (unit)", () => {
  it("rotate returns a new value and invalidates the old one", async () => {
    const store = new MemStore();
    const first = await bootstrapMint(store);
    const res = await handleRotateToken(first.id, tokenRequest(`/tokens/${first.id}/rotate`, "POST", {}, first.token), store);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; id: string; scopes: string[] };
    expect(body.id).toBe(first.id);
    expect(body.token).not.toBe(first.token);
    // Old value is dead, new value verifies, hash restores to the new value.
    expect(await requireScope(store, first.token, "manage")).toBeNull();
    const row = await requireScope(store, body.token, "manage");
    expect(row?.id).toBe(first.id);
    expect(store.getToken(first.id)?.token_hash).toBe(await hashToken(body.token));
    expect(JSON.stringify(store.getToken(first.id))).not.toContain(body.token);
  });

  it("rotate keeps the token scopes", async () => {
    const store = new MemStore();
    const admin = await bootstrapMint(store);
    const minted = await handleMintToken(tokenRequest("/tokens", "POST", { scopes: ["link", "audit"] }, admin.token), store, {
      bootstrapSecret: BOOTSTRAP,
    });
    expect(minted.status).toBe(200);
    const scoped = (await minted.json()) as { token: string; id: string };
    const res = await handleRotateToken(scoped.id, tokenRequest(`/tokens/${scoped.id}/rotate`, "POST", {}, admin.token), store);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: scoped.id, scopes: ["link", "audit"] });
  });

  it("rotate without a manage token is 403; unknown id is 404", async () => {
    const store = new MemStore();
    const first = await bootstrapMint(store);
    const noAuth = await handleRotateToken(
      first.id,
      tokenRequest(`/tokens/${first.id}/rotate`, "POST", {}, "garbage"),
      store,
    );
    expect(noAuth.status).toBe(403);
    const scoped = await handleMintToken(tokenRequest("/tokens", "POST", { scopes: ["audit"] }, first.token), store, {
      bootstrapSecret: BOOTSTRAP,
    });
    expect(scoped.status).toBe(200);
    const scopedToken = ((await scoped.json()) as { token: string }).token;
    const scopedDenied = await handleRotateToken(
      first.id,
      tokenRequest(`/tokens/${first.id}/rotate`, "POST", {}, scopedToken),
      store,
    );
    expect(scopedDenied.status).toBe(403);
    const ghost = await handleRotateToken(
      "ghost-id",
      tokenRequest("/tokens/ghost-id/rotate", "POST", {}, first.token),
      store,
    );
    expect(ghost.status).toBe(404);
    // Failed rotates change nothing: the original value still verifies.
    expect(await requireScope(store, first.token, "manage")).not.toBeNull();
  });
});

describe("token delete (unit)", () => {
  it("delete kills the token: scope checks fail and the row is gone", async () => {
    const store = new MemStore();
    const first = await bootstrapMint(store);
    const minted = await handleMintToken(tokenRequest("/tokens", "POST", {}, first.token), store, {
      bootstrapSecret: BOOTSTRAP,
    });
    const adminToken = ((await minted.json()) as { token: string }).token;
    const res = await handleDeleteToken(first.id, tokenRequest(`/tokens/${first.id}`, "DELETE", undefined, adminToken), store);
    expect(res.status).toBe(200);
    expect(await requireScope(store, first.token, "manage")).toBeNull();
    expect(store.getToken(first.id)).toBeUndefined();
    // Repeat delete with the surviving manage token: auth passes, row is gone.
    const again = await handleDeleteToken(first.id, tokenRequest(`/tokens/${first.id}`, "DELETE", undefined, adminToken), store);
    expect(again.status).toBe(404);
  });

  it("delete without a manage token is 403 and keeps the row", async () => {
    const store = new MemStore();
    const first = await bootstrapMint(store);
    const res = await handleDeleteToken(first.id, tokenRequest(`/tokens/${first.id}`, "DELETE"), store);
    expect(res.status).toBe(403);
    expect(store.getToken(first.id)).toBeDefined();
  });
});

describe("requireScope (unit)", () => {
  it("rejects insufficient scope but accepts held scope", async () => {
    const store = new MemStore();
    const scoped = await bootstrapMint(store, ["audit"]);
    expect(await requireScope(store, scoped.token, "audit")).toMatchObject({ id: scoped.id });
    expect(await requireScope(store, scoped.token, "revoke")).toBeNull();
    expect(await requireScope(store, scoped.token, "link")).toBeNull();
    expect(await requireScope(store, scoped.token, "manage")).toBeNull();
  });

  it("rejects unknown and empty values without throwing", async () => {
    const store = new MemStore();
    await bootstrapMint(store);
    expect(await requireScope(store, "garbage-value", "audit")).toBeNull();
    expect(await requireScope(store, "", "audit")).toBeNull();
  });
});

describe("token store through the real DO (SQLite backend)", () => {
  it("mint + requireScope round-trip through FleetState SQL", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-tokens-sql"));
    const minted = await runInDurableObject(stub, async (instance) => {
      const res = await handleMintToken(tokenRequest("/tokens", "POST", { scopes: ["link"] }, BOOTSTRAP), instance, {
        bootstrapSecret: BOOTSTRAP,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { token: string; id: string; scopes: string[] };
    });
    const checked = await runInDurableObject(stub, async (instance) => {
      const ok = await requireScope(instance, minted.token, "link");
      const denied = await requireScope(instance, minted.token, "revoke");
      return { ok: ok?.id ?? null, denied: denied?.id ?? null, count: instance.countTokens() };
    });
    expect(checked).toEqual({ ok: minted.id, denied: null, count: 1 });
  });
});

describe("token routes through the worker + DO", () => {
  it("POST /api/tokens without a configured bootstrap secret is 500, never a mint", async () => {
    const res = await SELF.fetch("https://fleet.local/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anything" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "misconfigured" });
  });

  it("rotate and delete with a garbage token are 403", async () => {
    const rotate = await SELF.fetch("https://fleet.local/api/tokens/route-ghost/rotate", {
      method: "POST",
      headers: { authorization: "Bearer garbage" },
      body: JSON.stringify({}),
    });
    expect(rotate.status).toBe(403);
    const deleted = await SELF.fetch("https://fleet.local/api/tokens/route-ghost", {
      method: "DELETE",
      headers: { authorization: "Bearer garbage" },
    });
    expect(deleted.status).toBe(403);
  });

  it("there is no read-back endpoint: the mint value cannot be listed", async () => {
    const res = await SELF.fetch("https://fleet.local/api/tokens");
    expect(res.status).toBe(404);
  });

  it("fails loud when the FLEET_STATE binding is missing", async () => {
    const mint = await app.fetch(new Request("http://x/api/tokens", { method: "POST" }));
    expect(mint.status).toBe(500);
    expect(await mint.text()).toContain("FLEET_STATE");
    const rotate = await app.fetch(new Request("http://x/api/tokens/a/rotate", { method: "POST" }));
    expect(rotate.status).toBe(500);
    expect(await rotate.text()).toContain("FLEET_STATE");
    const deleted = await app.fetch(new Request("http://x/api/tokens/a", { method: "DELETE" }));
    expect(deleted.status).toBe(500);
    expect(await deleted.text()).toContain("FLEET_STATE");
  });
});
