// The box: what the brain asks of the boxes it owns.
//
// Five operations, said in the brain's own words: mint a link on this
// box, ask this box for its audit rows, revoke this box, this box's
// status, is this box there. The adapter that provides them is wired
// in from the outside (state.ts), and the domain never imports it.
//
// The paths, the bearer, the idempotency key and the query strings are
// the adapter's business: they are how the brain says it, not what it
// says. A port that could name a path could call anything.
//
// The ports live in the domain because the domain names them.

// Why the box did not answer. These are the brain's own codes: the
// console and the owner's chat read them, and they never change
// meaning.
export type BoxSilence =
  // The brain does not know this box, or it is not enrolled.
  | "unknown_box"
  // The brain cannot read the box's admin token.
  | "misconfigured"
  // The box did not answer in time.
  | "box_timeout"
  // The box could not be reached at all.
  | "box_unreachable";

// The box's answer: the status it answered with and what it said.
//
// The console shows both: the operator must read the box's own verdict
// (the box knows better than the brain what went wrong), not the
// brain's paraphrase of it. The status is the one number that crosses
// the port — there is no path, no header and no query string here.
export interface BoxMessage {
  readonly status: number;
  readonly said: string;
}

// The box answered, or it did not.
export type BoxReply =
  | { kind: "answered"; message: BoxMessage }
  | { kind: "silent"; reason: BoxSilence };

// What the box said when the brain asked it for a link.
export type MintAnswer =
  // The link the box minted.
  | { kind: "minted"; link: string }
  // The box answered, and refused.
  | { kind: "refused"; message: BoxMessage }
  // The box did not answer.
  | { kind: "silent"; reason: BoxSilence };

// What the box said when the brain asked it for its audit rows.
export type AuditAnswer =
  // The box's rows, in the box's own shape: the brain reads them into
  // its own rows.
  | { kind: "rows"; rows: unknown[] }
  // The box answered, and the brain cannot read what it said.
  | { kind: "unreadable"; reason: string }
  // The box did not answer.
  | { kind: "silent"; reason: BoxSilence };

// What the box said when the brain asked it to revoke.
export type RevokeAnswer =
  // The box rotated: this is its new epoch.
  | { kind: "revoked"; epoch: number }
  // The box said it revoked, and named no epoch.
  | { kind: "claimed" }
  // The box answered, and refused.
  | { kind: "refused"; message: BoxMessage }
  // The box did not answer.
  | { kind: "silent"; reason: BoxSilence };

// The box: the port the brain asks a box through.
//
// The admin token is the brain's own data: the brain seals it at
// enrolment and unseals it at call time, right before the call. The
// adapter only carries it.
export interface Box {
  // Mint a link on this box. The key is the console's own: one per
  // console request, so a retry never mints twice.
  mintLink(boxId: string, adminToken: string, consoleKey: string | null): Promise<MintAnswer>;
  // Read the pairing URL out of a tap's own answer: the box 302s to it
  // and prints it, and the brain reads the printed body without
  // following the redirect. No admin token rides along: the tap is the
  // credential, and the box's /pair endpoint answers it on its own.
  resolvePair(boxId: string, tapUrl: string): Promise<BoxReply>;
  // This box's audit rows: at most n of them.
  auditRows(boxId: string, adminToken: string, n: number): Promise<AuditAnswer>;
  // Revoke this box: its credentials rotate.
  revoke(boxId: string, adminToken: string): Promise<RevokeAnswer>;
  // This box's status, as the box says it.
  status(boxId: string, adminToken: string): Promise<BoxReply>;
  // Is this box there?
  presence(boxId: string, adminToken: string): Promise<BoxReply>;
}
