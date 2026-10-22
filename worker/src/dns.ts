// The brain's DNS writer: the adapter behind the DNS port.
//
// After a box enrols, the brain owns the two CNAMEs that send the box's
// tap host and its UI host to the box's tunnel:
//
//   oc-tap-<box>.<zone>  CNAME  <tunnel-id>.cfargotunnel.com
//   oc-<box>.<zone>      CNAME  <tunnel-id>.cfargotunnel.com
//
// Both are proxied, so Cloudflare's edge answers for them and the tunnel's
// own address is never published.
//
// The writer is idempotent: it lists the zone once, creates what is
// missing, moves what points elsewhere and leaves what already points at
// the target alone. A box that re-enrols with a new tunnel id gets its
// records moved, not duplicated.
//
// The credential is zone-scoped to DNS edit on one zone. The caller reads
// it from the Worker's env and passes it in: this module never reads the
// env, never logs the credential and never puts it in an error message.
//
// Two ways to fail, and the caller needs both:
//   - { ok: false, reason } — the brain refuses to write (the box has no
//     tunnel to point at). Nothing broke; there is simply nothing to do.
//   - a thrown Error — the API refused us (403 without the DNS scope, a
//     zone that is not ours, a listing we could not read) or the brain
//     was handed a box it cannot write for (no tap host). The message
//     names the status, the API's error code and what that code means
//     here, never the credential.
// The caller must catch: a throw is a DNS failure, never a failed enrol.
import type { BoxDns, DnsOutcome, DnsWriter } from "./ports";

const CF_API = "https://api.cloudflare.com/client/v4";

// The DNS call gets 5s, like the audit's outbound call. The box waits
// 15s for its enrolment answer, so a slow API must fail long before
// that — and the owner's approve tap must not hang either.
const DNS_DEADLINE_MS = 5_000;

// What the writer needs: the zone the brain owns and the credential
// that writes it. The fetcher rides in so a test can answer instead of
// Cloudflare — the suite never talks to the network.
export interface DnsWriterDeps {
  zoneId: string;
  token: string;
  fetcher?: typeof fetch;
  // deadlineMs bounds one DNS step (the listing and the writes share
  // it). Unset = DNS_DEADLINE_MS.
  deadlineMs?: number;
}

// What Cloudflare's error codes mean, in the words the operator needs. A
// code alone is a lookup, and the API's own free text is not echoed: it
// can talk about the credential, which must never reach a log.
const API_ERROR_MEANINGS: Record<number, string | undefined> = {
  7003: "the zone id does not resolve to a zone",
  81057: "a record with that name already exists",
  9109: "this credential may not write the zone's DNS",
  10000: "the credential was refused",
};

// One DNS record as the API reports it. Only the fields the writer needs.
interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

// The CNAME the brain writes. Always the same shape: proxied, with an
// automatic TTL.
interface DnsWrite {
  type: "CNAME";
  name: string;
  content: string;
  ttl: 1;
  proxied: true;
}

// The API's envelope. The result shape differs per call, so it stays
// untyped here and each caller reads what it expects.
interface CfEnvelope {
  success?: boolean;
  result?: unknown;
  result_info?: { total_pages?: number };
  errors?: Array<{ code?: number }>;
}

// Ensure the box's two CNAMEs: create what is missing, move what points
// elsewhere, leave what already points at the target alone.
export async function ensureBoxDns(
  deps: { fetcher?: typeof fetch; zoneId: string; token: string },
  box: BoxDns,
): Promise<DnsOutcome> {
  // The tap host is the brain's address for the box's tap. Without it
  // there is nothing to write, and that is a brain bug, not a box to fix:
  // it fails loudly instead of leaving the box without DNS. The box's own
  // onboarding says the same about its tap host (internal/onboard/tunnel.go).
  const tapHost = box.tapHost.trim();
  const uiHost = box.uiHost.trim();
  const target = box.target.trim();
  if (!tapHost) {
    throw new Error("dns: the box has no tap host (a brain bug, not a box to fix)");
  }
  // No tunnel id means no target: a record that points nowhere is worse
  // than no record at all, so the brain refuses instead of writing one.
  if (!target) {
    return {
      ok: false,
      reason: "no tunnel target recorded for the box — nothing to point at",
    };
  }
  // The UI host is optional: the box's own onboarding skips it when the
  // box has no UI (internal/onboard/tunnel.go). The same name twice is
  // one record, not two: the listing is read once, so writing it twice
  // would make the api answer "record already exists" for the second one.
  const hosts: string[] = [tapHost];
  if (uiHost && uiHost !== tapHost) {
    hosts.push(uiHost);
  }
  const fetcher = deps.fetcher ?? fetch;
  const headers = {
    authorization: `Bearer ${deps.token}`,
    "content-type": "application/json",
  };
  const records = await listRecords(fetcher, headers, deps.zoneId);
  const created: string[] = [];
  const updated: string[] = [];
  for (const host of hosts) {
    const record: DnsWrite = {
      type: "CNAME",
      name: host,
      content: target,
      ttl: 1, // automatic
      proxied: true,
    };
    const existing = records.find((r) => r.name === host && r.type === "CNAME");
    if (!existing) {
      await writeRecord(
        fetcher,
        headers,
        `${CF_API}/zones/${deps.zoneId}/dns_records`,
        "POST",
        record,
      );
      created.push(host);
      continue;
    }
    if (pointsWhereWeWant(existing, target)) {
      continue;
    }
    await writeRecord(
      fetcher,
      headers,
      `${CF_API}/zones/${deps.zoneId}/dns_records/${existing.id}`,
      "PATCH",
      record,
    );
    updated.push(host);
  }
  return { ok: true, created, updated };
}

// A record that already points at the target is left alone — unless it
// says it is not proxied: the brain's records are proxied, so a
// grey-cloud CNAME would answer from the origin, not from the edge.
function pointsWhereWeWant(record: DnsRecord, target: string): boolean {
  if (record.proxied === false) {
    return false;
  }
  return record.content === target;
}

// One CNAME write. The envelope must say the write happened: a 200 that
// refuses, and a body we cannot read, both mean the record may not be
// there, and the brain must not count it as written.
async function writeRecord(
  fetcher: typeof fetch,
  headers: Record<string, string>,
  url: string,
  method: "POST" | "PATCH",
  record: DnsWrite,
): Promise<void> {
  const doc = await cfRequest(fetcher, url, method, headers, record);
  if (doc.success !== true) {
    throw apiError("cloudflare api refused the write", doc.errors?.[0]?.code);
  }
}

// The zone's records, one listing. The API's default page size is 20, so a
// zone with more records than that needs its next pages — a record missed
// here would be created a second time.
async function listRecords(
  fetcher: typeof fetch,
  headers: Record<string, string>,
  zoneId: string,
): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  for (let page = 1; ; page++) {
    const query = page > 1 ? `?page=${page}` : "";
    const doc = await cfRequest(
      fetcher,
      `${CF_API}/zones/${zoneId}/dns_records${query}`,
      "GET",
      headers,
    );
    // A listing we cannot read is not an empty zone. Carrying on would
    // create records that already exist.
    if (doc.success === false || !Array.isArray(doc.result)) {
      throw apiError(
        "cloudflare api could not list the zone's records",
        doc.errors?.[0]?.code,
      );
    }
    records.push(...(doc.result as DnsRecord[]));
    const total = doc.result_info?.total_pages;
    if (total === undefined || total <= page) {
      return records;
    }
  }
}

// The writer the domain gets: the DNS port, spoken by this adapter.
//
// The wiring (state.ts) builds it from the Worker's credential and hands
// it to the enrolment. Each call gets its own deadline: the listing and
// the writes of one write share a signal, and the next write gets a
// fresh one.
export function boxDnsWriter(deps: DnsWriterDeps): DnsWriter {
  return async (box: BoxDns): Promise<DnsOutcome> => {
    const fetcher = withDeadline(deps.fetcher ?? fetch, deps.deadlineMs ?? DNS_DEADLINE_MS);
    return ensureBoxDns({ fetcher, zoneId: deps.zoneId, token: deps.token }, box);
  };
}

// The fetcher with a deadline. The seam stays where it was: the writer
// takes a fetcher, and the caller decides how long it may take. One
// signal for the whole step (the listing and the writes share it), and
// an aborted call says so in the operator's words.
function withDeadline(fetcher: typeof fetch, deadlineMs: number): typeof fetch {
  const signal = AbortSignal.timeout(deadlineMs);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      return await fetcher(input, { ...init, signal });
    } catch (err) {
      if (signal.aborted) {
        throw new Error(`the cloudflare api did not answer within ${deadlineMs}ms`, { cause: err });
      }
      throw err;
    }
  };
}

// One API call. A non-2xx is an error; the envelope's own success flag is
// the caller's business, because a listing and a write mean different
// things when they fail.
async function cfRequest(
  fetcher: typeof fetch,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<CfEnvelope> {
  const res = await fetcher(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const doc = await readEnvelope(res);
  if (!res.ok) {
    throw apiError(`cloudflare api ${res.status}`, doc?.errors?.[0]?.code);
  }
  return doc ?? {};
}

// The error an API refusal becomes: the status, the API's error code and
// what that code means here. Never the credential.
function apiError(head: string, code: number | undefined): Error {
  const codePart = code === undefined ? "" : ` (code ${code})`;
  const meaning = code === undefined ? undefined : API_ERROR_MEANINGS[code];
  const meaningPart = meaning === undefined ? "" : `: ${meaning}`;
  return new Error(`dns: ${head}${codePart}${meaningPart}`);
}

// The API's envelope, or null when the answer is not JSON.
async function readEnvelope(res: Response): Promise<CfEnvelope | null> {
  try {
    const value: unknown = await res.json();
    if (typeof value !== "object" || value === null) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
