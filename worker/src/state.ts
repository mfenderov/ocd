import { fetchAudits, handleAudit, type AuditRow as BoxAuditRow } from "./audit";
import { authorizeRequest, scopeForDoRoute, unauthorized, type AccessConfig } from "./access";
import { handleTelegramWebhook, resolveBrainConfig, type BotCommand } from "./bot";
import { runCommand, type AuditRow } from "./botcommands";
import {
  handleEnrollApprove,
  handleEnrollDeny,
  handleEnrollRequest,
  mismatchAlertText,
  parseHostSuffixes,
  telegramNotifier,
  type EnrollConfig,
  type NotifyFn,
  type PendingRow,
} from "./enroll";
import { extractBearer, handleHeartbeat, reenrollPingText, shouldPingMismatch } from "./heartbeat";
import { handleMintLink, isTainted, type TombstoneRow } from "./mint";
import {
  handleRevoke,
  handleRevokeAll,
  revokeAllBoxes,
  revokeOneBox,
  type RevokeResult,
} from "./revoke";
import type { TelegramClient } from "./telegram";
import {
  handleDeleteToken,
  handleMintToken,
  handleRotateToken,
  requireScope,
  type TokenRow,
} from "./tokens";

export interface BoxRow {
  id: string;
  hostname: string;
  heartbeat_token_hash: string;
  admin_token_hash: string;
  admin_token_sealed: string;
  epoch: number;
  last_seq: number;
  last_ts: number;
  last_seen: number;
  enrolled: number;
}

// Public backends shape: everything the console needs, none of the secret
// material. GET /backends serves exactly this — token hashes and the sealed
// admin blob never leave the DO over that route. `tombstoned` is the
// server-side pending-revoke marker (same isTainted rule as mint/audit), so
// the console renders it on fresh load instead of guessing offline vs
// blocked.
export interface BoxPublic {
  id: string;
  hostname: string;
  epoch: number;
  last_seq: number;
  last_ts: number;
  last_seen: number;
  enrolled: number;
  tombstoned: boolean;
}

// Deny marker: a refused enrollment leaves id + timestamp (never tokens) so
// denials are auditable instead of silent.
export interface DenialRow {
  id: string;
  denied_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boxes(
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  heartbeat_token_hash TEXT NOT NULL,
  admin_token_hash TEXT NOT NULL,
  admin_token_sealed TEXT NOT NULL DEFAULT '',
  epoch INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  enrolled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending(
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  heartbeat_token_hash TEXT NOT NULL,
  admin_token_sealed TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tombstones(
  box_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS denials(
  id TEXT PRIMARY KEY,
  denied_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS seen_updates(
  update_id INTEGER PRIMARY KEY,
  seen_at INTEGER NOT NULL DEFAULT 0
);
`;

const COLUMNS =
  "id, hostname, heartbeat_token_hash, admin_token_hash, admin_token_sealed, epoch, last_seq, last_ts, last_seen, enrolled";

const PUBLIC_COLUMNS = "id, hostname, epoch, last_seq, last_ts, last_seen, enrolled";

const PENDING_COLUMNS = "id, hostname, heartbeat_token_hash, admin_token_sealed, first_seen, trusted";

// Subset of Worker env the DO reads. workerd passes env as the second
// constructor arg; missing values degrade to loud 500s / dropped pings,
// never silent skips. ENROLL_BASE_URL is not secret (public hostname).
interface FleetEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_CHAT_ID?: string;
  // The secret Telegram sends back in the secret-token header: the one
  // credential the webhook carries.
  TELEGRAM_WEBHOOK_SECRET?: string;
  ENROLL_CAPABILITY_SECRET?: string;
  ADMIN_SEAL_SECRET?: string;
  FLEET_BOOTSTRAP_SECRET?: string;
  ENROLL_BASE_URL?: string;
  FLEET_HOST_SUFFIXES?: string;
  // Cloudflare Access browser bypass (Task 2): team domain derives the JWKS
  // URL, aud is the Access application tag, allowlist is the single owner
  // email. All unset in test/dev — the JWT path then denies fail-closed.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ALLOWED_EMAIL?: string;
  // The box the bot reaches when the owner says "/login" or "/status":
  // a Worker setting, not a fact about the fleet.
  PRIMARY_BOX?: string;
}

// The box the bot reaches by default. The design names "home".
const DEFAULT_PRIMARY_BOX = "home";

export class FleetState implements DurableObject {
  private state: DurableObjectState;
  private botToken?: string;
  private ownerChatId?: string;
  private webhookSecret?: string;
  private capSecret?: string;
  private sealKey?: string;
  private bootstrapSecret?: string;
  private baseUrl?: string;
  private hostSuffixes?: string;
  private teamDomain?: string;
  private accessAud?: string;
  private allowedEmail?: string;
  private primaryBox: string;
  private mismatchPinged = new Map<string, number>();

  constructor(state: DurableObjectState, env?: FleetEnv) {
    this.state = state;
    this.botToken = env?.TELEGRAM_BOT_TOKEN;
    this.ownerChatId = env?.TELEGRAM_OWNER_CHAT_ID;
    this.webhookSecret = env?.TELEGRAM_WEBHOOK_SECRET;
    this.capSecret = env?.ENROLL_CAPABILITY_SECRET;
    this.sealKey = env?.ADMIN_SEAL_SECRET;
    this.bootstrapSecret = env?.FLEET_BOOTSTRAP_SECRET;
    this.baseUrl = env?.ENROLL_BASE_URL;
    this.hostSuffixes = env?.FLEET_HOST_SUFFIXES;
    this.teamDomain = env?.ACCESS_TEAM_DOMAIN;
    this.accessAud = env?.ACCESS_AUD;
    this.allowedEmail = env?.ACCESS_ALLOWED_EMAIL;
    this.primaryBox = env?.PRIMARY_BOX?.trim() || DEFAULT_PRIMARY_BOX;
  }

  private notifier(): NotifyFn {
    return telegramNotifier(this.botToken, this.ownerChatId);
  }

  // The brain's command seam: the Telegram router hands a command here
  // and the command layer answers it. The dependencies are the DO's own
  // relays — the command layer never touches the state itself, so it
  // stays a pure function of what it is given.
  //
  // The client rides in as an argument: the brain owns every message, and
  // the route that owns the token hands the client over.
  async dispatchCommand(cmd: BotCommand, telegram: TelegramClient): Promise<void> {
    await runCommand(cmd, {
      telegram,
      listBoxes: () => this.listBackends(),
      mintLink: (boxId) => this.mintLink(boxId),
      audit: (boxId, limit) => this.auditRows(boxId, limit),
      revoke: (boxId) => this.revokeBox(boxId),
      revokeAll: () => this.revokeEveryBox(),
      issueEnrollCode: (boxId) => this.issueEnrollCode(boxId),
      boxStatus: (boxId) => this.boxStatus(boxId),
      primaryBox: this.primaryBox,
    });
  }

  // The mint relay: the box mints its own tap code and answers with the
  // URL. The brain never mints codes for a box — a code is bound to the
  // box that presents it.
  private async mintLink(boxId: string): Promise<string> {
    const res = await handleMintLink(boxId, null, this, { sealKey: this.sealKey });
    const body = await res.text();
    if (res.status !== 200) {
      throw new Error(`mint failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const url = body.trim();
    if (!url) {
      throw new Error("mint answered with no url");
    }
    return url;
  }

  // The audit: the boxes' rows, merged. The brain's own history is Phase
  // 2's work; until then the bot reads the boxes.
  private async auditRows(boxId: string, limit: number): Promise<AuditRow[]> {
    const rows = await fetchAudits(this, { boxId: boxId || undefined, n: limit }, {
      sealKey: this.sealKey,
    });
    return rows.map(commandAuditRow);
  }

  private async revokeBox(boxId: string): Promise<RevokeResult> {
    return revokeOneBox(boxId, this, { sealKey: this.sealKey });
  }

  private async revokeEveryBox(): Promise<RevokeResult[]> {
    return revokeAllBoxes(this, { sealKey: this.sealKey });
  }

  // The enroll code: the brain is the owner, so it creates the trusted
  // pending row itself — the code is the box's heartbeat secret, the same
  // value the box presents when it claims. The pending row is trusted, so
  // the box may claim it by typing the code: no approve tap, and the code
  // message in the owner-only chat IS the approval.
  private async issueEnrollCode(boxId: string): Promise<{ code: string; command: string }> {
    const code = generateSecret();
    const request = new Request("https://brain.local/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: boxId,
        hostname: `oc-tap-${boxId}.buyallmemes.com`,
        enroll_token: code,
        quiet: true,
      }),
    });
    const res = await handleEnrollRequest(request, this, this.notifier(), undefined, {
      ...this.enrollConfig(),
      trusted: true,
    });
    const body = await res.text();
    if (res.status !== 200) {
      throw new Error(`enroll failed (${res.status}): ${body.slice(0, 200)}`);
    }
    return { code, command: `ocd onboard ${boxId} ${code}` };
  }

  // The box's OpenCode status. The relay is Task 10's work; until then the
  // command layer's error boundary turns this into a readable answer.
  private async boxStatus(_boxId: string): Promise<string> {
    throw new Error("the box status relay is not available yet");
  }

  private enrollConfig(): EnrollConfig {
    return {
      capSecret: this.capSecret,
      baseUrl: this.baseUrl,
      sealKey: this.sealKey,
      hostSuffixes: parseHostSuffixes(this.hostSuffixes),
    };
  }

  private accessConfig(): AccessConfig {
    return {
      teamDomain: this.teamDomain,
      aud: this.accessAud,
      allowedEmail: this.allowedEmail,
    };
  }

  private ensureSchema(): void {
    this.state.storage.sql.exec(SCHEMA);
    const boxCols = this.state.storage.sql.exec("PRAGMA table_info(boxes)").toArray() as Array<{
      name: string;
    }>;
    if (!boxCols.some((c) => c.name === "last_ts")) {
      this.state.storage.sql.exec("ALTER TABLE boxes ADD COLUMN last_ts INTEGER NOT NULL DEFAULT 0");
    }
    if (!boxCols.some((c) => c.name === "admin_token_sealed")) {
      this.state.storage.sql.exec("ALTER TABLE boxes ADD COLUMN admin_token_sealed TEXT NOT NULL DEFAULT ''");
    }
    const pendingCols = this.state.storage.sql.exec("PRAGMA table_info(pending)").toArray() as Array<{
      name: string;
    }>;
    if (!pendingCols.some((c) => c.name === "admin_token_sealed")) {
      this.state.storage.sql.exec("ALTER TABLE pending ADD COLUMN admin_token_sealed TEXT NOT NULL DEFAULT ''");
    }
    if (!pendingCols.some((c) => c.name === "trusted")) {
      this.state.storage.sql.exec("ALTER TABLE pending ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0");
    }
    // CLI tokens (Task 1): PRAGMA-gated like the column migrations above —
    // a missing table reads as zero columns, so fresh and existing DBs
    // converge here instead of in the one-shot SCHEMA string.
    const tokenCols = this.state.storage.sql.exec("PRAGMA table_info(cli_tokens)").toArray() as Array<{
      name: string;
    }>;
    if (tokenCols.length === 0) {
      this.state.storage.sql.exec(
        "CREATE TABLE cli_tokens(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0)",
      );
    }
  }

  listBackends(): BoxPublic[] {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(`SELECT ${PUBLIC_COLUMNS} FROM boxes ORDER BY id`);
    const rows = cursor.toArray() as unknown as Array<Omit<BoxPublic, "tombstoned">>;
    // One tombstone read per box (fleets are small): same isTainted rule the
    // mint gate and audit markers use — no duplicated state, no second table.
    return rows.map((row) => ({ ...row, tombstoned: isTainted(row.epoch, this.getTombstone(row.id)) }));
  }

  // Full rows stay inside the DO: audit/revoke relays decrypt the sealed
  // admin token at call time and need the hashes. Never served over HTTP.
  listBoxes(): BoxRow[] {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(`SELECT ${COLUMNS} FROM boxes ORDER BY id`);
    return cursor.toArray() as unknown as BoxRow[];
  }

  getBox(id: string): BoxRow | undefined {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(`SELECT ${COLUMNS} FROM boxes WHERE id = ? LIMIT 1`, id);
    return cursor.toArray()[0] as unknown as BoxRow | undefined;
  }

  pinnedHostname(boxId: string): string {
    const box = this.getBox(boxId);
    if (!box) {
      throw new Error(`refused: unknown box "${boxId}" (no pinned hostname)`);
    }
    return box.hostname;
  }

  putBox(box: BoxRow): void {
    this.ensureSchema();
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO boxes (id, hostname, heartbeat_token_hash, admin_token_hash, admin_token_sealed, epoch, last_seq, last_ts, last_seen, enrolled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      box.id,
      box.hostname,
      box.heartbeat_token_hash,
      box.admin_token_hash,
      box.admin_token_sealed,
      box.epoch,
      box.last_seq,
      box.last_ts,
      box.last_seen,
      box.enrolled,
    );
  }

  getPending(id: string): PendingRow | undefined {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(
      `SELECT ${PENDING_COLUMNS} FROM pending WHERE id = ? LIMIT 1`,
      id,
    );
    return cursor.toArray()[0] as unknown as PendingRow | undefined;
  }

  putPending(row: PendingRow): void {
    this.ensureSchema();
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO pending (id, hostname, heartbeat_token_hash, admin_token_sealed, first_seen, trusted) VALUES (?, ?, ?, ?, ?, ?)",
      row.id,
      row.hostname,
      row.heartbeat_token_hash,
      row.admin_token_sealed,
      row.first_seen,
      row.trusted,
    );
  }

  deletePending(id: string): void {
    this.ensureSchema();
    this.state.storage.sql.exec("DELETE FROM pending WHERE id = ?", id);
  }

  getDenial(id: string): DenialRow | undefined {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec("SELECT id, denied_at FROM denials WHERE id = ? LIMIT 1", id);
    return cursor.toArray()[0] as unknown as DenialRow | undefined;
  }

  putDenial(row: DenialRow): void {
    this.ensureSchema();
    this.state.storage.sql.exec("INSERT OR REPLACE INTO denials (id, denied_at) VALUES (?, ?)", row.id, row.denied_at);
  }

  getTombstone(boxId: string): TombstoneRow | undefined {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(
      "SELECT box_id, epoch FROM tombstones WHERE box_id = ? LIMIT 1",
      boxId,
    );
    return cursor.toArray()[0] as unknown as TombstoneRow | undefined;
  }

  // Task 5 (revoke) writes through here; mint only reads. Epoch invariant is
  // documented on TombstoneRow in mint.ts.
  putTombstone(row: TombstoneRow): void {
    this.ensureSchema();
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO tombstones (box_id, epoch) VALUES (?, ?)",
      row.box_id,
      row.epoch,
    );
  }

  // CLI token rows (Task 1): hashes and scope JSON only — plaintext values
  // never reach SQLite. No listing endpoint serves these rows.
  getToken(id: string): TokenRow | undefined {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec("SELECT id, token_hash, scopes, created_at FROM cli_tokens WHERE id = ? LIMIT 1", id);
    return cursor.toArray()[0] as unknown as TokenRow | undefined;
  }

  getTokenByHash(hash: string): TokenRow | undefined {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(
      "SELECT id, token_hash, scopes, created_at FROM cli_tokens WHERE token_hash = ? LIMIT 1",
      hash,
    );
    return cursor.toArray()[0] as unknown as TokenRow | undefined;
  }

  putToken(row: TokenRow): void {
    this.ensureSchema();
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO cli_tokens (id, token_hash, scopes, created_at) VALUES (?, ?, ?, ?)",
      row.id,
      row.token_hash,
      row.scopes,
      row.created_at,
    );
  }

  deleteToken(id: string): void {
    this.ensureSchema();
    this.state.storage.sql.exec("DELETE FROM cli_tokens WHERE id = ?", id);
  }

  countTokens(): number {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec("SELECT COUNT(*) AS n FROM cli_tokens");
    return (cursor.toArray()[0] as unknown as { n: number }).n;
  }

  // The dedup table: one row per update the brain handled. Telegram
  // retries a webhook it thinks failed, so a repeated update_id must not
  // run the command twice — a retried /link would mint two links.
  // seenUpdate is true while the update is new and false once the row
  // exists (the update was handled already).
  seenUpdate(updateId: number): boolean {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(
      "SELECT update_id FROM seen_updates WHERE update_id = ? LIMIT 1",
      updateId,
    );
    return cursor.toArray().length === 0;
  }

  markUpdateSeen(updateId: number, at: number): void {
    this.ensureSchema();
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO seen_updates (update_id, seen_at) VALUES (?, ?)",
      updateId,
      at,
    );
  }

  deleteTombstone(boxId: string): void {
    this.ensureSchema();
    this.state.storage.sql.exec("DELETE FROM tombstones WHERE box_id = ?", boxId);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Task 2 guards: link needs link scope, revoke/revoke-all need revoke,
    // backends/audit reads need audit — or a valid Access JWT (browser
    // bypass). Auth runs before existence checks, so unknown ids with bad
    // credentials read 401, never 404. Heartbeat/enroll/token routes keep
    // their own auth and are untouched.
    const scope = scopeForDoRoute(request.method, url.pathname);
    if (scope && !(await authorizeRequest(request, this, scope, this.accessConfig()))) {
      return unauthorized();
    }
    if (request.method === "GET" && url.pathname === "/backends") {
      return Response.json(this.listBackends());
    }
    if (request.method === "GET" && url.pathname === "/audit") {
      return handleAudit(request, this, { sealKey: this.sealKey });
    }
    if (request.method === "POST" && url.pathname === "/tg") {
      // The brain's front door: Telegram's webhook, forwarded by the
      // edge. The settings come from the Worker env; a brain that is not
      // configured fails loud (500) instead of dropping every update
      // silently.
      const brain = resolveBrainConfig({
        botToken: this.botToken,
        ownerChatId: this.ownerChatId,
        webhookSecret: this.webhookSecret,
      });
      if (!brain) {
        return Response.json({ error: "misconfigured" }, { status: 500 });
      }
      return handleTelegramWebhook(request, this, {
        ...brain,
        dispatch: (cmd) => this.dispatchCommand(cmd, brain.telegram),
      });
    }
    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const notify = this.notifier();
      return handleHeartbeat(
        request,
        this,
        undefined,
        async (id: string) => {
          if (!shouldPingMismatch(this.mismatchPinged, id, Date.now())) return;
          await notify(mismatchAlertText(id));
        },
        async (id: string) => {
          await notify(reenrollPingText(id));
        },
      );
    }
    if (request.method === "POST" && url.pathname === "/enroll") {
      // Trust comes from the caller, not the body: a CLI token with the
      // "enroll" scope means the owner asked for this box in Telegram.
      // Unauthenticated requests may still start an enrollment, but their
      // pending row needs the approve tap.
      const bearer = extractBearer(request);
      const trusted = bearer !== null && (await requireScope(this, bearer, "enroll")) !== null;
      return handleEnrollRequest(request, this, this.notifier(), undefined, {
        ...this.enrollConfig(),
        trusted,
      });
    }
    if (request.method === "GET" && url.pathname === "/enroll/approve") {
      return handleEnrollApprove(request, this, this.enrollConfig(), undefined, this.notifier());
    }
    if (request.method === "GET" && url.pathname === "/enroll/deny") {
      return handleEnrollDeny(request, this, this.enrollConfig());
    }
    if (request.method === "POST" && url.pathname === "/revoke-all") {
      return handleRevokeAll(request, this, { sealKey: this.sealKey });
    }
    if (request.method === "POST" && url.pathname.startsWith("/revoke/")) {
      const boxId = decodeURIComponent(url.pathname.slice("/revoke/".length));
      if (!boxId) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      return handleRevoke(boxId, request, this, { sealKey: this.sealKey });
    }
    if (request.method === "POST" && url.pathname.startsWith("/link/")) {
      const boxId = decodeURIComponent(url.pathname.slice("/link/".length));
      if (!boxId) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      return handleMintLink(boxId, request.headers.get("idempotency-key"), this, {
        sealKey: this.sealKey,
      });
    }
    if (request.method === "POST" && url.pathname === "/tokens") {
      return handleMintToken(request, this, { bootstrapSecret: this.bootstrapSecret });
    }
    if (request.method === "POST" && url.pathname.startsWith("/tokens/") && url.pathname.endsWith("/rotate")) {
      const id = decodeURIComponent(url.pathname.slice("/tokens/".length, -"/rotate".length));
      if (!id) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      return handleRotateToken(id, request, this);
    }
    if (
      request.method === "DELETE" &&
      url.pathname.startsWith("/tokens/") &&
      !url.pathname.slice("/tokens/".length).includes("/")
    ) {
      const id = decodeURIComponent(url.pathname.slice("/tokens/".length));
      if (!id) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      return handleDeleteToken(id, request, this);
    }
    return new Response("Not Found", { status: 404 });
  }
}

// The box's audit rows as the command layer reads them: the layer wants
// every field present, and a marker row (a box that could not be read)
// carries no event fields.
function commandAuditRow(row: BoxAuditRow): AuditRow {
  return {
    box: row.box,
    at: row.at,
    actor: "actor" in row ? row.actor : "",
    action: "action" in row ? row.action : "",
    device: "device" in row ? row.device : "",
    ip: "ip" in row ? row.ip : "",
    result: "result" in row ? row.result : "",
    ua: "ua" in row ? row.ua : "",
    tainted: row.tainted,
    ...("error" in row ? { error: row.error } : {}),
  };
}

// The enroll code: 32 random bytes, base64 (the Go bot's
// onboard.GenerateSecret). The code is the box's heartbeat secret, so it
// is never logged and never leaves the owner-only chat.
function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
