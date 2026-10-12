import { hashToken, tokenMatches } from "./heartbeat";
import type { BoxRow, DenialRow } from "./state";

// Enrollment request body (box JSON contract, snake_case): a box that wants
// to join (or re-bind after a token change) sends {id, hostname,
// enroll_token[, admin_token]}. Unknown id OR known id with a non-matching
// token pauses as pending + Telegram ping; approve binds token→id permanently.
// Hostname pinning happens here at enroll time only — heartbeat can never
// change it. admin_token is accepted once and sealed immediately (never
// stored or logged in plaintext); it is decrypted only at call time by the
// mint/revoke relays.
export interface EnrollBody {
  id: string;
  hostname: string;
  enroll_token: string;
  admin_token?: string;
}

export interface PendingRow {
  id: string;
  hostname: string;
  heartbeat_token_hash: string;
  admin_token_sealed: string;
  first_seen: number;
}

// Resolve-time secrets, all from Worker env (see FleetState). Every field is
// optional at the type level so misconfiguration degrades to a loud 500, and
// unit tests can pass explicit values. hostSuffixes overrides the enrollment
// hostname allowlist (parsed from FLEET_HOST_SUFFIXES, default
// buyallmemes.com).
export interface EnrollConfig {
  capSecret?: string;
  baseUrl?: string;
  sealKey?: string;
  hostSuffixes?: string[];
}

export interface EnrollStore {
  getBox(id: string): BoxRow | undefined;
  putBox(box: BoxRow): void;
  getPending(id: string): PendingRow | undefined;
  putPending(row: PendingRow): void;
  deletePending(id: string): void;
  getDenial(id: string): DenialRow | undefined;
  putDenial(row: DenialRow): void;
}

// Owner ping sink. Contract: never throws, never logs secrets —
// sendTelegramMessage below already swallows transport/API failures.
export type NotifyFn = (text: string) => Promise<void>;

// Enrollment intake only accepts real fleet hostnames: multi-label DNS names
// under one of the allowed suffixes (default *.buyallmemes.com). IP
// literals, localhost, single-label names, and .local names are rejected so
// a compromised box or a curious operator cannot pin an address the console
// would later call back (SSRF-adjacent intake). Suffix matching is
// dot-boundary exact: "notbuyallmemes.com" and "x.buyallmemes.com.evil.com"
// do not match.
export const DEFAULT_HOST_SUFFIXES = ["buyallmemes.com"];

export function parseHostSuffixes(raw?: string): string[] {
  if (raw === undefined) {
    return [...DEFAULT_HOST_SUFFIXES];
  }
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\.+$/, ""))
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : [...DEFAULT_HOST_SUFFIXES];
}

function isIPv4Literal(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

export function isPinnedHostname(value: string, suffixes: string[] = DEFAULT_HOST_SUFFIXES): boolean {
  if (value.length === 0 || value.length > 253) {
    return false;
  }
  if (/\s/.test(value) || value.includes("/") || value.includes("://") || value.includes("@") || value.includes(":")) {
    return false;
  }
  if (value.startsWith("[") || isIPv4Literal(value)) {
    return false;
  }
  const lower = value.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return false;
  }
  if (!lower.includes(".")) {
    return false;
  }
  if (lower === "local" || lower.endsWith(".local")) {
    return false;
  }
  return suffixes.some((s) => lower === s || lower.endsWith(`.${s}`));
}

export function parseEnrollBody(value: unknown, suffixes: string[] = DEFAULT_HOST_SUFFIXES): EnrollBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v["id"] !== "string" || v["id"].length === 0) {
    return null;
  }
  if (typeof v["hostname"] !== "string" || !isPinnedHostname(v["hostname"], suffixes)) {
    return null;
  }
  if (typeof v["enroll_token"] !== "string" || v["enroll_token"].length === 0) {
    return null;
  }
  if (v["admin_token"] !== undefined && (typeof v["admin_token"] !== "string" || v["admin_token"].length === 0)) {
    return null;
  }
  const body: EnrollBody = { id: v["id"], hostname: v["hostname"], enroll_token: v["enroll_token"] };
  if (typeof v["admin_token"] === "string") {
    body.admin_token = v["admin_token"];
  }
  return body;
}

export type ResolveAction = "approve" | "deny";

// Capability links: HMAC-SHA256 over (action + pending-id + expiry), keyed by
// a Worker env secret. The action is bound into the MAC so a deny link can
// never approve (stronger than the id+expiry minimum). Enrollment links
// additionally bind the pending heartbeat-token hash + hostname (see
// CapabilityBinding): the approve/deny handlers re-verify equality against
// the CURRENT pending row, so overwriting a pending request invalidates
// previously issued links (approval TOCTOU). Endpoints verify signature +
// expiry before resolving anything.
export const CAPABILITY_TTL_SEC = 900;

// Values bound into an enrollment capability link at issue time. Both are
// non-secret (a SHA-256 hex and a public DNS name) and travel as link
// params; the MAC authenticates them, the resolve step compares them.
export interface CapabilityBinding {
  tokenHash: string;
  hostname: string;
}

export function capBinding(tokenHash: string, hostname: string): string {
  return `${tokenHash}.${hostname}`;
}

export interface CapabilityToken {
  id: string;
  exp: number;
  sig: string;
  tokenHash?: string;
  hostname?: string;
}

export function parseCapabilityQuery(url: URL): CapabilityToken | null {
  const id = url.searchParams.get("id");
  const expRaw = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!id || !expRaw || !sig) {
    return null;
  }
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp <= 0) {
    return null;
  }
  const token: CapabilityToken = { id, exp, sig };
  const tokenHash = url.searchParams.get("token_hash");
  const hostname = url.searchParams.get("hostname");
  if (tokenHash !== null && hostname !== null) {
    token.tokenHash = tokenHash;
    token.hostname = hostname;
  }
  return token;
}

async function importCapKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error("enroll: capability secret not configured");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function capData(action: ResolveAction, id: string, exp: number, binding?: string): Uint8Array {
  const body = binding === undefined ? `${action}.${id}.${exp}` : `${action}.${id}.${exp}.${binding}`;
  return new TextEncoder().encode(body);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function signCapability(
  secret: string,
  action: ResolveAction,
  id: string,
  exp: number,
  binding?: string,
): Promise<string> {
  const key = await importCapKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, capData(action, id, exp, binding)));
  return bytesToHex(sig);
}

export async function verifyCapability(
  secret: string,
  action: ResolveAction,
  id: string,
  exp: number,
  sig: string,
  nowSec: () => number = defaultNowSec,
  binding?: string,
): Promise<boolean> {
  if (!Number.isInteger(exp) || exp <= 0 || nowSec() > exp) {
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(sig)) {
    return false;
  }
  try {
    const key = await importCapKey(secret);
    return await crypto.subtle.verify("HMAC", key, hexToBytes(sig), capData(action, id, exp, binding));
  } catch {
    return false;
  }
}

export async function issueCapabilityLink(opts: {
  secret: string;
  baseUrl?: string;
  action: ResolveAction;
  id: string;
  exp: number;
  binding?: CapabilityBinding;
}): Promise<string> {
  const binding = opts.binding ? capBinding(opts.binding.tokenHash, opts.binding.hostname) : undefined;
  const sig = await signCapability(opts.secret, opts.action, opts.id, opts.exp, binding);
  const base = (opts.baseUrl ?? "").replace(/\/+$/, "");
  let link =
    `${base}/api/enroll/${opts.action}?id=${encodeURIComponent(opts.id)}&exp=${opts.exp}&sig=${sig}`;
  if (opts.binding) {
    link += `&token_hash=${encodeURIComponent(opts.binding.tokenHash)}&hostname=${encodeURIComponent(opts.binding.hostname)}`;
  }
  return link;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function enrollPingText(
  body: Pick<EnrollBody, "id" | "hostname">,
  links: { approve: string; deny: string },
  exp: number,
): string {
  const when = new Date(exp * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
  return (
    `🔐 <b>New box wants in</b>
` +
    `<code>${escapeHtml(body.id)}</code> · <code>${escapeHtml(body.hostname)}</code>
` +
    `<a href="${links.approve}">Approve</a>   <a href="${links.deny}">Deny</a>
` +
    `Links die ${when}.`
  );
}

export function mismatchAlertText(id: string): string {
  return `🚨 <b>Auth mismatch</b> · heartbeat for <code>${escapeHtml(id)}</code> rejected (wrong token). Possible cloned env — check it.`;
}

export function rotationPingText(id: string, now: number): string {
  const when = new Date(now * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
  return `🔑 <b>Admin token rotated</b> · <code>${escapeHtml(id)}</code> · ${when}`;
}

// Direct Bot API call. Bot token + owner chat id come from Worker env only
// (see telegramNotifier). Failures log the status code alone — never the URL
// (it embeds the token), body, or chat id.
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  };
  let res: Response;
  try {
    res = await fetcher(`https://api.telegram.org/bot${botToken}/sendMessage`, init);
  } catch {
    console.error("enroll: telegram send failed (network)");
    return false;
  }
  if (!res.ok) {
    console.error(`enroll: telegram send failed (status ${res.status})`);
    return false;
  }
  return true;
}

export function telegramNotifier(
  botToken: string | undefined,
  chatId: string | undefined,
  fetcher: typeof fetch = fetch,
): NotifyFn {
  if (!botToken || !chatId) {
    return async () => {
      console.error("enroll: telegram not configured; ping dropped");
    };
  }
  return async (text: string) => {
    await sendTelegramMessage(botToken, chatId, text, fetcher);
  };
}

function defaultNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Admin-token sealed storage: AES-GCM-256, key = SHA-256(env secret).
// Stored form is base64(iv(12) ++ ciphertext). Decrypt only at call time
// (mint/revoke relays); heartbeat auth never consults it. Plaintext is never
// logged anywhere on this path.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(raw: string): Uint8Array {
  const binary = atob(raw);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function importSealKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error("enroll: seal key not configured");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealAdminToken(secret: string, plaintext: string): Promise<string> {
  const key = await importSealKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return bytesToBase64(out);
}

// Returns null when no admin token was ever bound; throws on wrong key or
// tampered blob (callers treat that as a hard failure, never a fallback).
export async function unsealAdminToken(secret: string, sealed: string): Promise<string | null> {
  if (!sealed) {
    return null;
  }
  const key = await importSealKey(secret);
  const bytes = base64ToBytes(sealed);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return new TextDecoder().decode(pt);
}

export type EnrollStatus = "pending" | "enrolled";

export async function requestEnrollment(
  store: EnrollStore,
  body: EnrollBody,
  notify: NotifyFn,
  nowSec: () => number = defaultNowSec,
  config: EnrollConfig = {},
): Promise<{ status: EnrollStatus; id: string; rotated: boolean }> {
  const suffixes = config.hostSuffixes ?? DEFAULT_HOST_SUFFIXES;
  if (!isPinnedHostname(body.hostname, suffixes)) {
    throw new Error(`enroll: bad_request (hostname "${body.hostname}" not allowed)`);
  }
  const known = store.getBox(body.id);
  if (known && (await tokenMatches(body.enroll_token, known.heartbeat_token_hash))) {
    // Bound-token fast path. A supplied admin_token is a rotation, never a
    // drop: seal + store it, or fail loud when sealing is unconfigured.
    if (body.admin_token === undefined) {
      return { status: "enrolled", id: body.id, rotated: false };
    }
    if (!config.sealKey) {
      throw new Error("enroll: seal key not configured");
    }
    let current: string | null = null;
    try {
      current = await unsealAdminToken(config.sealKey, known.admin_token_sealed);
    } catch {
      current = null; // unreadable binding counts as different: rotation heals it
    }
    if (current === body.admin_token) {
      return { status: "enrolled", id: body.id, rotated: false };
    }
    const now = nowSec();
    store.putBox({ ...known, admin_token_sealed: await sealAdminToken(config.sealKey, body.admin_token) });
    // A rotation nobody hears about is a silent credential change: ping the
    // owner channel exactly like enrollment pings (id + time, never tokens).
    await notify(rotationPingText(body.id, now));
    return { status: "enrolled", id: body.id, rotated: true };
  }
  if (!config.capSecret) {
    throw new Error("enroll: capability secret not configured");
  }
  let sealed = "";
  if (body.admin_token !== undefined) {
    if (!config.sealKey) {
      throw new Error("enroll: seal key not configured");
    }
    sealed = await sealAdminToken(config.sealKey, body.admin_token);
  }
  const now = nowSec();
  const tokenHash = await hashToken(body.enroll_token);
  store.putPending({
    id: body.id,
    hostname: body.hostname,
    heartbeat_token_hash: tokenHash,
    admin_token_sealed: sealed,
    first_seen: now,
  });
  const exp = now + CAPABILITY_TTL_SEC;
  // Bind the pending token hash + hostname into both links so a later
  // overwrite invalidates these (approval TOCTOU: resolve re-checks).
  const binding: CapabilityBinding = { tokenHash, hostname: body.hostname };
  const approve = await issueCapabilityLink({
    secret: config.capSecret,
    baseUrl: config.baseUrl,
    action: "approve",
    id: body.id,
    exp,
    binding,
  });
  const deny = await issueCapabilityLink({
    secret: config.capSecret,
    baseUrl: config.baseUrl,
    action: "deny",
    id: body.id,
    exp,
    binding,
  });
  if (!config.baseUrl) {
    console.error("enroll: public base URL not configured; ping carries relative links");
  }
  await notify(enrollPingText(body, { approve, deny }, exp));
  return { status: "pending", id: body.id, rotated: false };
}

async function noopNotify(): Promise<void> {}

function bindingMatches(pending: PendingRow, expected: CapabilityBinding): boolean {
  return pending.heartbeat_token_hash === expected.tokenHash && pending.hostname === expected.hostname;
}

export async function approveEnrollment(
  store: EnrollStore,
  id: string,
  notify: NotifyFn = noopNotify,
  nowSec: () => number = defaultNowSec,
  expected?: CapabilityBinding,
): Promise<BoxRow | null> {
  const pending = store.getPending(id);
  if (!pending) {
    return null;
  }
  // TOCTOU close: a link issued before a pending overwrite carries the old
  // token hash/hostname. Fail closed rather than binding the attacker's row.
  if (expected && !bindingMatches(pending, expected)) {
    throw new Error("enroll: forbidden (capability binding mismatch)");
  }
  const known = store.getBox(id);
  const sealed = pending.admin_token_sealed || known?.admin_token_sealed || "";
  // Pending-path rotation: the pending row carries a sealed admin token that
  // differs from the bound one. Same rule as the fast path — ping the owner
  // (id + time, never tokens) instead of swapping silently.
  const rotated = !!known && pending.admin_token_sealed !== "" && pending.admin_token_sealed !== known.admin_token_sealed;
  const now = nowSec();
  const row: BoxRow = known
    ? { ...known, heartbeat_token_hash: pending.heartbeat_token_hash, admin_token_sealed: sealed, enrolled: 1 }
    : {
        id: pending.id,
        hostname: pending.hostname,
        heartbeat_token_hash: pending.heartbeat_token_hash,
        admin_token_hash: "",
        admin_token_sealed: sealed,
        epoch: 0,
        last_seq: 0,
        last_ts: 0,
        last_seen: 0,
        enrolled: 1,
      };
  // Synchronous write block: bind + clear pending together, no interleave.
  store.putBox(row);
  store.deletePending(id);
  if (rotated) {
    await notify(rotationPingText(id, now));
  }
  return row;
}

export function denyEnrollment(
  store: EnrollStore,
  id: string,
  nowSec: () => number = defaultNowSec,
  expected?: CapabilityBinding,
): boolean {
  const pending = store.getPending(id);
  if (!pending) {
    return false;
  }
  if (expected && !bindingMatches(pending, expected)) {
    throw new Error("enroll: forbidden (capability binding mismatch)");
  }
  store.deletePending(id);
  // A deny that leaves no record is unauditable: persist who was refused and
  // when (id + timestamp only, never tokens).
  store.putDenial({ id, denied_at: nowSec() });
  return true;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function handleEnrollRequest(
  request: Request,
  store: EnrollStore,
  notify: NotifyFn,
  nowSec: () => number = defaultNowSec,
  config: EnrollConfig = {},
): Promise<Response> {
  const body = parseEnrollBody(await readJson(request), config.hostSuffixes ?? DEFAULT_HOST_SUFFIXES);
  if (!body) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  try {
    const result = await requestEnrollment(store, body, notify, nowSec, config);
    return Response.json({
      status: result.status,
      id: result.id,
      enrolled: result.status === "enrolled",
      rotated: result.rotated,
    });
  } catch (err) {
    // Defense in depth: direct requestEnrollment callers hit the hostname
    // guard too; surface those as 400, real misconfigurations as 500.
    if (err instanceof Error && err.message.includes("bad_request")) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    console.error(err instanceof Error ? err.message : "enroll: misconfigured");
    return Response.json({ error: "misconfigured" }, { status: 500 });
  }
}

// Capability-gated resolve: malformed params → 400, missing server secret →
// loud 500, bad/expired/forged signature → 403. Signature + expiry verify
// BEFORE any state is read or resolved. When the link carries a binding
// (token_hash + hostname, issued for enrollment pends), the MAC covers it;
// the approve/deny step then re-checks equality against the current pending
// row and fails closed on mismatch (TOCTOU).
async function verifyResolve(
  request: Request,
  action: ResolveAction,
  config: EnrollConfig,
  nowSec: () => number,
): Promise<{ id: string; binding?: CapabilityBinding } | Response> {
  const token = parseCapabilityQuery(new URL(request.url));
  if (!token) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (!config.capSecret) {
    console.error("enroll: capability secret not configured");
    return Response.json({ error: "misconfigured" }, { status: 500 });
  }
  const binding =
    token.tokenHash !== undefined && token.hostname !== undefined
      ? capBinding(token.tokenHash, token.hostname)
      : undefined;
  if (!(await verifyCapability(config.capSecret, action, token.id, token.exp, token.sig, nowSec, binding))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (binding !== undefined && token.tokenHash !== undefined && token.hostname !== undefined) {
    return { id: token.id, binding: { tokenHash: token.tokenHash, hostname: token.hostname } };
  }
  return { id: token.id };
}

function forbiddenResponse(err: unknown): Response | null {
  if (err instanceof Error && err.message.includes("forbidden")) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}

export async function handleEnrollApprove(
  request: Request,
  store: EnrollStore,
  config: EnrollConfig = {},
  nowSec: () => number = defaultNowSec,
  notify: NotifyFn = noopNotify,
): Promise<Response> {
  const verified = await verifyResolve(request, "approve", config, nowSec);
  if (verified instanceof Response) {
    return verified;
  }
  try {
    const row = await approveEnrollment(store, verified.id, notify, nowSec, verified.binding);
    if (!row) {
      return Response.json({ error: "no_pending" }, { status: 404 });
    }
    return Response.json({ status: "approved", id: row.id, enrolled: true });
  } catch (err) {
    return forbiddenResponse(err) ?? Response.json({ error: "misconfigured" }, { status: 500 });
  }
}

export async function handleEnrollDeny(
  request: Request,
  store: EnrollStore,
  config: EnrollConfig = {},
  nowSec: () => number = defaultNowSec,
): Promise<Response> {
  const verified = await verifyResolve(request, "deny", config, nowSec);
  if (verified instanceof Response) {
    return verified;
  }
  try {
    if (!denyEnrollment(store, verified.id, nowSec, verified.binding)) {
      return Response.json({ error: "no_pending" }, { status: 404 });
    }
    return Response.json({ status: "denied", id: verified.id });
  } catch (err) {
    return forbiddenResponse(err) ?? Response.json({ error: "misconfigured" }, { status: 500 });
  }
}
