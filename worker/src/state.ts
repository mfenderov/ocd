import {
  handleEnrollApprove,
  handleEnrollDeny,
  handleEnrollRequest,
  mismatchAlertText,
  telegramNotifier,
  type NotifyFn,
  type PendingRow,
} from "./enroll";
import { handleHeartbeat } from "./heartbeat";

export interface BoxRow {
  id: string;
  hostname: string;
  heartbeat_token_hash: string;
  admin_token_hash: string;
  epoch: number;
  last_seq: number;
  last_ts: number;
  last_seen: number;
  enrolled: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boxes(
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  heartbeat_token_hash TEXT NOT NULL,
  admin_token_hash TEXT NOT NULL,
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
  first_seen INTEGER NOT NULL DEFAULT 0
);
`;

const COLUMNS =
  "id, hostname, heartbeat_token_hash, admin_token_hash, epoch, last_seq, last_ts, last_seen, enrolled";

const PENDING_COLUMNS = "id, hostname, heartbeat_token_hash, first_seen";

// Subset of Worker env the DO reads: Telegram secrets for enrollment pings.
// workerd passes env as the second constructor arg; missing values degrade
// to a loud no-op notifier, never a silent skip.
interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OWNER_CHAT_ID?: string;
}

export class FleetState implements DurableObject {
  private state: DurableObjectState;
  private botToken?: string;
  private ownerChatId?: string;

  constructor(state: DurableObjectState, env?: TelegramEnv) {
    this.state = state;
    this.botToken = env?.TELEGRAM_BOT_TOKEN;
    this.ownerChatId = env?.TELEGRAM_OWNER_CHAT_ID;
  }

  private notifier(): NotifyFn {
    return telegramNotifier(this.botToken, this.ownerChatId);
  }

  private ensureSchema(): void {
    this.state.storage.sql.exec(SCHEMA);
    const cols = this.state.storage.sql.exec("PRAGMA table_info(boxes)").toArray() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "last_ts")) {
      this.state.storage.sql.exec("ALTER TABLE boxes ADD COLUMN last_ts INTEGER NOT NULL DEFAULT 0");
    }
  }

  listBackends(): BoxRow[] {
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
      "INSERT OR REPLACE INTO boxes (id, hostname, heartbeat_token_hash, admin_token_hash, epoch, last_seq, last_ts, last_seen, enrolled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      box.id,
      box.hostname,
      box.heartbeat_token_hash,
      box.admin_token_hash,
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
      "INSERT OR REPLACE INTO pending (id, hostname, heartbeat_token_hash, first_seen) VALUES (?, ?, ?, ?)",
      row.id,
      row.hostname,
      row.heartbeat_token_hash,
      row.first_seen,
    );
  }

  deletePending(id: string): void {
    this.ensureSchema();
    this.state.storage.sql.exec("DELETE FROM pending WHERE id = ?", id);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/backends") {
      return Response.json(this.listBackends());
    }
    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const notify = this.notifier();
      return handleHeartbeat(request, this, undefined, async (id: string) => {
        await notify(mismatchAlertText(id));
      });
    }
    if (request.method === "POST" && url.pathname === "/enroll") {
      return handleEnrollRequest(request, this, this.notifier());
    }
    if (request.method === "POST" && url.pathname === "/enroll/approve") {
      return handleEnrollApprove(request, this);
    }
    if (request.method === "POST" && url.pathname === "/enroll/deny") {
      return handleEnrollDeny(request, this);
    }
    return new Response("Not Found", { status: 404 });
  }
}
