import { extractBearer, hashToken, tokenMatches } from "./heartbeat";

// CLI token lifecycle: console POST /api/tokens mints a scoped token,
// POST /api/tokens/:id/rotate swaps its value, DELETE /api/tokens/:id
// revokes it. Values are shown exactly once — in the mint/rotate response
// — and stored as SHA-256 hashes only; there is no read-back endpoint.
// First-token flow: when the store is empty, the Worker env bootstrap
// secret (FLEET_BOOTSTRAP_SECRET) authorizes the mint. Once a token
// exists the bootstrap secret stops working and mints need a manage-scope
// token instead, so the bootstrap secret is never a permanent backdoor.
// Plaintext values are never logged anywhere on this path.

export type CliScope = "link" | "revoke" | "audit" | "manage" | "enroll";

export const ALL_SCOPES: CliScope[] = ["link", "revoke", "audit", "manage", "enroll"];

const MANAGE_SCOPE: CliScope = "manage";

// Persisted row. scopes travels as a JSON array string in SQLite (see
// parseTokenScopes); the plaintext value is never a column.
export interface TokenRow {
  id: string;
  token_hash: string;
  scopes: string;
  created_at: number;
}

export interface TokenStore {
  getToken(id: string): TokenRow | undefined;
  getTokenByHash(hash: string): TokenRow | undefined;
  putToken(row: TokenRow): void;
  deleteToken(id: string): void;
  countTokens(): number;
}

export interface TokenConfig {
  bootstrapSecret?: string;
}

function defaultNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function parseTokenScopes(raw: string): CliScope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: CliScope[] = [];
  for (const entry of parsed) {
    if (isScope(entry) && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

function isScope(value: unknown): value is CliScope {
  // Derived from ALL_SCOPES so a new scope cannot be typed in but
  // rejected at runtime.
  return typeof value === "string" && (ALL_SCOPES as string[]).includes(value);
}

function parseRequestedScopes(value: unknown): CliScope[] | null {
  if (value === undefined) {
    return [...ALL_SCOPES];
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const out: CliScope[] = [];
  for (const entry of value) {
    if (!isScope(entry)) {
      return null;
    }
    if (!out.includes(entry)) {
      out.push(entry);
    }
  }
  return out.length > 0 ? out : null;
}

// Token values carry a prefix so a leaked string is recognizable as a
// fleet CLI token (and unmistakable for a box heartbeat/admin token).
const TOKEN_PREFIX = "ocd-fleet-";

function mintValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return TOKEN_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Choke point for every token check (Task 2 route guards build on this):
// hash the presented value, fetch by hash, timing-safe re-verify, then
// the scope test. Unknown values, empty values, and insufficient scopes
// all resolve to null — never throw.
export async function requireScope(
  store: TokenStore,
  tokenValue: string,
  scope: CliScope,
): Promise<TokenRow | null> {
  if (!tokenValue) {
    return null;
  }
  const row = store.getTokenByHash(await hashToken(tokenValue));
  if (!row || !(await tokenMatches(tokenValue, row.token_hash))) {
    return null;
  }
  if (!parseTokenScopes(row.scopes).includes(scope)) {
    return null;
  }
  return row;
}

async function readScopes(request: Request): Promise<CliScope[] | null | undefined> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  return parseRequestedScopes((raw as Record<string, unknown>)["scopes"]);
}

// Mint authorization: empty store takes the bootstrap secret (fail loud
// when it is not configured, 403 on wrong/missing bearer); a non-empty
// store takes only a manage-scope token — the bootstrap bearer is refused
// there even when correct.
async function authorizedMinter(
  request: Request,
  store: TokenStore,
  config: TokenConfig,
): Promise<boolean> {
  const presented = extractBearer(request);
  if (store.countTokens() === 0) {
    if (!config.bootstrapSecret) {
      return false;
    }
    if (!presented) {
      return false;
    }
    return tokenMatches(presented, await hashToken(config.bootstrapSecret));
  }
  if (!presented) {
    return false;
  }
  return (await requireScope(store, presented, MANAGE_SCOPE)) !== null;
}

export async function handleMintToken(
  request: Request,
  store: TokenStore,
  config: TokenConfig = {},
  nowSec: () => number = defaultNowSec,
): Promise<Response> {
  const scopes = await readScopes(request);
  if (scopes === null) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (store.countTokens() === 0 && !config.bootstrapSecret) {
    console.error("tokens: bootstrap secret not configured");
    return Response.json({ error: "misconfigured" }, { status: 500 });
  }
  if (!(await authorizedMinter(request, store, config))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const value = mintValue();
  const id = crypto.randomUUID();
  store.putToken({
    id,
    token_hash: await hashToken(value),
    scopes: JSON.stringify(scopes ?? ALL_SCOPES),
    created_at: nowSec(),
  });
  return Response.json({ token: value, id, scopes: scopes ?? ALL_SCOPES });
}

async function authorizedManager(request: Request, store: TokenStore): Promise<boolean> {
  const presented = extractBearer(request);
  if (!presented) {
    return false;
  }
  return (await requireScope(store, presented, MANAGE_SCOPE)) !== null;
}

export async function handleRotateToken(
  id: string,
  request: Request,
  store: TokenStore,
  nowSec: () => number = defaultNowSec,
): Promise<Response> {
  if (!(await authorizedManager(request, store))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const row = store.getToken(id);
  if (!row) {
    return Response.json({ error: "unknown_token" }, { status: 404 });
  }
  const value = mintValue();
  store.putToken({ ...row, token_hash: await hashToken(value), created_at: nowSec() });
  return Response.json({ token: value, id: row.id, scopes: parseTokenScopes(row.scopes) });
}

export async function handleDeleteToken(
  id: string,
  request: Request,
  store: TokenStore,
): Promise<Response> {
  if (!(await authorizedManager(request, store))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (!store.getToken(id)) {
    return Response.json({ error: "unknown_token" }, { status: 404 });
  }
  store.deleteToken(id);
  return Response.json({ id, status: "deleted" });
}
