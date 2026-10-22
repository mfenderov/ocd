import { optionalTextField, textField } from "./fields";
import { hashToken, tokenMatches } from "./heartbeat";
import { escapeHtml } from "./html";
import { sealAdminToken, unsealAdminToken } from "./sealedtoken";
import type { DnsOutcome, DnsWriter, NotifyFn } from "./ports";
import type { BoxRow, DenialRow } from "./boxes";

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
  // tunnel_id is the box's cloudflared tunnel id, absent when the box has
  // no tunnel. The brain stores it on the pending row and on the box row:
  // Phase 2 creates the box's DNS records from it.
  tunnel_id?: string;
  // quiet suppresses the approve/ --deny Telegram ping on a fresh pending
  // row. Used by /enrollcode: the code message IS the approval channel,
  // so a second message would only confuse. Claim and rotation paths
  // never ping here.
  quiet?: boolean;
}

export interface PendingRow {
  id: string;
  hostname: string;
  heartbeat_token_hash: string;
  admin_token_sealed: string;
  // tunnel_id is the box's cloudflared tunnel id, empty when the box has
  // no tunnel. The claim path builds the box row out of this row, so the
  // id must ride along.
  tunnel_id: string;
  first_seen: number;
  // trusted = 1 when the request that created this pending row carried a
  // CLI token with the "enroll" scope, i.e. the owner asked for it in
  // Telegram. Only trusted rows may be claimed by typing the code
  // (no approve tap). Untrusted rows still need the approve link, so an
  // unauthenticated caller can never re-bind a live box.
  trusted: number;
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
  // trusted marks this request as owner-issued (authenticated with the
  // "enroll" scope). Set by the DO, never taken from the request body.
  trusted?: boolean;
  // dns writes the box's two CNAMEs, right after the box row is
  // committed. Unset = the brain cannot write DNS, and every enrolment
  // says so instead of pretending it did.
  dns?: DnsWriter;
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

// Enrollment intake only accepts real fleet hostnames: multi-label DNS names
// under one of the allowed suffixes (default *.buyallmemes.com). IP
// literals, localhost, single-label names, and .local names are rejected so
// a compromised box or a curious operator cannot pin an address the console
// would later call back (SSRF-adjacent intake). Suffix matching is
// dot-boundary exact: "notbuyallmemes.com" and "x.buyallmemes.com.evil.com"
// do not match.
const DEFAULT_HOST_SUFFIXES = ["buyallmemes.com"];

// How long a tunnel id may be. A cloudflared tunnel id is a UUID, so this
// is generous; the cap keeps an unauthenticated enrolment from parking a
// huge string in the pending row.
const TUNNEL_ID_MAX_LEN = 128;

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
  if (!isHostnameShape(value)) {
    return false;
  }
  if (isAddress(value)) {
    return false;
  }
  const lower = value.toLowerCase();
  if (!isRealDomain(lower)) {
    return false;
  }
  return suffixes.some((s) => lower === s || lower.endsWith(`.${s}`));
}

// The shape of a hostname: a name of a sane length, with nothing in it
// that is not a hostname's business.
function isHostnameShape(value: string): boolean {
  if (value.length === 0 || value.length > 253) {
    return false;
  }
  return !hasForbiddenChars(value);
}

// The characters a hostname may not carry: whitespace, a path, a
// scheme, a user, a port.
function hasForbiddenChars(value: string): boolean {
  return (
    /\s/.test(value) ||
    value.includes("/") ||
    value.includes("://") ||
    value.includes("@") ||
    value.includes(":")
  );
}

// An address is not a hostname: the brain calls the box back, and an
// address is not a name it can call.
function isAddress(value: string): boolean {
  return value.startsWith("[") || isIPv4Literal(value);
}

// A real domain: not localhost, not a single label, not a .local name.
function isRealDomain(lower: string): boolean {
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return false;
  }
  if (!lower.includes(".")) {
    return false;
  }
  return lower !== "local" && !lower.endsWith(".local");
}

export function parseEnrollBody(value: unknown, suffixes: string[] = DEFAULT_HOST_SUFFIXES): EnrollBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const fields = validEnrollFields(value as Record<string, unknown>, suffixes);
  if (!fields) {
    return null;
  }
  return enrollBody(fields);
}

// The body's fields, each by its own rule. Null when a field breaks its
// rule.
function validEnrollFields(v: Record<string, unknown>, suffixes: string[]): EnrollFields | null {
  const id = textField(v["id"]);
  if (id === null) {
    return null;
  }
  const hostname = hostnameField(v["hostname"], suffixes);
  if (hostname === null) {
    return null;
  }
  const enrollToken = textField(v["enroll_token"]);
  if (enrollToken === null) {
    return null;
  }
  const adminToken = optionalTextField(v["admin_token"]);
  if (adminToken === null) {
    return null;
  }
  const tunnelId = tunnelIdField(v["tunnel_id"]);
  if (tunnelId === null) {
    return null;
  }
  return { id, hostname, enrollToken, adminToken, tunnelId, quiet: v["quiet"] === true };
}

// The fields the body carries, once each has passed its rule.
interface EnrollFields {
  id: string;
  hostname: string;
  enrollToken: string;
  adminToken?: string;
  tunnelId: string;
  quiet: boolean;
}

// The body, from the fields that passed their rules.
function enrollBody(fields: EnrollFields): EnrollBody {
  const body: EnrollBody = {
    id: fields.id,
    hostname: fields.hostname,
    enroll_token: fields.enrollToken,
  };
  if (fields.adminToken !== undefined) {
    body.admin_token = fields.adminToken;
  }
  // The tunnel id: a cloudflared tunnel id, empty when the box has none.
  // An empty value means "no tunnel" — the same the box's own body says
  // by leaving the field out.
  if (fields.tunnelId !== "") {
    body.tunnel_id = fields.tunnelId;
  }
  if (fields.quiet) {
    body.quiet = true;
  }
  return body;
}

// The hostname: a string the enrolment may pin.
function hostnameField(value: unknown, suffixes: string[]): string | null {
  if (typeof value !== "string" || !isPinnedHostname(value, suffixes)) {
    return null;
  }
  return value;
}

// The tunnel id: a string, trimmed, and short enough to keep.
function tunnelIdField(value: unknown): string | null {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > TUNNEL_ID_MAX_LEN) {
    return null;
  }
  return trimmed;
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
const CAPABILITY_TTL_SEC = 900;

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

interface CapabilityToken {
  id: string;
  exp: number;
  sig: string;
  tokenHash?: string;
  hostname?: string;
}

function parseCapabilityQuery(url: URL): CapabilityToken | null {
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

async function signCapability(
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

// The owner must hear about a DNS that could not be written: the box is
// enrolled (the enrolment is the commit point) but its records are
// missing, and only the owner can fix that.
//
// The reason never carries the credential — the DNS writer's errors name
// the status and the API's code, never the token — and it comes from a
// remote API, so it is escaped like every other value that reaches the
// owner's chat.
export function dnsFailureText(boxId: string, dns: string): string {
  const reason = dns.startsWith("failed:") ? dns.slice("failed:".length).trim() : dns.trim();
  return (
    `🌐 <b>DNS needs you</b> · <code>${escapeHtml(boxId)}</code> enrolled, ` +
    `but the brain could not write its DNS records: ${escapeHtml(reason)}`
  );
}

function defaultNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

type EnrollStatus = "pending" | "enrolled";

// What an enrolment did. The dns field says what the brain did about the
// box's two CNAMEs: "ok", "skipped: <reason>" or "failed: <reason>". It
// rides on every enrolled response — a pending enrolment has no box yet,
// so it has no DNS to report.
export interface EnrollResult {
  status: EnrollStatus;
  id: string;
  rotated: boolean;
  trusted: boolean;
  dns?: string;
}

// What every enrolment path needs: the store, the notifier, the clock
// and the settings.
interface EnrollContext {
  store: EnrollStore;
  body: EnrollBody;
  notify: NotifyFn;
  nowSec: () => number;
  config: EnrollConfig;
}

export async function requestEnrollment(
  store: EnrollStore,
  body: EnrollBody,
  notify: NotifyFn,
  nowSec: () => number = defaultNowSec,
  config: EnrollConfig = {},
): Promise<EnrollResult> {
  const suffixes = config.hostSuffixes ?? DEFAULT_HOST_SUFFIXES;
  if (!isPinnedHostname(body.hostname, suffixes)) {
    throw new Error(`enroll: bad_request (hostname "${body.hostname}" not allowed)`);
  }
  const ctx: EnrollContext = { store, body, notify, nowSec, config };
  const known = store.getBox(body.id);
  if (known && (await tokenMatches(body.enroll_token, known.heartbeat_token_hash))) {
    return rebindEnrolled(ctx, known);
  }
  if (!config.capSecret) {
    throw new Error("enroll: capability secret not configured");
  }
  const pending = store.getPending(body.id);
  if (pending && (await claimable(pending, body, nowSec))) {
    return claimEnrollment(ctx, pending);
  }
  return pendEnrollment(ctx);
}

// The fast path: the box is known and presents the token it is bound to.
//
// The tunnel id can change: a box that re-created its tunnel enrols
// again with the new id. The row must carry the current one, or the
// brain would later write DNS for a tunnel that no longer exists.
// A body that says nothing about the tunnel keeps what the row has.
async function rebindEnrolled(ctx: EnrollContext, known: BoxRow): Promise<EnrollResult> {
  const { store, body, notify, nowSec, config } = ctx;
  const tunnelId = body.tunnel_id ?? known.tunnel_id;
  // Bound-token fast path. A supplied admin_token is a rotation, never a
  // drop: seal + store it, or fail loud when sealing is unconfigured.
  if (body.admin_token === undefined) {
    if (tunnelId !== known.tunnel_id) {
      store.putBox({ ...known, tunnel_id: tunnelId });
    }
    return enrolledResult(config, store, body.id, false, notify);
  }
  if (!config.sealKey) {
    throw new Error("enroll: seal key not configured");
  }
  const current = await currentAdminToken(config.sealKey, known);
  if (current === body.admin_token) {
    return enrolledResult(config, store, body.id, false, notify);
  }
  const now = nowSec();
  store.putBox({
    ...known,
    admin_token_sealed: await sealAdminToken(config.sealKey, body.admin_token),
    tunnel_id: tunnelId,
  });
  // A rotation nobody hears about is a silent credential change: ping the
  // owner channel exactly like enrollment pings (id + time, never tokens).
  await notify(rotationPingText(body.id, now));
  return enrolledResult(config, store, body.id, true, notify);
}

// The admin token the box is bound to, or null when the brain cannot
// read it: an unreadable binding counts as different, so a rotation
// heals it.
async function currentAdminToken(sealKey: string, known: BoxRow): Promise<string | null> {
  try {
    return await unsealAdminToken(sealKey, known.admin_token_sealed);
  } catch {
    return null;
  }
}

// The claim: the owner read the pending token out of Telegram and typed
// it into `ocd onboard`. Displaying a single-use code in the owner-only
// chat WAS the approval, so the box binds immediately with no second
// ping (admin-rotation pings still apply). Anything stale, rebound, or
// mistyped falls through to a fresh pending row.
async function claimEnrollment(ctx: EnrollContext, pending: PendingRow): Promise<EnrollResult> {
  const { store, body, notify, nowSec, config } = ctx;
  // The box's claim is the truth about its tunnel: the brain issued
  // the code before the box had one (the /enrollcode flow), so the
  // pending row names no tunnel until the box claims. The claim's
  // tunnel id rides into the box row the approval below writes; a
  // claim that names none keeps the pending row's own.
  const claimedTunnelId = body.tunnel_id ?? "";
  const pendingTunnelId = claimedTunnelId !== "" ? claimedTunnelId : pending.tunnel_id;
  const pendingSealed = await sealedAdminToken(config, body, pending.admin_token_sealed);
  if (pendingTunnelId !== pending.tunnel_id || pendingSealed !== pending.admin_token_sealed) {
    store.putPending({ ...pending, tunnel_id: pendingTunnelId, admin_token_sealed: pendingSealed });
  }
  const rotated = rotatedByClaim(store, body.id);
  await approveEnrollment(store, body.id, notify, nowSec, {
    tokenHash: pending.heartbeat_token_hash,
    hostname: pending.hostname,
  });
  return enrolledResult(config, store, body.id, rotated, notify);
}

// Whether the box may claim the pending row by typing the code: the row
// is trusted, it is fresh, it names the same hostname, and the box
// presents the same token.
async function claimable(pending: PendingRow, body: EnrollBody, nowSec: () => number): Promise<boolean> {
  if (pending.trusted !== 1) {
    return false;
  }
  if (nowSec() - pending.first_seen > CAPABILITY_TTL_SEC) {
    return false;
  }
  if (pending.hostname !== body.hostname) {
    return false;
  }
  return tokenMatches(body.enroll_token, pending.heartbeat_token_hash);
}

// Whether the claim rotated the admin token: the pending row carries a
// sealed admin token that differs from the bound one.
function rotatedByClaim(store: EnrollStore, boxId: string): boolean {
  const known = store.getBox(boxId);
  if (!known) {
    return false;
  }
  const sealed = store.getPending(boxId)?.admin_token_sealed ?? "";
  return sealed !== "" && sealed !== known.admin_token_sealed;
}

// The pending path: a fresh pending row and the ping that asks the owner
// to approve it.
async function pendEnrollment(ctx: EnrollContext): Promise<EnrollResult> {
  const { store, body, notify, nowSec, config } = ctx;
  const sealed = await sealedAdminToken(config, body, "");
  const now = nowSec();
  const tokenHash = await hashToken(body.enroll_token);
  store.putPending({
    id: body.id,
    hostname: body.hostname,
    heartbeat_token_hash: tokenHash,
    admin_token_sealed: sealed,
    tunnel_id: body.tunnel_id ?? "",
    first_seen: now,
    trusted: config.trusted ? 1 : 0,
  });
  const exp = now + CAPABILITY_TTL_SEC;
  // Bind the pending token hash + hostname into both links so a later
  // overwrite invalidates these (approval TOCTOU: resolve re-checks).
  const binding: CapabilityBinding = { tokenHash, hostname: body.hostname };
  const links = await issueLinks(config, body.id, exp, binding);
  if (!config.baseUrl) {
    console.error("enroll: public base URL not configured; ping carries relative links");
  }
  if (!body.quiet) {
    await notify(enrollPingText(body, links, exp));
  }
  return { status: "pending", id: body.id, rotated: false, trusted: config.trusted === true };
}

// The sealed admin token a row carries: the caller's own, when the box
// brought one, and the row's own otherwise.
async function sealedAdminToken(config: EnrollConfig, body: EnrollBody, current: string): Promise<string> {
  if (body.admin_token === undefined) {
    return current;
  }
  if (!config.sealKey) {
    throw new Error("enroll: seal key not configured");
  }
  return sealAdminToken(config.sealKey, body.admin_token);
}

// The two capability links the ping carries.
async function issueLinks(
  config: EnrollConfig,
  id: string,
  exp: number,
  binding: CapabilityBinding,
): Promise<{ approve: string; deny: string }> {
  const secret = config.capSecret;
  if (!secret) {
    throw new Error("enroll: capability secret not configured");
  }
  const approve = await issueCapabilityLink({
    secret,
    baseUrl: config.baseUrl,
    action: "approve",
    id,
    exp,
    binding,
  });
  const deny = await issueCapabilityLink({
    secret,
    baseUrl: config.baseUrl,
    action: "deny",
    id,
    exp,
    binding,
  });
  return { approve, deny };
}

// The enrolled result, with the DNS the brain wrote (or did not). Every
// enrolled response carries the DNS status: the box row is committed and
// the DNS that follows it is reported, never rolled back.
async function enrolledResult(
  config: EnrollConfig,
  store: EnrollStore,
  id: string,
  rotated: boolean,
  notify: NotifyFn,
): Promise<EnrollResult> {
  return {
    status: "enrolled",
    id,
    rotated,
    trusted: true,
    dns: await ensureDnsFor(config, store, id, notify),
  };
}

// The DNS the brain owns for one box, ensured right after the enrolment
// committed it, and the owner told when it failed.
//
// The enrolment is the commit point: the box row is already written and
// nothing here rolls it back. Two ways to not write:
//   - the box has no tunnel id to point at — there is nothing to do, so
//     the status is a skip and the API is never called;
//   - the brain cannot write (no credential, or the API refused) — the
//     status is a failure that names the reason.
//
// A failure is told to the owner: the box's console is not the owner's
// Telegram, and a box with no DNS resolves nothing while looking
// perfectly healthy. A skip is not a failure — there was nothing to do —
// and "ok" is not news. So exactly one message, and only for a failure.
//
// This is the one place every enrolment path goes through — the fast
// path, the claim path and the approve tap all end here — so no path
// can forget the report.
async function ensureDnsFor(
  config: EnrollConfig,
  store: EnrollStore,
  boxId: string,
  notify: NotifyFn,
): Promise<string> {
  const dns = await writeBoxDns(config, store, boxId);
  if (dns.startsWith("failed:")) {
    await reportDnsFailure(boxId, dns, notify);
  }
  return dns;
}

// The owner is told about the DNS that could not be written, and the
// report can never fail the enrolment.
//
// The enrolment is already committed: the box row is written and nothing
// here rolls it back. A notifier that throws would escape into the
// enrolment's own handler and turn a box that is enrolled into a 500 —
// the box would report a failure for an enrolment that succeeded, and
// would not write its env file. So the report is guarded: it fails
// alone, and the reason goes to the log.
async function reportDnsFailure(boxId: string, dns: string, notify: NotifyFn): Promise<void> {
  try {
    await notify(dnsFailureText(boxId, dns));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`enroll: the DNS failure was not reported (${reason})`);
  }
}

// The DNS the brain owns for one box, written. The status says what
// happened: "ok", "skipped: <reason>" or "failed: <reason>".
//
// The box's own row is the truth: it holds the pinned tap hostname and
// the tunnel id.
async function writeBoxDns(config: EnrollConfig, store: EnrollStore, boxId: string): Promise<string> {
  try {
    return await dnsStatus(config, store, boxId);
  } catch (err) {
    // The API refused us (or the network failed). The enrolment stays
    // committed: the response names the reason and the box keeps its
    // rows.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`enroll: the box's DNS was not written (${reason})`);
    return `failed: ${reason}`;
  }
}

// The status of the DNS write: what the brain could do with the box's
// row.
async function dnsStatus(config: EnrollConfig, store: EnrollStore, boxId: string): Promise<string> {
  // Can this brain write DNS at all? A brain without the credential
  // says so on every enrolment instead of pretending it did.
  const dns = config.dns;
  if (!dns) {
    console.error(
      "enroll: no DNS credential (CLOUDFLARE_DNS_TOKEN / CLOUDFLARE_ZONE_ID) — the box's records were not written",
    );
    return "failed: the brain has no DNS credential";
  }
  const box = store.getBox(boxId);
  const tunnelId = (box?.tunnel_id ?? "").trim();
  // No tunnel id means no target: a record that points nowhere is
  // worse than no record at all, so the brain skips the write and
  // names the box that needs a re-enrol.
  if (!tunnelId) {
    return `skipped: no tunnel id recorded for ${boxId} — re-enrol to bind one`;
  }
  const tapHost = box?.hostname ?? "";
  const uiHost = uiHostFor(boxId, tapHost);
  if (!uiHost) {
    return `failed: the box's hostname "${tapHost}" names no domain to derive a UI host from`;
  }
  const outcome = await writeRecords(dns, { tapHost, uiHost, tunnelId });
  return outcome.ok ? "ok" : `skipped: ${outcome.reason}`;
}

// The box's two CNAMEs, written with the brain's credential.
async function writeRecords(
  writer: DnsWriter,
  hosts: { tapHost: string; uiHost: string; tunnelId: string },
): Promise<DnsOutcome> {
  return writer({
    tapHost: hosts.tapHost,
    uiHost: hosts.uiHost,
    target: `${hosts.tunnelId}.cfargotunnel.com`,
  });
}

// The box's UI host: the tap host's domain with the box's own name in
// front of it — oc-<box>.<suffix>. The same rule the box's onboarding
// uses (internal/onboard/tunnel.go): the box id in front, the tap host's
// domain behind it.
//
// Empty when the tap host names no domain: there is no UI host to
// derive, and the brain must not write one record and call it done.
function uiHostFor(boxId: string, tapHost: string): string {
  const dot = tapHost.indexOf(".");
  return dot > 0 ? `oc-${boxId}${tapHost.slice(dot)}` : "";
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
  const now = nowSec();
  const row = approvedRow(pending, known);
  // Synchronous write block: bind + clear pending together, no interleave.
  store.putBox(row);
  store.deletePending(id);
  if (rotatedAdmin(pending, known)) {
    await notify(rotationPingText(id, now));
  }
  return row;
}

// The box row the approval binds: the pending row's binding over the box
// row the brain knows.
function approvedRow(pending: PendingRow, known: BoxRow | undefined): BoxRow {
  const sealed = pending.admin_token_sealed || known?.admin_token_sealed || "";
  if (!known) {
    return {
      id: pending.id,
      hostname: pending.hostname,
      heartbeat_token_hash: pending.heartbeat_token_hash,
      admin_token_hash: "",
      admin_token_sealed: sealed,
      tunnel_id: pending.tunnel_id,
      epoch: 0,
      last_seq: 0,
      last_ts: 0,
      last_seen: 0,
      enrolled: 1,
    };
  }
  return {
    ...known,
    // A trusted claim may repoint the box: the owner named this
    // hostname when asking for the code. Untrusted (approve-link)
    // claims keep the original hostname.
    ...(pending.trusted === 1 ? { hostname: pending.hostname } : {}),
    heartbeat_token_hash: pending.heartbeat_token_hash,
    admin_token_sealed: sealed,
    // The tunnel id rides from the pending row. A pending row that
    // names no tunnel does not erase the one the box row knows.
    tunnel_id: pending.tunnel_id || known.tunnel_id,
    // Re-approval rebinds trust: restart the seq counter so a box that
    // lost its DB (seq reset to 1) is accepted again. Safe because
    // approval itself is the owner-trusted event and the token still
    // has to match.
    last_seq: 0,
    last_ts: 0,
    enrolled: 1,
  };
}

// Whether the approval rotated the admin token: the pending row carries
// a sealed admin token that differs from the bound one. Same rule as the
// fast path — ping the owner (id + time, never tokens) instead of
// swapping silently.
function rotatedAdmin(pending: PendingRow, known: BoxRow | undefined): boolean {
  if (!known) {
    return false;
  }
  return pending.admin_token_sealed !== "" && pending.admin_token_sealed !== known.admin_token_sealed;
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
      // Whether the box may be claimed by typing the code. False means
      // the request lacked the "enroll" scope, so the box needs the
      // approve tap instead — the bot says so instead of failing later.
      trusted: result.trusted,
      // What the brain did about the box's two CNAMEs after the
      // enrolment committed. A pending enrolment has no box yet, so it
      // carries no DNS status.
      dns: result.dns,
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
    // The approval is an enrolment too: the brain writes the box's DNS
    // right after it commits the box row — and tells the owner when it
    // could not.
    const dns = await ensureDnsFor(config, store, row.id, notify);
    return Response.json({ status: "approved", id: row.id, enrolled: true, dns });
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
