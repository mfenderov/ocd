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
`;

const COLUMNS =
  "id, hostname, heartbeat_token_hash, admin_token_hash, epoch, last_seq, last_ts, last_seen, enrolled";

export class FleetState implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/backends") {
      return Response.json(this.listBackends());
    }
    if (request.method === "POST" && url.pathname === "/heartbeat") {
      return handleHeartbeat(request, this);
    }
    return new Response("Not Found", { status: 404 });
  }
}
