import { extractBearer } from "./heartbeat";
import { requireScope, type CliScope, type TokenStore } from "./tokens";

// Task 2 guards: CLI-token scopes for API routes plus a Cloudflare Access
// JWT bypass for browser paths. Both layers consult this module: the Worker
// edge (index.ts) short-circuits credential-less requests to guarded routes,
// and the DO (state.ts) enforces validity via authorizeRequest. Denials are
// uniform 401s — a valid-token-wrong-scope is indistinguishable from an
// unknown token, so there is no scope oracle.

// Browser assertion header set by Cloudflare Access in front of the Worker.
export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

export interface AccessConfig {
  // Team domain, e.g. "team.cloudflareaccess.com". The JWKS is derived as
  // https://<team>/cdn-cgi/access/certs (standard Access pattern).
  teamDomain?: string;
  // Access application AUD tag the JWT must carry.
  aud?: string;
  // Single allowlisted email. Unset/empty = deny-all fail-closed.
  allowedEmail?: string;
}

export interface AccessDeps {
  fetcher?: typeof fetch;
  nowSec?: () => number;
}

// JWKS cache: one entry per team URL, 10-minute TTL, refetched once on a
// kid miss so key rotation heals without waiting out the TTL.
const ACCESS_JWKS_TTL_SEC = 600;

interface JwksEntry {
  fetchedAtSec: number;
  keys: JwksKey[];
}

// workers-types JsonWebKey predates kid; Access JWKS entries always carry one.
interface JwksKey extends JsonWebKey {
  kid?: string;
}

const jwksCache = new Map<string, JwksEntry>();

export function clearAccessCache(): void {
  jwksCache.clear();
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

// Choke point for guarded routes: a bearer token with the route scope
// allows, else a valid Access JWT allows (browser bypass). Anything else —
// no credential, unknown token, insufficient scope, bad JWT — denies with
// false. OR semantics: a valid CLI token still allows when a stale JWT rides
// along (CLI automation must not break on proxy-injected headers), and a
// forged JWT alone grants nothing. Returns a plain boolean (never a wrapper
// object) so call-site negation cannot mistake it for truthy. Never throws;
// never logs the assertion.
export async function authorizeRequest(
  request: Request,
  store: TokenStore,
  scope: CliScope,
  config: AccessConfig = {},
  deps: AccessDeps = {},
): Promise<boolean> {
  try {
    const bearer = extractBearer(request);
    if (bearer && (await requireScope(store, bearer, scope))) {
      return true;
    }
    const assertion = request.headers.get(ACCESS_ASSERTION_HEADER);
    if (assertion && (await verifyAccessJwt(assertion, config, deps))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Validates Cf-Access-Jwt-Assertion: RS256 signature against the team's
// JWKS (fetched + cached), then aud + expiry + allowlisted email. Returns
// the email on success, null on any failure — including incomplete config
// (unset allowlist/aud/team = deny-all fail-closed). Never throws.
export async function verifyAccessJwt(
  assertion: string,
  config: AccessConfig,
  deps: AccessDeps = {},
): Promise<string | null> {
  try {
    const settings = completeConfig(config);
    if (!settings) {
      return null;
    }
    const parts = jwtParts(assertion);
    if (!parts) {
      return null;
    }
    const header = parseJwtHeader(parts[0]);
    if (!header) {
      return null;
    }
    const now = (deps.nowSec ?? defaultNowSec)();
    if (!validClaims(parts[1], settings, now)) {
      return null;
    }
    return await verifiedEmail(parts, header.kid, settings, deps);
  } catch {
    return null;
  }
}

// The settings the JWT path needs: the team, the application and the
// allowlist. All three, or the path denies.
function completeConfig(
  config: AccessConfig,
): { teamDomain: string; aud: string; allowedEmail: string } | null {
  if (!config.teamDomain || !config.aud || !config.allowedEmail) {
    return null;
  }
  return { teamDomain: config.teamDomain, aud: config.aud, allowedEmail: config.allowedEmail };
}

// The three parts of a JWT, when the assertion carries three.
function jwtParts(assertion: string): string[] | null {
  const parts = assertion.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return null;
  }
  return parts;
}

// The email the assertion carries, when the signature and the claims
// agree: the key from the team's JWKS, the signature over it, and the
// allowlisted email.
async function verifiedEmail(
  parts: string[],
  kid: string,
  config: { teamDomain: string; aud: string; allowedEmail: string },
  deps: AccessDeps,
): Promise<string | null> {
  const key = await findJwkKey(config.teamDomain, kid, deps);
  if (!key) {
    return null;
  }
  const signed = await verifyRs256(parts[0], parts[1], parts[2], key);
  return signed ? validClaimsEmail(parts[1], config) : null;
}

function defaultNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function b64urlToBytes(input: string): Uint8Array | null {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function b64urlToJson(input: string): Record<string, unknown> | null {
  const bytes = b64urlToBytes(input);
  if (!bytes) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Header must pin RS256 + a kid: anything else (none, HS256, missing kid)
// fails closed against alg confusion.
function parseJwtHeader(segment: string): { kid: string } | null {
  const json = b64urlToJson(segment);
  if (!json || json["alg"] !== "RS256" || typeof json["kid"] !== "string" || !json["kid"]) {
    return null;
  }
  return { kid: json["kid"] };
}

function claimAudMatches(claim: unknown, aud: string): boolean {
  if (typeof claim === "string") {
    return claim === aud;
  }
  return Array.isArray(claim) && claim.includes(aud);
}

function validClaims(segment: string, config: AccessConfig, now: number): boolean {
  const json = b64urlToJson(segment);
  if (!json) {
    return false;
  }
  if (!claimAudMatches(json["aud"], config.aud ?? "")) {
    return false;
  }
  if (typeof json["exp"] !== "number" || !(json["exp"] > now)) {
    return false;
  }
  return typeof json["email"] === "string" && json["email"].length > 0;
}

function validClaimsEmail(segment: string, config: AccessConfig): string | null {
  const json = b64urlToJson(segment);
  const email = json?.["email"];
  if (typeof email !== "string" || email.toLowerCase() !== (config.allowedEmail ?? "").toLowerCase()) {
    return null;
  }
  return email;
}

function jwksUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

async function fetchJwks(url: string, fetcher: typeof fetch): Promise<JwksKey[] | null> {
  try {
    const res = await fetcher(url);
    if (!res.ok) {
      return null;
    }
    const doc: unknown = await res.json();
    if (typeof doc !== "object" || doc === null || !Array.isArray((doc as Record<string, unknown>)["keys"])) {
      return null;
    }
    return (doc as { keys: JwksKey[] }).keys;
  } catch {
    return null;
  }
}

async function findJwkKey(teamDomain: string, kid: string, deps: AccessDeps): Promise<JwksKey | null> {
  const url = jwksUrl(teamDomain);
  const fetcher = deps.fetcher ?? fetch;
  const now = (deps.nowSec ?? defaultNowSec)();
  const keys = await jwksKeys(url, fetcher, now);
  if (!keys) {
    return null;
  }
  const match = keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (match) {
    return match;
  }
  // Possible rotation since the cache fill: one refetch, then give up.
  return refetchedKey(url, kid, fetcher, deps);
}

// The team's keys: the cached ones while the cache is warm, the team's
// own otherwise. A failed fetch leaves the cache as it was.
async function jwksKeys(url: string, fetcher: typeof fetch, now: number): Promise<JwksKey[] | null> {
  const cached = jwksCache.get(url);
  if (cached && now - cached.fetchedAtSec < ACCESS_JWKS_TTL_SEC) {
    return cached.keys;
  }
  const keys = await fetchJwks(url, fetcher);
  if (!keys) {
    return null;
  }
  jwksCache.set(url, { fetchedAtSec: now, keys });
  return keys;
}

// The key, from keys the team serves now: the cache may hold the keys
// from before the team rotated them.
async function refetchedKey(
  url: string,
  kid: string,
  fetcher: typeof fetch,
  deps: AccessDeps,
): Promise<JwksKey | null> {
  const fresh = await fetchJwks(url, fetcher);
  if (!fresh) {
    return null;
  }
  jwksCache.set(url, { fetchedAtSec: (deps.nowSec ?? defaultNowSec)(), keys: fresh });
  return fresh.find((k) => k.kid === kid && k.kty === "RSA") ?? null;
}

async function verifyRs256(h: string, p: string, sigB64: string, jwk: JwksKey): Promise<boolean> {
  try {
    const sig = b64urlToBytes(sigB64);
    if (!sig) {
      return false;
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, new TextEncoder().encode(`${h}.${p}`));
  } catch {
    return false;
  }
}
