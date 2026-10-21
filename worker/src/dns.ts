// The brain's DNS writer.
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
//     zone that is not ours, a network failure). The message names the
//     status and the API's error code, never the credential.
const CF_API = "https://api.cloudflare.com/client/v4";

// The two hostnames the brain owns for one box, and where they point.
export interface BoxDns {
  tapHost: string;    // oc-tap-<box>.buyallmemes.com
  uiHost: string;     // oc-<box>.buyallmemes.com
  target: string;     // <tunnel-id>.cfargotunnel.com
}

// What the ensure did. The names are the record names, so the caller can
// say which of the two moved.
export type DnsOutcome =
  | { ok: true; created: string[]; updated: string[] }
  | { ok: false; reason: string };

// One DNS record as the API reports it. Only the fields the writer needs.
interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

// The API's envelope. The result shape differs per call, so it stays
// untyped here and each caller reads what it expects.
interface CfEnvelope {
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
  // No tunnel id means no target: a record that points nowhere is worse
  // than no record at all, so the brain refuses instead of writing one.
  if (!box.target) {
    return {
      ok: false,
      reason: "no tunnel target recorded for the box — nothing to point at",
    };
  }
  const fetcher = deps.fetcher ?? fetch;
  const headers = {
    authorization: `Bearer ${deps.token}`,
    "content-type": "application/json",
  };
  const records = await listRecords(fetcher, headers, deps.zoneId);
  const created: string[] = [];
  const updated: string[] = [];
  for (const host of [box.tapHost, box.uiHost]) {
    const record = {
      type: "CNAME",
      name: host,
      content: box.target,
      ttl: 1, // automatic
      proxied: true,
    };
    const existing = records.find((r) => r.name === host && r.type === "CNAME");
    if (!existing) {
      await cfRequest(
        fetcher,
        `${CF_API}/zones/${deps.zoneId}/dns_records`,
        "POST",
        headers,
        record,
      );
      created.push(host);
      continue;
    }
    if (pointsWhereWeWant(existing, box.target)) {
      continue;
    }
    await cfRequest(
      fetcher,
      `${CF_API}/zones/${deps.zoneId}/dns_records/${existing.id}`,
      "PATCH",
      headers,
      record,
    );
    updated.push(host);
  }
  return { ok: true, created, updated };
}

// A record that already points at the target is left alone. One that says
// it is not proxied is fixed: the brain's records are proxied, so a
// grey-cloud CNAME would answer from the origin, not from the edge.
function pointsWhereWeWant(record: DnsRecord, target: string): boolean {
  return record.content === target && record.proxied !== false;
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
    if (Array.isArray(doc.result)) {
      records.push(...(doc.result as DnsRecord[]));
    }
    const total = doc.result_info?.total_pages;
    if (total === undefined || total <= page) {
      return records;
    }
  }
}

// One API call. A non-2xx becomes an error that names the status and the
// API's error code (9109 = the credential may not touch this zone). The
// API's free text is not echoed: the code is the stable, documented part
// of the answer, and the free text can talk about the credential — which
// must never reach a log.
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
    const code = doc?.errors?.[0]?.code;
    const where = code === undefined
      ? `dns: cloudflare api ${res.status}`
      : `dns: cloudflare api ${res.status} (code ${code})`;
    throw new Error(where);
  }
  return doc ?? {};
}

// The API's envelope, or null when the answer is not JSON.
async function readEnvelope(res: Response): Promise<CfEnvelope | null> {
  try {
    const value: unknown = await res.json();
    if (typeof value !== "object" || value === null) {
      return null;
    }
    return value as CfEnvelope;
  } catch {
    return null;
  }
}
