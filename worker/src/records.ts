// The DNS records the brain owns: the two names of one box, and where
// they point.
//
// The writer is the port the enrolment asks: "point these two names at
// this tunnel". The adapter (dns.ts) speaks Cloudflare's API; the
// enrolment only says which names point where.

// The two hostnames the brain owns for one box, and where they point.
export interface BoxDns {
  tapHost: string;    // oc-tap-<box>.buyallmemes.com
  uiHost: string;     // oc-<box>.buyallmemes.com
  target: string;     // <tunnel-id>.cfargotunnel.com
}

// What the write did. The names are the record names, so the caller can
// say which of the two moved.
export type DnsOutcome =
  | { ok: true; created: string[]; updated: string[] }
  | { ok: false; reason: string };

// The writer itself. It answers what it did; a refusal throws, and the
// caller names the failure.
export type DnsWriter = (box: BoxDns) => Promise<DnsOutcome>;
