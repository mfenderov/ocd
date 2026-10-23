import { handleAudit } from "./audit";
import { authorizeRequest, unauthorized, type AccessConfig } from "./access";
import { handleTelegramWebhook, resolveBrainConfig, type BotCommand } from "./bot";
import { runCommand, type DeviceRow, type LinkRecord } from "./botcommands";
import { type BoxPublic, type BoxRow, type DenialRow } from "./boxes";
import { boxAdapter, pairingLink } from "./boxapi";
import { boxDnsWriter } from "./dns";
import {
  handleEnrollApprove,
  handleEnrollDeny,
  handleEnrollRequest,
  mismatchAlertText,
  parseHostSuffixes,
  type EnrollConfig,
  type PendingRow,
} from "./enroll";
import {
  handleEvents,
  sweepOwedEdits,
  type AuditRow as EventAuditRow,
  type LinkRow,
} from "./events";
import { extractBearer, handleHeartbeat, reenrollPingText, shouldPingMismatch, shouldPingReenroll, tokenMatches } from "./heartbeat";
import { handleMintLink } from "./mint";
import type { Box, BoxReply, BoxSilence } from "./box";
import type { DnsWriter } from "./records";
import type { NotifyFn, OwnerChat } from "./owner";
import { unsealAdminToken } from "./sealedtoken";
import {
  handleRevoke,
  handleRevokeAll,
  revokeAllBoxes,
  revokeOneBox,
  type RevokeResult,
} from "./revoke";
import { exact, findRoute, optionalId, optionalSingleId, type Route } from "./routes";
import { createTelegramClient, telegramNotifier } from "./telegram";
import { isTainted, type TombstoneRow } from "./tombstone";
import {
  handleDeleteToken,
  handleMintToken,
  handleRotateToken,
  requireScope,
  type TokenRow,
} from "./tokens";

// What a route's handler gets: the request, the URL, and the id the path
// names.
interface DoContext {
  request: Request;
  url: URL;
  // The id the path names, empty when the path names none.
  id: string;
}

export type DoRoute = Route<(state: FleetState, ctx: DoContext) => Promise<Response>>;

// The answer for a path that names nothing.
function badRequest(): Response {
  return Response.json({ error: "bad_request" }, { status: 400 });
}

// One row of the brain's own history: the row the box pushed plus the flag
// that says the box was tainted when it pushed it.
export interface AuditLogRow extends EventAuditRow {
  tainted: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boxes(
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  heartbeat_token_hash TEXT NOT NULL,
  admin_token_hash TEXT NOT NULL,
  admin_token_sealed TEXT NOT NULL DEFAULT '',
  -- The box's cloudflared tunnel id, empty when the box has no tunnel.
  -- Phase 2 writes the box's DNS records from it.
  tunnel_id TEXT NOT NULL DEFAULT '',
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
  -- The tunnel id the box named. The claim path builds the box row out
  -- of the pending row, so the id must live here too.
  tunnel_id TEXT NOT NULL DEFAULT '',
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
-- Every tap link the brain handed out: the token, the box that minted it
-- and the Telegram message that carries it, so the brain can edit that
-- message when the link is spent or dies. The row carries no expiry: the
-- box decides when a link dies and pushes "link-expired".
CREATE TABLE IF NOT EXISTS links(
  token TEXT PRIMARY KEY,
  box_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued',
  created_at INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER NOT NULL DEFAULT 0,
  used_ip TEXT NOT NULL DEFAULT '',
  used_ua TEXT NOT NULL DEFAULT '',
  edited INTEGER NOT NULL DEFAULT 0
);
-- The fleet's history, ingested from the boxes.
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  tainted INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL DEFAULT ''
);
-- The dedup key: a box that pushes the same row twice stores it once.
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_key ON audit_log(box_id, at, action, token);
`;

const COLUMNS =
  "id, hostname, heartbeat_token_hash, admin_token_hash, admin_token_sealed, tunnel_id, epoch, last_seq, last_ts, last_seen, enrolled";

// A column the brain added after the first release: the column's name
// and the statement that adds it. A DB without the column gets it here,
// so a fresh DB and an old one converge.
interface ColumnMigration {
  column: string;
  sql: string;
}

const BOX_MIGRATIONS: readonly ColumnMigration[] = [
  { column: "last_ts", sql: "ALTER TABLE boxes ADD COLUMN last_ts INTEGER NOT NULL DEFAULT 0" },
  { column: "admin_token_sealed", sql: "ALTER TABLE boxes ADD COLUMN admin_token_sealed TEXT NOT NULL DEFAULT ''" },
  { column: "tunnel_id", sql: "ALTER TABLE boxes ADD COLUMN tunnel_id TEXT NOT NULL DEFAULT ''" },
];

const PENDING_MIGRATIONS: readonly ColumnMigration[] = [
  { column: "admin_token_sealed", sql: "ALTER TABLE pending ADD COLUMN admin_token_sealed TEXT NOT NULL DEFAULT ''" },
  { column: "trusted", sql: "ALTER TABLE pending ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0" },
  { column: "tunnel_id", sql: "ALTER TABLE pending ADD COLUMN tunnel_id TEXT NOT NULL DEFAULT ''" },
];

const PUBLIC_COLUMNS = "id, hostname, epoch, last_seq, last_ts, last_seen, enrolled";

const PENDING_COLUMNS = "id, hostname, heartbeat_token_hash, admin_token_sealed, tunnel_id, first_seen, trusted";

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
  // The zone the brain owns the DNS of (a plain var) and the token that
  // writes it (a secret). Without both the brain cannot write DNS, and
  // every enrolment says so instead of pretending it did.
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_DNS_TOKEN?: string;
}

// The box the bot reaches by default. The design names "home".
const DEFAULT_PRIMARY_BOX = "home";

// The alarm's period: the brain's only timer. Every 30 seconds the brain
// re-drives the owed edits and prunes the old rows. A Durable Object alarm is the only scheduler a Worker
// has, so nothing else may assume a timer.
const ALARM_INTERVAL_MS = 30_000;

// How long a row lives: the dedup table and the links are pruned after
// 24 hours, the same window the box prunes its own link tokens on.
const PRUNE_AFTER_SEC = 24 * 60 * 60;

// The alarm's dependencies: the client that carries the owed edits and
// the clock. The alarm builds them from the Worker env; a test hands in
// its own.
export interface AlarmDeps {
  // The edits go to the owner's chat through this client. A brain
  // without a Telegram token still prunes — only the edit needs
  // Telegram — and the edits stay owed until the client exists.
  telegram?: OwnerChat;
  nowSec: () => number;
}

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
  // The brain's DNS credential: the zone it owns and the token that
  // writes it. Both come from the Worker env; the token never leaves it.
  private zoneId?: string;
  private dnsToken?: string;
  // The owner-ping ledgers: one message per box per condition per window.
  // A wrong token and a lost DB are different facts, so they keep separate
  // ledgers — neither may hide the other.
  private mismatchPinged = new Map<string, number>();
  private reenrollPinged = new Map<string, number>();
  // The alarm's dependencies: the client that carries the owed edits
  // and the clock. The constructor fills them from the Worker env; a
  // test hands in its own, so the alarm runs without Telegram and
  // without the network.
  alarmDeps: AlarmDeps;
  // The box the brain asks: the box port, spoken by the adapter. The
  // wiring builds it and hands it to the brain.
  readonly box: Box;
  // The routes the DO answers: the table the router looks up. Public so
  // the tests can read the scope each route needs off it.
  readonly routes: DoRoute[];

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
    this.zoneId = env?.CLOUDFLARE_ZONE_ID;
    this.dnsToken = env?.CLOUDFLARE_DNS_TOKEN;
    this.box = boxAdapter(this);
    this.alarmDeps = {
      telegram: this.telegramClient(),
      nowSec: () => nowSec(),
    };
    this.routes = this.buildRoutes();
  }

  private notifier(): NotifyFn {
    return telegramNotifier(this.telegramClient(), this.ownerChatId);
  }

  // The brain's Telegram client: the brain owns every message, and the
  // events route uses it to edit the messages it handed out. Without a
  // token there is no client, and the edits stay owed.
  private telegramClient(): OwnerChat | undefined {
    return this.botToken ? createTelegramClient(this.botToken) : undefined;
  }

  // The brain's command seam: the Telegram router hands a command here
  // and the command layer answers it. The dependencies are the DO's own
  // relays and reads — the command layer never touches the state itself,
  // so it stays a pure function of what it is given.
  //
  // The client rides in as an argument: the brain owns every message, and
  // the route that owns the token hands the client over.
  async dispatchCommand(cmd: BotCommand, telegram: OwnerChat): Promise<void> {
    await runCommand(cmd, {
      telegram,
      listBoxes: () => this.listBackends(),
      mintLink: (boxId) => this.mintLink(boxId),
      // The pairing URL out of a tap the brain minted: the tap's own
      // answer, read server-side.
      resolvePair: (boxId, tapUrl) => this.resolveTap(boxId, tapUrl),
      // The history: the brain's own table. The boxes pushed these rows,
      // so a box that is offline — or gone for good — keeps its history.
      audit: (boxId, limit) => Promise.resolve(this.auditLogRows(boxId, limit)),
      // The tapping clients: the same table, aggregated.
      devices: () => Promise.resolve(this.deviceRows()),
      revoke: (boxId) => this.revokeBox(boxId),
      revokeAll: () => this.revokeEveryBox(),
      issueEnrollCode: (boxId) => this.issueEnrollCode(boxId),
      boxStatus: (boxId) => this.boxStatus(boxId),
      recordLink: (link) => this.recordLink(link),
      primaryBox: this.primaryBox,
    });
  }

  // The link registry: every link the brain hands out, with the message
  // it rides on. The brain edits that message when the link is spent or
  // dies, so the row has to remember where the message lives.
  private recordLink(link: LinkRecord): void {
    this.putLink({
      token: link.token,
      box_id: link.box,
      chat_id: link.chatId,
      message_id: link.messageId,
      state: "issued",
      created_at: nowSec(),
      used_at: 0,
      used_ip: "",
      used_ua: "",
      edited: 0,
    });
  }

  // The mint relay: the box mints its own tap code and answers with the
  // URL. The brain never mints codes for a box — a code is bound to the
  // box that presents it.
  private async mintLink(boxId: string): Promise<string> {
    const res = await handleMintLink(boxId, null, this, { sealKey: this.sealKey, box: this.box });
    const body = await res.text();
    if (res.status !== 200) {
      throw new Error(relayFailure("mint failed", res.status, body));
    }
    const url = body.trim();
    if (!url) {
      throw new Error("mint answered with no url");
    }
    return url;
  }

  // The pairing URL out of a tap the brain minted: a server-side GET of
  // the tap URL that reads the printed link without following the
  // redirect. The tap is single-use, so this spends it — the pairing URL
  // it answers with is what the owner copies.
  private async resolveTap(boxId: string, tapUrl: string): Promise<string> {
    const answer = await this.box.resolvePair(boxId, tapUrl);
    if (answer.kind === "silent") {
      throw new Error(tapSilence(answer.reason, boxId));
    }
    return pairingLink(answer.message.status, answer.message.said);
  }

  private async revokeBox(boxId: string): Promise<RevokeResult> {
    return revokeOneBox(boxId, this, { sealKey: this.sealKey, box: this.box });
  }

  private async revokeEveryBox(): Promise<RevokeResult[]> {
    return revokeAllBoxes(this, { sealKey: this.sealKey, box: this.box });
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
      throw new Error(relayFailure("enroll failed", res.status, body));
    }
    return { code, command: `ocd onboard ${boxId} ${code}` };
  }

  // The box's OpenCode status, relayed: the box's own line, as plain
  // text. The brain does not parse it — the command layer prints what
  // the box said.
  private async boxStatus(boxId: string): Promise<string> {
    const answer = await this.askBox(boxId, (id, token) => this.box.status(id, token));
    if (answer.kind === "silent") {
      throw new Error(
        answer.reason === "unknown_box" ? `unknown box "${boxId}"` : `the box did not answer (${answer.reason})`,
      );
    }
    if (answer.message.status !== 200) {
      throw new Error(`the box answered ${answer.message.status}`);
    }
    return answer.message.said.trim();
  }

  // The box's answer, or the reason the brain could not ask it. The
  // token is the brain's own: it is unsealed here, at call time, right
  // before the call — never earlier, never logged.
  private async askBox(
    boxId: string,
    ask: (boxId: string, adminToken: string) => Promise<BoxReply>,
  ): Promise<BoxReply> {
    const box = this.getBox(boxId);
    if (!box || box.enrolled !== 1) {
      return { kind: "silent", reason: "unknown_box" };
    }
    const adminToken = await this.boxToken(box);
    if (adminToken === null) {
      return { kind: "silent", reason: "misconfigured" };
    }
    return ask(boxId, adminToken);
  }

  // The box's admin token, unsealed at call time — the same rule the
  // mint and the revoke relays follow. Null when the brain cannot read
  // it: no seal key, a binding it cannot read, or a box with no admin
  // token bound.
  private async boxToken(box: BoxRow): Promise<string | null> {
    if (!this.sealKey) {
      console.error("relay: seal key not configured");
      return null;
    }
    let adminToken: string | null;
    try {
      adminToken = await unsealAdminToken(this.sealKey, box.admin_token_sealed);
    } catch {
      console.error("relay: admin token unseal failed");
      return null;
    }
    if (!adminToken) {
      console.error("relay: no admin token bound for box");
      return null;
    }
    return adminToken;
  }

  // The relay's answer: the box's own body, or the reason the box was
  // not reached. The content type is the route's own: the box's status
  // is a line of text, its presence report is a document.
  private async relayRoute(
    boxId: string,
    ask: (boxId: string, adminToken: string) => Promise<BoxReply>,
    contentType: string,
  ): Promise<Response> {
    const answer = await this.askBox(boxId, ask);
    if (answer.kind === "silent") {
      return Response.json({ error: answer.reason }, { status: relayFailureStatus(answer.reason) });
    }
    if (answer.message.status !== 200) {
      // The box answered and refused. The console must not read the
      // box's refusal as its own credential problem, so a refusal is a
      // 502 that carries the box's status.
      return Response.json(
        { error: "box_error", box_status: answer.message.status, detail: answer.message.said.slice(0, 200) },
        { status: 502 },
      );
    }
    return new Response(answer.message.said, {
      status: 200,
      headers: { "content-type": contentType },
    });
  }

  private enrollConfig(): EnrollConfig {
    return {
      capSecret: this.capSecret,
      baseUrl: this.baseUrl,
      sealKey: this.sealKey,
      hostSuffixes: parseHostSuffixes(this.hostSuffixes),
      dns: this.dnsWriter(),
    };
  }

  // The brain's DNS writer, or nothing when the brain has none: an
  // enrolment then reports the DNS it could not write.
  private dnsWriter(): DnsWriter | undefined {
    if (!this.zoneId || !this.dnsToken) {
      return undefined;
    }
    return boxDnsWriter({ zoneId: this.zoneId, token: this.dnsToken });
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
    this.addMissingColumns("boxes", BOX_MIGRATIONS);
    this.addMissingColumns("pending", PENDING_MIGRATIONS);
    this.ensureTokenTable();
  }

  // The columns a table is missing, added one statement each. A fresh DB
  // has them all (the SCHEMA above), an old one has some: the two
  // converge here.
  private addMissingColumns(table: string, migrations: readonly ColumnMigration[]): void {
    const existing = this.columnNames(table);
    for (const migration of migrations) {
      if (!existing.includes(migration.column)) {
        this.state.storage.sql.exec(migration.sql);
      }
    }
  }

  // The columns a table has.
  private columnNames(table: string): string[] {
    const rows = this.state.storage.sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{
      name: string;
    }>;
    return rows.map((row) => row.name);
  }

  // CLI tokens (Task 1): PRAGMA-gated like the column migrations above —
  // a missing table reads as zero columns, so fresh and existing DBs
  // converge here instead of in the one-shot SCHEMA string.
  private ensureTokenTable(): void {
    if (this.columnNames("cli_tokens").length === 0) {
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
    // The upsert, not a replace: a replace drops every column the row
    // does not carry. A heartbeat rewrites the box's own fields and must
    // leave anything else — including columns older releases wrote —
    // alone.
    this.state.storage.sql.exec(
      "INSERT INTO boxes (id, hostname, heartbeat_token_hash, admin_token_hash, admin_token_sealed, tunnel_id, epoch, last_seq, last_ts, last_seen, enrolled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hostname = excluded.hostname, heartbeat_token_hash = excluded.heartbeat_token_hash, admin_token_hash = excluded.admin_token_hash, admin_token_sealed = excluded.admin_token_sealed, tunnel_id = excluded.tunnel_id, epoch = excluded.epoch, last_seq = excluded.last_seq, last_ts = excluded.last_ts, last_seen = excluded.last_seen, enrolled = excluded.enrolled",
      box.id,
      box.hostname,
      box.heartbeat_token_hash,
      box.admin_token_hash,
      box.admin_token_sealed,
      box.tunnel_id,
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
      "INSERT OR REPLACE INTO pending (id, hostname, heartbeat_token_hash, admin_token_sealed, tunnel_id, first_seen, trusted) VALUES (?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.hostname,
      row.heartbeat_token_hash,
      row.admin_token_sealed,
      row.tunnel_id,
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
  // documented on TombstoneRow in tombstone.ts.
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

  // The links the brain handed out. The brain edits the message that
  // carries a link when the link is spent or dies, so the row remembers
  // where that message lives.
  linkRow(token: string): LinkRow | undefined {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(
      "SELECT token, box_id, chat_id, message_id, state, created_at, used_at, used_ip, used_ua, edited FROM links WHERE token = ? LIMIT 1",
      token,
    );
    return cursor.toArray()[0] as unknown as LinkRow | undefined;
  }

  putLink(row: LinkRow): void {
    this.ensureSchema();
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO links (token, box_id, chat_id, message_id, state, created_at, used_at, used_ip, used_ua, edited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.token,
      row.box_id,
      row.chat_id,
      row.message_id,
      row.state,
      row.created_at,
      row.used_at,
      row.used_ip,
      row.used_ua,
      row.edited,
    );
  }

  // The link is spent. True when the link is in that state and the edit
  // is still owed: the first report, or a retry after a failed edit.
  markLinkUsed(token: string, ip: string, ua: string, at: number): boolean {
    const row = this.linkRow(token);
    if (!row) {
      return false;
    }
    if (row.state !== "used") {
      this.putLink({ ...row, state: "used", used_at: at, used_ip: ip, used_ua: ua });
      return true;
    }
    // Already spent: an edit is still owed only when the last one failed.
    return row.edited === 0;
  }

  // The link died. A spent link is not dead: it stays "logged in". True
  // when the link is in that state and the edit is still owed.
  markLinkExpired(token: string): boolean {
    const row = this.linkRow(token);
    if (!row || row.state === "used") {
      return false;
    }
    if (row.state !== "expired") {
      this.putLink({ ...row, state: "expired" });
      return true;
    }
    return row.edited === 0;
  }

  // One row of the fleet's history. The row is keyed on box + at + action
  // + token, so a box that pushes the same row twice stores it once.
  addAuditRow(row: EventAuditRow): boolean {
    this.ensureSchema();
    // The taint is the box's state when it pushed the row: a row that
    // happened while the box's revoke was pending stays marked.
    const box = this.getBox(row.box);
    const tainted = box ? isTainted(box.epoch, this.getTombstone(row.box)) : false;
    this.state.storage.sql.exec(
      "INSERT OR IGNORE INTO audit_log (box_id, at, actor, action, device, ip, result, ua, tainted, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.box,
      row.at,
      row.actor,
      row.action,
      row.device,
      row.ip,
      row.result,
      row.ua,
      tainted ? 1 : 0,
      row.token,
    );
    // changes() counts the row the insert stored: 1 when it was stored,
    // 0 when the key was already there and the insert was ignored.
    const changed = this.state.storage.sql.exec("SELECT changes() AS n").toArray()[0] as
      | { n: number }
      | undefined;
    return changed?.n === 1;
  }

  // The brain's own history: the rows the boxes pushed, newest first.
  auditLogRows(boxId: string, limit: number): AuditLogRow[] {
    this.ensureSchema();
    const columns = "box_id, at, actor, action, device, ip, result, ua, tainted, token";
    const cursor = boxId
      ? this.state.storage.sql.exec(
          `SELECT ${columns} FROM audit_log WHERE box_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
          boxId,
          limit,
        )
      : this.state.storage.sql.exec(
          `SELECT ${columns} FROM audit_log ORDER BY at DESC, id DESC LIMIT ?`,
          limit,
        );
    const rows = cursor.toArray() as unknown as Array<{
      box_id: string;
      at: number;
      actor: string;
      action: string;
      device: string;
      ip: string;
      result: string;
      ua: string;
      tainted: number;
      token: string;
    }>;
    return rows.map((row) => ({
      box: row.box_id,
      at: row.at,
      actor: row.actor,
      action: row.action,
      device: row.device,
      ip: row.ip,
      result: row.result,
      ua: row.ua,
      tainted: row.tainted === 1,
      token: row.token,
    }));
  }

  // The tapping clients: distinct IP + user-agent pairs from the
  // brain's own history — the Go bot's SeenClients, read from the rows
  // the boxes pushed instead of the box's own table. Only the tap
  // actions count: a row that is not a tap is not a tapping client.
  deviceRows(): DeviceRow[] {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(
      "SELECT ip, ua, COUNT(*) AS n, MAX(at) AS last FROM audit_log WHERE action IN ('tapped','consumed') GROUP BY ip, ua ORDER BY last DESC",
    );
    const rows = cursor.toArray() as unknown as Array<{
      ip: string;
      ua: string;
      n: number;
      last: number;
    }>;
    return rows.map((row) => ({ ip: row.ip, ua: row.ua, count: row.n, last: row.last }));
  }

  // The box's own check: the bearer is the box's heartbeat token, the
  // same secret the heartbeat uses.
  async verifyBoxToken(id: string, token: string): Promise<boolean> {
    const box = this.getBox(id);
    if (!box) {
      return false;
    }
    return tokenMatches(token, box.heartbeat_token_hash);
  }

  // The links whose message still owes an edit: the link is spent or
  // dead and the edit did not land. The alarm drives them, oldest
  // first: a link that has waited longest for its edit gets it first.
  // The limit is in the query: the alarm must not load the whole owed
  // set, and the links behind it must not wait behind a link whose edit
  // fails for good.
  owedLinks(limit: number): LinkRow[] {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(
      "SELECT token, box_id, chat_id, message_id, state, created_at, used_at, used_ip, used_ua, edited FROM links WHERE edited = 0 AND state IN ('used', 'expired') ORDER BY created_at, token LIMIT ?",
      limit,
    );
    return cursor.toArray() as unknown as LinkRow[];
  }

  // The prune: the rows the brain does not need any more. The dedup
  // table and the links live 24 hours — the same window the box prunes
  // its own link tokens on.
  private pruneOldRows(now: number, olderThanSec: number): void {
    this.ensureSchema();
    const cutoff = now - olderThanSec;
    this.state.storage.sql.exec("DELETE FROM seen_updates WHERE seen_at < ?", cutoff);
    this.state.storage.sql.exec("DELETE FROM links WHERE created_at < ?", cutoff);
  }

  // The alarm: the brain's only clock. workerd calls it when the alarm
  // fires, and it does every periodic work the brain has: the owed
  // edits and the prunes. Then it re-arms itself.
  async alarm(): Promise<void> {
    try {
      await this.runAlarmWork(this.alarmDeps);
    } finally {
      // The next tick. The alarm re-arms even when the work failed: a
      // failing sweep must not stop the brain's clock.
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  // The alarm's work. Every step gets its own boundary: a step that
  // throws must not skip the steps behind it — a broken owed-edit sweep
  // must not cost the fleet its prune, and the other way round.
  private async runAlarmWork(deps: AlarmDeps): Promise<void> {
    // The prune first: it is the cheapest work and the one that must
    // not be skipped. The tables grow without it, and a later step that
    // throws must not keep them from shrinking.
    await this.alarmStep("the prune", () => this.pruneOldRows(deps.nowSec(), PRUNE_AFTER_SEC));
    // The owed edits: a link whose message still says "tap me" is the
    // most visible thing the brain owes the owner.
    await this.alarmStep("the owed edits", () => sweepOwedEdits(this, { telegram: deps.telegram }));
  }

  // One step of the alarm, in its own boundary: a step that throws is
  // logged, and the tick goes on to the next step.
  private async alarmStep(name: string, work: () => void | Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      console.error(`alarm: ${name} failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // The alarm is armed once — the first request that finds no alarm
  // sets it — and the alarm handler re-arms it after every run. Arming
  // it on every request would push the tick back every time the brain
  // is busy.
  private async ensureAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The brain's clock starts with its first request: the alarm is
    // armed once, and it keeps itself armed from then on.
    await this.ensureAlarm();
    const found = findRoute(this.routes, request.method, url.pathname);
    if (!found) {
      return new Response("Not Found", { status: 404 });
    }
    // Task 2 guards: link needs link scope, revoke/revoke-all need revoke,
    // backends/audit reads need audit — or a valid Access JWT (browser
    // bypass). Auth runs before existence checks, so unknown ids with bad
    // credentials read 401, never 404. Heartbeat/enroll/token routes keep
    // their own auth and are untouched.
    if (
      found.route.scope &&
      !(await authorizeRequest(request, this, found.route.scope, this.accessConfig()))
    ) {
      return unauthorized();
    }
    return found.route.handler(this, { request, url, id: found.id });
  }

  // The DO's routes: a table, not a switch.
  //
  // Each row says which method and path it answers, the scope it needs (a
  // row without a scope carries its own auth), and the handler that
  // answers. The order is the order the brain answers in.
  private buildRoutes(): DoRoute[] {
    return [
      // The reads: the boxes the brain knows, and the fleet's history.
      { method: "GET", path: exact("/backends"), scope: "audit", handler: (s) => Promise.resolve(Response.json(s.listBackends())) },
      { method: "GET", path: exact("/audit"), scope: "audit", handler: (s, c) => handleAudit(c.request, s, { sealKey: s.sealKey, box: s.box }) },
      // The brain's front door: Telegram's webhook, forwarded by the edge.
      { method: "POST", path: exact("/tg"), handler: (s, c) => s.telegramRoute(c.request) },
      // The boxes' door: the box authenticates itself with its heartbeat
      // token and names itself in the body, so this route carries no
      // console scope — a console token must not forge box events.
      { method: "POST", path: exact("/events"), handler: (s, c) => s.eventsRoute(c.request) },
      { method: "POST", path: exact("/heartbeat"), handler: (s, c) => s.heartbeatRoute(c.request) },
      // The enrolment: the request, the approve tap and the deny tap.
      { method: "POST", path: exact("/enroll"), handler: (s, c) => s.enrollRoute(c.request) },
      { method: "GET", path: exact("/enroll/approve"), handler: (s, c) => s.enrollApproveRoute(c.request) },
      { method: "GET", path: exact("/enroll/deny"), handler: (s, c) => s.enrollDenyRoute(c.request) },
      // The revokes.
      { method: "POST", path: exact("/revoke-all"), scope: "revoke", handler: (s, c) => handleRevokeAll(c.request, s, { sealKey: s.sealKey, box: s.box }) },
      { method: "POST", path: optionalId("/revoke/"), scope: "revoke", handler: (s, c) => s.revokeRoute(c.request, c.id) },
      // The mint: the box mints its own tap code.
      { method: "POST", path: optionalId("/link/"), scope: "link", handler: (s, c) => s.linkRoute(c.request, c.id) },
      // The per-box relays: the box's presence and its status.
      { method: "GET", path: optionalId("/presence/"), scope: "audit", handler: (s, c) => s.presenceRoute(c.id) },
      { method: "GET", path: optionalId("/status/"), scope: "audit", handler: (s, c) => s.statusRoute(c.id) },
      // The token lifecycle: mint, rotate, revoke. These carry their own auth.
      { method: "POST", path: exact("/tokens"), handler: (s, c) => handleMintToken(c.request, s, { bootstrapSecret: s.bootstrapSecret }) },
      { method: "POST", path: optionalId("/tokens/", "/rotate"), handler: (s, c) => s.rotateTokenRoute(c.request, c.id) },
      { method: "DELETE", path: optionalSingleId("/tokens/"), handler: (s, c) => s.deleteTokenRoute(c.request, c.id) },
    ];
  }

  // The brain's front door: the settings come from the Worker env; a brain
  // that is not configured fails loud (500) instead of dropping every
  // update silently.
  private async telegramRoute(request: Request): Promise<Response> {
    const brain = resolveBrainConfig(
      {
        botToken: this.botToken,
        ownerChatId: this.ownerChatId,
        webhookSecret: this.webhookSecret,
      },
      this.telegramClient(),
    );
    if (!brain) {
      return Response.json({ error: "misconfigured" }, { status: 500 });
    }
    return handleTelegramWebhook(request, this, {
      ...brain,
      dispatch: (cmd) => this.dispatchCommand(cmd, brain.telegram),
    });
  }

  // The boxes' door: the Telegram client is optional — a brain without a
  // token still stores the events and marks the links, and the edits stay
  // owed until the alarm sweep drives them.
  private eventsRoute(request: Request): Promise<Response> {
    return handleEvents(request, this, {
      telegram: this.telegramClient(),
      verifyBox: (id, token) => this.verifyBoxToken(id, token),
    });
  }

  // The box's own heartbeat: the wrong-token and the seq-reset pings.
  private heartbeatRoute(request: Request): Promise<Response> {
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
        if (!shouldPingReenroll(this.reenrollPinged, id, Date.now())) return;
        await notify(reenrollPingText(id));
      },
    );
  }

  // The enrolment request. Trust comes from the caller, not the body: a
  // CLI token with the "enroll" scope means the owner asked for this box in
  // Telegram. Unauthenticated requests may still start an enrollment, but
  // their pending row needs the approve tap.
  private async enrollRoute(request: Request): Promise<Response> {
    const bearer = extractBearer(request);
    const trusted = bearer !== null && (await requireScope(this, bearer, "enroll")) !== null;
    return handleEnrollRequest(request, this, this.notifier(), undefined, {
      ...this.enrollConfig(),
      trusted,
    });
  }

  // The approve tap.
  private enrollApproveRoute(request: Request): Promise<Response> {
    return handleEnrollApprove(request, this, this.enrollConfig(), undefined, this.notifier());
  }

  // The deny tap.
  private enrollDenyRoute(request: Request): Promise<Response> {
    return handleEnrollDeny(request, this, this.enrollConfig());
  }

  // The revoke of one box.
  private revokeRoute(request: Request, rawId: string): Promise<Response> {
    const boxId = this.decodedId(rawId);
    if (boxId === null) {
      return Promise.resolve(badRequest());
    }
    return handleRevoke(boxId, request, this, { sealKey: this.sealKey, box: this.box });
  }

  // The mint of one box's tap code.
  private linkRoute(request: Request, rawId: string): Promise<Response> {
    const boxId = this.decodedId(rawId);
    if (boxId === null) {
      return Promise.resolve(badRequest());
    }
    return handleMintLink(boxId, request.headers.get("idempotency-key"), this, {
      sealKey: this.sealKey,
      box: this.box,
    });
  }

  // The box's presence, relayed: the box's own report, as a document.
  private presenceRoute(rawId: string): Promise<Response> {
    const boxId = this.decodedId(rawId);
    if (boxId === null) {
      return Promise.resolve(badRequest());
    }
    return this.relayRoute(boxId, (id, token) => this.box.presence(id, token), "application/json");
  }

  // The box's status, relayed as text.
  private statusRoute(rawId: string): Promise<Response> {
    const boxId = this.decodedId(rawId);
    if (boxId === null) {
      return Promise.resolve(badRequest());
    }
    return this.relayRoute(boxId, (id, token) => this.box.status(id, token), "text/plain");
  }

  // The rotation of a token.
  private rotateTokenRoute(request: Request, rawId: string): Promise<Response> {
    const id = this.decodedId(rawId);
    if (id === null) {
      return Promise.resolve(badRequest());
    }
    return handleRotateToken(id, request, this);
  }

  // The revocation of a token.
  private deleteTokenRoute(request: Request, rawId: string): Promise<Response> {
    const id = this.decodedId(rawId);
    if (id === null) {
      return Promise.resolve(badRequest());
    }
    return handleDeleteToken(id, request, this);
  }

  // The id a path names, decoded. Null when the path names nothing — the
  // answer for a path with no name in it.
  private decodedId(rawId: string): string | null {
    if (rawId === "") {
      return null;
    }
    return decodeURIComponent(rawId);
  }
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

// The brain's clock: Unix seconds, like the DO's other timestamps.
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// The status each failed relay reason answers with.
const RELAY_FAILURE_STATUS = new Map<BoxSilence, number>([
  ["unknown_box", 404],
  ["misconfigured", 500],
  ["box_timeout", 504],
  ["box_unreachable", 502],
]);

// The status a failed relay answers with: the reason names the answer.
// A reason the table does not know is a bad gateway — the brain cannot
// say more about a relay it does not understand.
function relayFailureStatus(reason: BoxSilence): number {
  return RELAY_FAILURE_STATUS.get(reason) ?? 502;
}

// The reason the tap was not read: the box the tap names, or the reason
// the box did not answer. The owner can act on either — a name they can
// check, a reason they can wait out.
function tapSilence(reason: BoxSilence, boxId: string): string {
  return reason === "unknown_box" ? `unknown box "${boxId}"` : `the box did not answer (${reason})`;
}

// The failed relay, as the owner may read it: the status and a short
// reason. The body of a failed relay is the brain's own answer —
// {"error":"tainted"} — and raw JSON in the owner's chat is noise (and
// an internals leak). The reason code is what the owner can act on.
function relayFailure(prefix: string, status: number, body: string): string {
  const reason = relayReason(body);
  return `${prefix} (${status})${reason ? `: ${reason}` : ""}`;
}

// The reason out of a failed relay's body: the brain's own error code
// ("tainted", "misconfigured"). Anything else is left out — a body that
// is not the brain's own answer carries nothing the owner may read.
function relayReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return "";
    }
    const code = (parsed as Record<string, unknown>)["error"];
    return typeof code === "string" && /^[a-z0-9_-]{1,32}$/.test(code) ? code : "";
  } catch {
    return "";
  }
}
