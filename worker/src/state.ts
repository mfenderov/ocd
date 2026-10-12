export interface BoxRow {
  id: string;
  hostname: string;
  heartbeat_token_hash: string;
  admin_token_hash: string;
  epoch: number;
  last_seq: number;
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
  last_seen INTEGER NOT NULL DEFAULT 0,
  enrolled INTEGER NOT NULL DEFAULT 0
);
`;

export class FleetState implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private ensureSchema(): void {
    this.state.storage.sql.exec(SCHEMA);
  }

  listBackends(): BoxRow[] {
    this.ensureSchema();
    const cursor = this.state.storage.sql.exec(
      "SELECT id, hostname, heartbeat_token_hash, admin_token_hash, epoch, last_seq, last_seen, enrolled FROM boxes ORDER BY id",
    );
    return cursor.toArray() as unknown as BoxRow[];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/backends") {
      return Response.json(this.listBackends());
    }
    return new Response("Not Found", { status: 404 });
  }
}
