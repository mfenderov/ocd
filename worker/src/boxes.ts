// The shapes the brain and its Durable Object both speak: the box's row
// in the brain's table, the box as the console sees it, and the marker a
// refused enrolment leaves.
//
// They live here, not in the Durable Object, because the domain speaks
// them too: the audit relay, the enrolment, the heartbeat and the bot's
// command layer must not depend on the application's layer to name a
// box. The Durable Object imports them; so does the domain; nothing
// imports the Durable Object for a type any more.

export interface BoxRow {
  id: string;
  hostname: string;
  heartbeat_token_hash: string;
  admin_token_hash: string;
  admin_token_sealed: string;
  // tunnel_id is the box's cloudflared tunnel id, empty when the box has
  // no tunnel. Phase 2 creates the box's DNS records from it.
  tunnel_id: string;
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
