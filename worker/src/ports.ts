// The ports: what the brain needs from the outside world, said in the
// brain's own words.
//
// A port is a need, not an implementation. The domain says what it
// needs — "tell the owner this", "point these two names at this
// tunnel", "ask this box for its status" — and the adapter that
// provides it is wired in from the outside (state.ts). Nothing in the
// domain imports an adapter: the arrows point inward, always.
//
// The ports live here, in the domain, because the domain names them.
// The adapters import this module; the domain never imports them.

// The notifier: "tell the owner this".
//
// The enrolment's pings, the heartbeat's warnings and the DNS failure
// report all go through it. The contract: it never throws, and it
// never logs a secret.
export type NotifyFn = (text: string) => Promise<void>;

// The message client: the owner's chat.
//
// The three operations the brain's own messages need: send a message,
// edit a message the brain sent before, answer a tap. The rest of the
// Bot API is not the brain's business.
export interface TelegramClient {
  sendMessage(chatId: number, text: string, opts?: { replyMarkup?: unknown }): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<boolean>;
  answerCallbackQuery(callbackId: string, text?: string): Promise<void>;
}

// The failure a message carries: the reason, in the words the operator
// needs — never the response body, never the token. The adapter names
// the method and the detail it saw; the domain reads the reason.
export interface MessageFailure extends Error {
  readonly reason: string;
}

// The reason a failed message carries, or "unknown error" when the
// failure carries none.
export function messageFailureReason(err: unknown): string {
  if (err instanceof Error && "reason" in err && typeof err.reason === "string") {
    return err.reason;
  }
  return "unknown error";
}

// The DNS writer: "point these two names at this tunnel".
//
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

// The box relay: "ask this box for this".
//
// The endpoints are the protocol the brain speaks with a box. The
// paths are the brain's own vocabulary — its audit page, its presence,
// its status — so the table belongs with the port, and the adapter
// speaks it.
//
// The prefix avoids "/admin" on purpose: Cloudflare's managed WAF rules
// challenge any path containing that segment (a WordPress-admin
// heuristic), and the challenge page answers instead of the box — which
// broke every worker→box relay. A path the edge does not second-guess
// keeps the relay working; the endpoints stay bearer-gated either way.
export const BOX_API = {
  mint: "/_oc/mint",
  revoke: "/_oc/revoke",
  audit: "/_oc/audit",
  presence: "/_oc/presence",
  status: "/_oc/status",
} as const;

// Why a relay never reached the box.
export type RelayFailure =
  | "unknown_box"
  | "misconfigured"
  | "box_timeout"
  | "box_unreachable";

// The outcome of one relay: the box answered (with a status and a
// body), or it did not (and why not).
export type BoxRelay =
  | { answered: true; status: number; body: string; contentType: string }
  | { answered: false; reason: RelayFailure };

// The relay the brain asks a box through: the box's id and the
// endpoint. It answers what the box said — or why it did not answer.
export type BoxRelayer = (boxId: string, path: string) => Promise<BoxRelay>;
