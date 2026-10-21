import { unsealAdminToken } from "./enroll";
import { fetchBox, pinnedRegistry } from "./heartbeat";
import { isTainted, type TombstoneRow } from "./mint";
import type { BoxRow } from "./boxes";
import { BOX_API } from "./boxapi";

// Audit merge: console GET /api/audit?box=&n= fans out in parallel to each
// enrolled box's GET /admin/audit?n= over pinned hostnames only. Per-box
// 5s deadline, allSettled semantics: a slow or dead box becomes a
// last-synced error row, never a failed request or a silent gap. Merged
// rows sort by box event time (`at`, seconds) descending; error rows carry
// `at = last_seen` so they slot by last sync. Tombstones are read-only
// here: a tainted box's rows still show, marked `tainted: true` — audit
// never refuses what mint refuses. Admin tokens decrypt only at call time;
// plaintext is never logged.

// Box reads get 5s (audit is a small SQLite scan server-side).
export const AUDIT_DEADLINE_MS = 5_000;

// Box row contract (binding, from Plan 1): snake_case JSON array.
export interface BoxAuditRow {
  at: number;
  actor: string;
  action: string;
  device: string;
  ip: string;
  result: string;
  ua: string;
}

export interface MergedAuditRow extends BoxAuditRow {
  box: string;
  tainted: boolean;
}

// Last-synced marker for a box that could not be read. `at` repeats
// `last_seen` so markers sort with events by time; `error` names the cause.
export interface AuditErrorRow {
  box: string;
  at: number;
  error: "box_timeout" | "box_unreachable" | "box_error" | "misconfigured";
  detail?: string;
  last_seen: number;
  tainted: boolean;
}

export type AuditRow = MergedAuditRow | AuditErrorRow;

export interface AuditStore {
  getBox(id: string): BoxRow | undefined;
  listBoxes(): BoxRow[];
  getTombstone(boxId: string): TombstoneRow | undefined;
}

export interface AuditDeps {
  sealKey?: string;
  fetcher?: typeof fetch;
  deadlineMs?: number;
}

// Box page size mirrors the box contract: default 50, cap 200, garbage 50.
export function parseAuditN(raw: string | null): number {
  if (raw === null) {
    return 50;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return 50;
  }
  return Math.min(n, 200);
}

// Internal per-box failure. Thrown inside the fan-out task, converted to an
// AuditErrorRow by the allSettled driver — never escapes fetchAudits.
export class BoxAuditError extends Error {
  code: AuditErrorRow["error"];
  detail?: string;
  constructor(code: AuditErrorRow["error"], detail?: string) {
    super(detail ?? code);
    this.name = "BoxAuditError";
    this.code = code;
    this.detail = detail;
  }
}

// Thrown by fetchAudits when boxId names no enrolled box. handleAudit maps
// it to 404 unknown_box; direct callers get a loud rejection, never a
// silent [].
export class UnknownBoxError extends Error {
  boxId: string;
  constructor(boxId: string) {
    super(`unknown box "${boxId}"`);
    this.name = "UnknownBoxError";
    this.boxId = boxId;
  }
}

function toMerged(boxId: string, tainted: boolean, raw: unknown): MergedAuditRow {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof r[key] === "string" ? r[key] : "");
  return {
    box: boxId,
    at: typeof r["at"] === "number" && Number.isFinite(r["at"]) ? r["at"] : 0,
    actor: str("actor"),
    action: str("action"),
    device: str("device"),
    ip: str("ip"),
    result: str("result"),
    ua: str("ua"),
    tainted,
  };
}

// The admin token the audit relay carries.
//
// Decrypt only at call time, right before the relay — same rule as
// mint/revoke. A brain that cannot read the token — no seal key, a blob
// it cannot open, no token bound — cannot read the box at all: the box
// becomes a misconfigured marker, never a silent gap.
async function auditAdminToken(sealKey: string | undefined, box: BoxRow): Promise<string> {
  if (!sealKey) {
    throw new BoxAuditError("misconfigured");
  }
  let adminToken: string | null;
  try {
    adminToken = await unsealAdminToken(sealKey, box.admin_token_sealed);
  } catch {
    throw new BoxAuditError("misconfigured");
  }
  if (!adminToken) {
    throw new BoxAuditError("misconfigured");
  }
  return adminToken;
}

// The box's audit page. A box that does not answer is a marker, not a
// failed request: the deadline says whether the box was slow or gone.
async function fetchBoxAudit(
  box: BoxRow,
  n: number,
  adminToken: string,
  signal: AbortSignal,
  deps: AuditDeps,
): Promise<Response> {
  try {
    return await fetchBox(
      pinnedRegistry([box]),
      box.id,
      `${BOX_API.audit}?n=${n}`,
      { headers: { authorization: `Bearer ${adminToken}` }, signal },
      deps.fetcher,
    );
  } catch {
    throw new BoxAuditError(signal.aborted ? "box_timeout" : "box_unreachable");
  }
}

// The rows the box sent. A box that answers with an error, with
// something that is not JSON, or with something that is not a list of
// rows is a marker: the brain never guesses what the box said.
async function boxAuditRows(res: Response): Promise<unknown[]> {
  if (res.status !== 200) {
    throw new BoxAuditError("box_error", `status ${res.status}`);
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new BoxAuditError("box_error", "box_bad_json");
  }
  if (!Array.isArray(raw)) {
    throw new BoxAuditError("box_error", "box_bad_json");
  }
  // The list is a list; what a row holds is unknown until it is read.
  return raw as unknown[];
}

// One box's audit rows. Every failure the box can cause is a marker for
// that box alone: the other boxes' rows still come back.
async function fetchOneBox(
  box: BoxRow,
  n: number,
  tainted: boolean,
  deps: AuditDeps,
): Promise<MergedAuditRow[]> {
  const adminToken = await auditAdminToken(deps.sealKey, box);
  const signal = AbortSignal.timeout(deps.deadlineMs ?? AUDIT_DEADLINE_MS);
  const res = await fetchBoxAudit(box, n, adminToken, signal, deps);
  const raw = await boxAuditRows(res);
  return raw.map((row) => toMerged(box.id, tainted, row));
}

function byEventTimeDesc(a: AuditRow, b: AuditRow): number {
  if (b.at !== a.at) {
    return b.at - a.at;
  }
  return a.box < b.box ? -1 : a.box > b.box ? 1 : 0;
}

// Parallel fan-out over enrolled boxes (or one box when boxId is set).
// Per-box transport failures become markers, but unknown boxId throws
// UnknownBoxError and programmer errors propagate — neither is a silent gap
// nor a masked marker. `n` bounds event volume; markers are control plane
// and are never paginated away (dropping one would be the silent gap this
// exists to avoid).
export async function fetchAudits(
  store: AuditStore,
  opts: { boxId?: string; n: number },
  deps: AuditDeps = {},
): Promise<AuditRow[]> {
  const n = Number.isInteger(opts.n) && opts.n > 0 ? Math.min(opts.n, 200) : 50;
  if (opts.boxId) {
    const box = store.getBox(opts.boxId);
    if (!box || box.enrolled !== 1) {
      throw new UnknownBoxError(opts.boxId);
    }
  }
  const targets = store.listBoxes().filter((b) => b.enrolled === 1 && (!opts.boxId || b.id === opts.boxId));
  const taintedBy = new Map(targets.map((box) => [box.id, isTainted(box.epoch, store.getTombstone(box.id))]));
  const settled = await Promise.allSettled(
    targets.map((box) => fetchOneBox(box, n, taintedBy.get(box.id) ?? false, deps)),
  );
  const events: MergedAuditRow[] = [];
  const markers: AuditErrorRow[] = [];
  settled.forEach((result, i) => {
    const box = targets[i];
    const tainted = taintedBy.get(box.id) ?? false;
    if (result.status === "fulfilled") {
      events.push(...result.value);
    } else if (result.reason instanceof BoxAuditError) {
      markers.push({
        box: box.id,
        at: box.last_seen,
        error: result.reason.code,
        ...(result.reason.detail ? { detail: result.reason.detail } : {}),
        last_seen: box.last_seen,
        tainted,
      });
    } else {
      // Not a box failure — a bug (broken fetcher contract, bad row mapping).
      // Masking it as box_unreachable would lie to the operator; let it fail loud.
      throw result.reason;
    }
  });
  events.sort(byEventTimeDesc);
  return [...events.slice(0, n), ...markers].sort(byEventTimeDesc);
}

export async function handleAudit(
  request: Request,
  store: AuditStore,
  deps: AuditDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  const boxId = url.searchParams.get("box") || undefined;
  try {
    return Response.json({
      rows: await fetchAudits(store, { boxId, n: parseAuditN(url.searchParams.get("n")) }, deps),
    });
  } catch (err) {
    if (err instanceof UnknownBoxError) {
      return Response.json({ error: "unknown_box" }, { status: 404 });
    }
    throw err;
  }
}
