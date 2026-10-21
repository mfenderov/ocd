import { env, runInDurableObject, SELF } from "cloudflare:test";
import type { FleetState } from "../src/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveEnrollment,
  capBinding,
  denyEnrollment,
  handleEnrollApprove,
  handleEnrollDeny,
  handleEnrollRequest,
  isPinnedHostname,
  enrollPingText,
  issueCapabilityLink,
  mismatchAlertText,
  parseEnrollBody,
  parseHostSuffixes,
  requestEnrollment,
  sealAdminToken,
  rotationPingText,
  sendTelegramMessage,
  unsealAdminToken,
  verifyCapability,
  type CapabilityBinding,
  type EnrollConfig,
  type EnrollStore,
  type NotifyFn,
  type PendingRow,
} from "../src/enroll";
import { handleHeartbeat, hashToken, tokenMatches } from "../src/heartbeat";
import app from "../src/index";
import type { BoxRow, DenialRow } from "../src/state";

const NEW_TOKEN = "enroll-brand-new-token-1";
const KNOWN_TOKEN = "enroll-known-token-1";
const CLONE_TOKEN = "enroll-clone-token-xyz-9";
const ADMIN_TOKEN = "enroll-admin-token-1";
// The brain has no Cloudflare credential in these tests, so every
// enrolment reports the DNS it could not write. The DNS-owning paths
// have their own describe block below.
const NO_DNS = "failed: the brain has no DNS credential";

class MemStore implements EnrollStore {
  boxes = new Map<string, BoxRow>();
  pending = new Map<string, PendingRow>();
  denials = new Map<string, DenialRow>();
  getBox(id: string): BoxRow | undefined {
    return this.boxes.get(id);
  }
  putBox(box: BoxRow): void {
    this.boxes.set(box.id, { ...box });
  }
  getPending(id: string): PendingRow | undefined {
    return this.pending.get(id);
  }
  putPending(row: PendingRow): void {
    this.pending.set(row.id, { ...row, trusted: row.trusted ?? 0 });
  }
  deletePending(id: string): void {
    this.pending.delete(id);
  }
  getDenial(id: string): DenialRow | undefined {
    return this.denials.get(id);
  }
  putDenial(row: DenialRow): void {
    this.denials.set(row.id, { ...row });
  }
}

function recorder(): { texts: string[]; notify: NotifyFn } {
  const texts: string[] = [];
  const notify: NotifyFn = async (text: string) => {
    texts.push(text);
  };
  return { texts, notify };
}

// The enrol response, as the box reads it.
interface EnrolResponse {
  status: string;
  enrolled: boolean;
  dns: string;
}

async function seedEnrolled(store: MemStore, id: string): Promise<BoxRow> {
  const box: BoxRow = {
    id,
    hostname: `${id}.buyallmemes.com`,
    heartbeat_token_hash: await hashToken(KNOWN_TOKEN),
    admin_token_hash: await hashToken(ADMIN_TOKEN),
    admin_token_sealed: "",
    tunnel_id: "",
    epoch: 3,
    last_seq: 11,
    last_ts: 5000,
    last_seen: 1700000000,
    enrolled: 1,
  };
  store.putBox(box);
  return box;
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://fleet.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function heartbeatRequest(id: string, seq: number, boxNow: number, token: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return new Request("https://fleet.local/api/heartbeat", {
    method: "POST",
    headers,
    body: JSON.stringify({ id, seq, box_now: boxNow, epoch: 1 }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enrollment approve-on-sight (unit)", () => {
  it("parks a new id as pending and queues exactly one ping", async () => {
    const store = new MemStore();
    const rec = recorder();
    const result = await requestEnrollment(
      store,
      { id: "nb-1", hostname: "nb-1.buyallmemes.com", enroll_token: NEW_TOKEN },
      rec.notify,
      () => 1700000100,
      { capSecret: "test-cap-secret", sealKey: "test-seal-key" },
    );
    expect(result).toEqual({ status: "pending", id: "nb-1", rotated: false, trusted: false });
    const row = store.getPending("nb-1");
    expect(row).toMatchObject({ id: "nb-1", hostname: "nb-1.buyallmemes.com", first_seen: 1700000100 });
    expect(row?.heartbeat_token_hash).toBe(await hashToken(NEW_TOKEN));
    expect(row?.heartbeat_token_hash).not.toContain(NEW_TOKEN);
    expect(rec.texts).toHaveLength(1);
    expect(rec.texts[0]).toContain("nb-1");
    expect(rec.texts[0]).toContain("nb-1.buyallmemes.com");
    expect(rec.texts[0]).toContain("/api/enroll/approve");
    expect(rec.texts[0]).toContain("/api/enroll/deny");
    expect(rec.texts[0]).not.toContain(NEW_TOKEN);
  });

  it("leaves an already-bound id alone: no pending row, no enrolment ping", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "bound-1");
    const rec = recorder();
    const result = await requestEnrollment(
      store,
      { id: "bound-1", hostname: "bound-1.buyallmemes.com", enroll_token: KNOWN_TOKEN },
      rec.notify,
    );
    expect(result).toEqual({ status: "enrolled", id: "bound-1", rotated: false, trusted: true, dns: NO_DNS });
    expect(store.getPending("bound-1")).toBeUndefined();
    // The one message is the DNS report, not an enrolment ping: this
    // brain has no DNS credential, so the enrolment ends with a DNS it
    // could not write, and the owner must hear about it.
    expect(rec.texts).toHaveLength(1);
    expect(rec.texts[0]).toContain("bound-1");
    expect(rec.texts[0]).not.toContain("/api/enroll/approve");
  });

  it("parks a known id presenting a new token (cloned-env case) as pending + ping", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "clone-1");
    const rec = recorder();
    const result = await requestEnrollment(
      store,
      { id: "clone-1", hostname: "clone-1.buyallmemes.com", enroll_token: CLONE_TOKEN },
      rec.notify,
      undefined,
      { capSecret: "test-cap-secret", sealKey: "test-seal-key" },
    );
    expect(result).toEqual({ status: "pending", id: "clone-1", rotated: false, trusted: false });
    expect(store.getPending("clone-1")?.heartbeat_token_hash).toBe(await hashToken(CLONE_TOKEN));
    expect(rec.texts).toHaveLength(1);
    expect(rec.texts[0]).not.toContain(CLONE_TOKEN);
  });

  it("approve binds a new id permanently: heartbeat accepted, ping carries links", async () => {
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "fresh-1", hostname: "fresh-1.buyallmemes.com", enroll_token: NEW_TOKEN },
      rec.notify,
      undefined,
      { capSecret: "test-cap-secret", sealKey: "test-seal-key" },
    );
    const row = await approveEnrollment(store, "fresh-1");
    expect(row).toMatchObject({ id: "fresh-1", hostname: "fresh-1.buyallmemes.com", enrolled: 1 });
    expect(await tokenMatches(NEW_TOKEN, row?.heartbeat_token_hash ?? "")).toBe(true);
    expect(store.getPending("fresh-1")).toBeUndefined();
    expect(rec.texts[0]).toContain("/api/enroll/approve?id=fresh-1&exp=");
    expect(rec.texts[0]).toContain("/api/enroll/deny?id=fresh-1&exp=");
    const hb = await handleHeartbeat(heartbeatRequest("fresh-1", 1, 100, NEW_TOKEN), store, () => 1700000200);
    expect(hb.status).toBe(200);
    expect(await hb.json()).toMatchObject({ id: "fresh-1", enrolled: true });
  });

  it("approve resets the seq counter so a DB-lossed box recovers", async () => {
    const store = new MemStore();
    const box = await seedEnrolled(store, "seqreset-1");
    expect(box.last_seq).toBe(11);
    store.putPending({
      id: "seqreset-1",
      hostname: "seqreset-1.buyallmemes.com",
      heartbeat_token_hash: await hashToken(NEW_TOKEN),
      admin_token_sealed: "",
      tunnel_id: "",
      first_seen: FIXED_NOW,
      trusted: 0,
    });
    const row = await approveEnrollment(store, "seqreset-1");
    expect(row?.last_seq).toBe(0);
    expect(row?.last_ts).toBe(0);
    // And the next beat with a low seq is accepted again.
    const hb = await handleHeartbeat(heartbeatRequest("seqreset-1", 1, 6000, NEW_TOKEN), store, () => 1700000200);
    expect(hb.status).toBe(200);
  });

  it("approve on a known id swaps the heartbeat binding, keeps admin hash, resets seq", async () => {
    const store = new MemStore();
    const before = await seedEnrolled(store, "rotate-1");
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "rotate-1", hostname: "rotate-1.buyallmemes.com", enroll_token: CLONE_TOKEN },
      rec.notify,
      undefined,
      { capSecret: "test-cap-secret", sealKey: "test-seal-key" },
    );
    const row = await approveEnrollment(store, "rotate-1");
    expect(await tokenMatches(CLONE_TOKEN, row?.heartbeat_token_hash ?? "")).toBe(true);
    expect(await tokenMatches(KNOWN_TOKEN, row?.heartbeat_token_hash ?? "")).toBe(false);
    expect(row?.admin_token_hash).toBe(before.admin_token_hash);
    expect(row).toMatchObject({ last_seq: 0, last_ts: 0, last_seen: 1700000000, enrolled: 1 });
    const stale = await handleHeartbeat(heartbeatRequest("rotate-1", 12, 6000, KNOWN_TOKEN), store);
    expect(stale.status).toBe(401);
  });

  it("deny drops the pending row; re-deny and late approve miss", async () => {
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "deny-1", hostname: "deny-1.buyallmemes.com", enroll_token: NEW_TOKEN },
      rec.notify,
      undefined,
      { capSecret: "test-cap-secret", sealKey: "test-seal-key" },
    );
    expect(denyEnrollment(store, "deny-1")).toBe(true);
    expect(store.getPending("deny-1")).toBeUndefined();
    expect(denyEnrollment(store, "deny-1")).toBe(false);
    expect(await approveEnrollment(store, "deny-1")).toBeNull();
    expect(store.getBox("deny-1")).toBeUndefined();
  });

  it("rejects malformed enroll/approve/deny bodies without touching state", async () => {
    const store = new MemStore();
    const rec = recorder();
    const badEnroll: unknown[] = [
      { hostname: "x.buyallmemes.com", enroll_token: NEW_TOKEN },
      { id: "", hostname: "x.buyallmemes.com", enroll_token: NEW_TOKEN },
      { id: "x", enroll_token: NEW_TOKEN },
      { id: "x", hostname: "", enroll_token: NEW_TOKEN },
      { id: "x", hostname: "https://evil.example/pwn", enroll_token: NEW_TOKEN },
      { id: "x", hostname: "evil example.com", enroll_token: NEW_TOKEN },
      { id: "x", hostname: "x.buyallmemes.com" },
      { id: "x", hostname: "x.buyallmemes.com", enroll_token: "" },
      { id: "x", hostname: "x.buyallmemes.com", enroll_token: NEW_TOKEN, admin_token: "" },
      { id: "x", hostname: "x.buyallmemes.com", enroll_token: NEW_TOKEN, admin_token: 7 },
      null,
      [],
    ];
    for (const body of badEnroll) {
      expect(parseEnrollBody(body)).toBeNull();
      const res = await handleEnrollRequest(jsonRequest("/enroll", body), store, rec.notify);
      expect(res.status).toBe(400);
    }
    expect(store.pending.size).toBe(0);
    expect(rec.texts).toHaveLength(0);
    for (const handler of [handleEnrollApprove, handleEnrollDeny] as const) {
      for (const url of ["https://fleet.local/x", "https://fleet.local/x?id=&exp=1&sig=zz"]) {
        const res = await handler(new Request(url), store);
        expect(res.status).toBe(400);
      }
    }
  });

  it("valid links with no pending row resolve 404, never 500", async () => {
    const store = new MemStore();
    const approve = await issueCapabilityLink({ secret: CAP_TEST_KEY, action: "approve", id: "ghost", exp: FIXED_NOW + 900 });
    const res = await handleEnrollApprove(getRequest(approve), store, CAPS, fixedNow);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "no_pending" });
    const deny = await issueCapabilityLink({ secret: CAP_TEST_KEY, action: "deny", id: "ghost", exp: FIXED_NOW + 900 });
    expect((await handleEnrollDeny(getRequest(deny), store, CAPS, fixedNow)).status).toBe(404);
  });
});

describe("the box's tunnel id", () => {
  // The box names its cloudflared tunnel when it enrols, and the brain
  // keeps it: Phase 2 writes the box's DNS records from it.
  it("reads the tunnel id out of the enrolment body", () => {
    const body = { id: "tun-0", hostname: "tun-0.buyallmemes.com", enroll_token: NEW_TOKEN };
    expect(parseEnrollBody({ ...body, tunnel_id: "tunnel-abc" })?.tunnel_id).toBe("tunnel-abc");
    // A box with no tunnel says nothing: the field stays absent.
    expect(parseEnrollBody(body)?.tunnel_id).toBeUndefined();
    expect(parseEnrollBody({ ...body, tunnel_id: "" })?.tunnel_id).toBeUndefined();
  });

  it("parks the tunnel id on the pending row and carries it to the box row", async () => {
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "tun-1", hostname: "tun-1.buyallmemes.com", enroll_token: NEW_TOKEN, tunnel_id: "tunnel-abc" },
      rec.notify,
      () => 1700000100,
      { capSecret: "test-cap-secret", sealKey: "test-seal-key" },
    );
    expect(store.getPending("tun-1")?.tunnel_id).toBe("tunnel-abc");

    const row = await approveEnrollment(store, "tun-1");
    expect(row?.tunnel_id).toBe("tunnel-abc");
    expect(store.getBox("tun-1")?.tunnel_id).toBe("tunnel-abc");
  });

  it("stores the new tunnel id when a known box enrols again", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "tun-2");
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "tun-2", hostname: "tun-2.buyallmemes.com", enroll_token: KNOWN_TOKEN, tunnel_id: "tunnel-new" },
      rec.notify,
    );
    expect(store.getBox("tun-2")?.tunnel_id).toBe("tunnel-new");
  });

  it("keeps the tunnel id the box row knows when the body says nothing", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "tun-3");
    store.putBox({ ...store.getBox("tun-3")!, tunnel_id: "tunnel-old" });
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "tun-3", hostname: "tun-3.buyallmemes.com", enroll_token: KNOWN_TOKEN },
      rec.notify,
    );
    expect(store.getBox("tun-3")?.tunnel_id).toBe("tunnel-old");
  });
});

describe("ping bodies are short HTML, never raw URLs", () => {
  it("enroll ping shows anchors, id and host, hides link bulk", () => {
    const text = enrollPingText(
      { id: "pretty-1", hostname: "pretty-1.buyallmemes.com" },
      { approve: "https://fleet.test/approve?sig=abc", deny: "https://fleet.test/deny?sig=def" },
      1700000900,
    );
    expect(text).toContain("<b>New box wants in</b>");
    expect(text).toContain('<a href="https://fleet.test/approve?sig=abc">Approve</a>');
    expect(text).toContain('<a href="https://fleet.test/deny?sig=def">Deny</a>');
    expect(text).not.toMatch(/approve: https/);
  });

  it("rotation ping is one line with id and time", () => {
    const text = rotationPingText("pretty-1", 1700000000);
    expect(text).toContain("pretty-1");
    expect(text).not.toContain("sig=");
  });
});

describe("heartbeat token mismatch is rejected + alerted", () => {
  it("wrong token on a known id → 401 and exactly one alert naming the id", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "mm-1");
    const alerts: string[] = [];
    const res = await handleHeartbeat(
      heartbeatRequest("mm-1", 12, 6000, "wrong-token"),
      store,
      () => 1700000300,
      async (id: string) => {
        alerts.push(mismatchAlertText(id));
      },
    );
    expect(res.status).toBe(401);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("mm-1");
    expect(alerts[0]).not.toContain("wrong-token");
    expect(store.getBox("mm-1")?.last_seq).toBe(11);
  });

  it("missing token on a known id → 401 + alert; unknown id → 401 with no alert", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "mm-2");
    const alerts: string[] = [];
    const missing = await handleHeartbeat(
      heartbeatRequest("mm-2", 12, 6000, null),
      store,
      () => 1700000300,
      async (id: string) => {
        alerts.push(id);
      },
    );
    expect(missing.status).toBe(401);
    expect(alerts).toEqual(["mm-2"]);
    const ghost = await handleHeartbeat(
      heartbeatRequest("ghost", 1, 100, KNOWN_TOKEN),
      store,
      () => 1700000300,
      async (id: string) => {
        alerts.push(id);
      },
    );
    expect(ghost.status).toBe(401);
    expect(alerts).toEqual(["mm-2"]);
  });
});

describe("telegram ping (Bot API, through the client)", () => {
  it("posts chat_id + text to sendMessage and reports ok", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as typeof fetch;
    // The env carries the chat id as a string; the client sends a number.
    const ok = await sendTelegramMessage("bot-secret-1", "42", "hello", fetcher);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botbot-secret-1/sendMessage");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      chat_id: 42,
      text: "hello",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("never throws and never logs secrets on transport or API failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const apiFail = (async () => new Response("nope", { status: 429 })) as typeof fetch;
    await expect(sendTelegramMessage("bot-secret-9", "9", "t", apiFail)).resolves.toBe(false);
    const netFail = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    await expect(sendTelegramMessage("bot-secret-9", "9", "t", netFail)).resolves.toBe(false);
    const logged = error.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
    expect(logged).not.toContain("bot-secret-9");
    expect(logged).not.toContain("api.telegram.org");
  });

  it("a chat id that is not a number fails without asking telegram", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as typeof fetch;

    await expect(sendTelegramMessage("bot-secret-1", "not-a-chat-id", "hello", fetcher)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("enroll routes through the worker + DO", () => {
  function readPending(id: string): Promise<PendingRow | undefined> {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    return runInDurableObject<FleetState, PendingRow | undefined>(stub, async (instance) => instance.getPending(id));
  }

  // Test env carries no capability/seal secrets (by design — they are Worker
  // secrets, never committed), so routes pin the fail-loud degraded behavior.
  // The full issue→ping→approve link flow is covered at unit level above.
  it("POST /api/enroll without a capability secret fails loud 500, writes nothing", async () => {
    const res = await SELF.fetch("https://fleet.local/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "enr-new", hostname: "enr-new.buyallmemes.com", enroll_token: NEW_TOKEN }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "misconfigured" });
    expect(await readPending("enr-new")).toBeUndefined();
  });

  it("GET /api/enroll/approve|deny without a capability secret fails loud 500", async () => {
    for (const action of ["approve", "deny"] as const) {
      const res = await SELF.fetch(
        `https://fleet.local/api/enroll/${action}?id=enr-x&exp=1700001400&sig=${"0".repeat(64)}`,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: "misconfigured" });
    }
  });

  it("malformed enroll bodies and capability params are 400 through the route", async () => {
    const badEnroll = await SELF.fetch("https://fleet.local/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "enr-bad" }),
    });
    expect(badEnroll.status).toBe(400);
    const badLink = await SELF.fetch("https://fleet.local/api/enroll/approve?id=enr-bad");
    expect(badLink.status).toBe(400);
  });

  it("fails loud when the FLEET_STATE binding is missing", async () => {
    const enroll = await app.fetch(
      new Request("http://x/api/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "x" }),
      }),
    );
    expect(enroll.status).toBe(500);
    expect(await enroll.text()).toContain("FLEET_STATE");
    for (const path of ["/api/enroll/approve", "/api/enroll/deny"]) {
      const res = await app.fetch(new Request(`http://x${path}?id=x&exp=1&sig=00`));
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("FLEET_STATE");
    }
  });
});

const CAP_TEST_KEY = "test-capability-hmac-key-1";
const SEAL_KEY = "test-seal-key-def-2";
const ADMIN_PLAIN = "box-admin-plaintext-token-zzz-7";
const FIXED_NOW = 1700000500;
const fixedNow = () => FIXED_NOW;
const TEST_SECRETS = { capSecret: CAP_TEST_KEY, sealKey: SEAL_KEY };
const CAPS: EnrollConfig = { capSecret: CAP_TEST_KEY };

function linkFor(action: "approve" | "deny", id: string, exp: number, secret: string = CAP_TEST_KEY): Promise<string> {
  return issueCapabilityLink({ secret, action, id, exp });
}

function getRequest(link: string): Request {
  const url = link.startsWith("http") ? link : `https://fleet.local${link}`;
  return new Request(url);
}

function tamperSig(sig: string): string {
  return sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
}

describe("approve/deny capability links", () => {
  async function pendingStore(id: string): Promise<MemStore> {
    const store = new MemStore();
    await requestEnrollment(
      store,
      { id, hostname: `${id}.buyallmemes.com`, enroll_token: NEW_TOKEN },
      async () => {},
      fixedNow,
      TEST_SECRETS,
    );
    return store;
  }

  it("ping carries tappable approve/deny links with exp+sig, not plain commands", async () => {
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "cap-1", hostname: "cap-1.buyallmemes.com", enroll_token: NEW_TOKEN },
      rec.notify,
      fixedNow,
      { ...TEST_SECRETS, baseUrl: "https://fleet.buyallmemes.com" },
    );
    expect(rec.texts).toHaveLength(1);
    const ping = rec.texts[0];
    expect(ping).toContain(`https://fleet.buyallmemes.com/api/enroll/approve?id=cap-1&exp=${FIXED_NOW + 900}&sig=`);
    expect(ping).toContain(`https://fleet.buyallmemes.com/api/enroll/deny?id=cap-1&exp=${FIXED_NOW + 900}&sig=`);
    expect(ping).not.toContain('POST /api/enroll/approve {"id"');
    expect(ping).not.toContain(NEW_TOKEN);
  });

  it("valid approve link resolves and binds the token", async () => {
    const store = await pendingStore("cap-ok");
    const res = await handleEnrollApprove(getRequest(await linkFor("approve", "cap-ok", FIXED_NOW + 900)), store, CAPS, fixedNow);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "approved", id: "cap-ok", enrolled: true });
    expect(store.getPending("cap-ok")).toBeUndefined();
  });

  it("valid deny link clears pending without creating a box", async () => {
    const store = await pendingStore("cap-deny");
    const res = await handleEnrollDeny(getRequest(await linkFor("deny", "cap-deny", FIXED_NOW + 900)), store, CAPS, fixedNow);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "denied", id: "cap-deny" });
    expect(store.getPending("cap-deny")).toBeUndefined();
    expect(store.getBox("cap-deny")).toBeUndefined();
  });

  it("tampered signature is 403 and leaves pending intact", async () => {
    const store = await pendingStore("cap-tamper");
    const link = await linkFor("approve", "cap-tamper", FIXED_NOW + 900);
    const sig = new URL(link, "https://fleet.local").searchParams.get("sig") ?? "";
    const bad = link.replace(sig, tamperSig(sig));
    const res = await handleEnrollApprove(getRequest(bad), store, CAPS, fixedNow);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(store.getPending("cap-tamper")).toBeDefined();
  });

  it("signature for another id is 403", async () => {
    const store = await pendingStore("cap-other");
    const link = await linkFor("approve", "someone-else", FIXED_NOW + 900);
    const swapped = link.replace("id=someone-else", "id=cap-other");
    const res = await handleEnrollApprove(getRequest(swapped), store, CAPS, fixedNow);
    expect(res.status).toBe(403);
    expect(store.getPending("cap-other")).toBeDefined();
  });

  it("expired link is 403 even with a valid signature", async () => {
    const store = await pendingStore("cap-exp");
    expect(await verifyCapability(CAP_TEST_KEY, "approve", "cap-exp", FIXED_NOW - 1, await linkSig("approve", "cap-exp", FIXED_NOW - 1), fixedNow)).toBe(false);
    const res = await handleEnrollApprove(
      getRequest(await linkFor("approve", "cap-exp", FIXED_NOW - 1)),
      store,
      CAPS,
      fixedNow,
    );
    expect(res.status).toBe(403);
    expect(store.getPending("cap-exp")).toBeDefined();
  });

  it("forged link (wrong secret) is 403; forged link for unknown id is 403, not 404", async () => {
    const store = await pendingStore("cap-forge");
    const forged = await linkFor("approve", "cap-forge", FIXED_NOW + 900, "attacker-secret");
    expect((await handleEnrollApprove(getRequest(forged), store, CAPS, fixedNow)).status).toBe(403);
    const ghost = await linkFor("approve", "ghost", FIXED_NOW + 900, "attacker-secret");
    const res = await handleEnrollApprove(getRequest(ghost), store, CAPS, fixedNow);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });

  it("approve link used on the deny endpoint is 403 (action-bound)", async () => {
    const store = await pendingStore("cap-action");
    const res = await handleEnrollDeny(
      getRequest(await linkFor("approve", "cap-action", FIXED_NOW + 900)),
      store,
      CAPS,
      fixedNow,
    );
    expect(res.status).toBe(403);
    expect(store.getPending("cap-action")).toBeDefined();
  });

  it("missing or malformed capability params are 400", async () => {
    const store = await pendingStore("cap-mal");
    const urls = [
      "https://fleet.local/enroll/approve",
      "https://fleet.local/enroll/approve?id=cap-mal",
      "https://fleet.local/enroll/approve?id=cap-mal&exp=abc&sig=00",
      "https://fleet.local/enroll/approve?id=&exp=1700001400&sig=00",
      "https://fleet.local/enroll/approve?id=cap-mal&exp=-5&sig=00",
    ];
    for (const url of urls) {
      expect((await handleEnrollApprove(new Request(url), store, CAPS, fixedNow)).status).toBe(400);
    }
    expect((await handleEnrollDeny(new Request("https://fleet.local/enroll/deny?id=cap-mal"), store, CAPS, fixedNow)).status).toBe(400);
    expect(store.getPending("cap-mal")).toBeDefined();
  });

  it("missing capability secret fails loud 500 without resolving", async () => {
    const store = await pendingStore("cap-nosec");
    const link = await linkFor("approve", "cap-nosec", FIXED_NOW + 900);
    const res = await handleEnrollApprove(getRequest(link), store, {}, fixedNow);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "misconfigured" });
    expect(store.getPending("cap-nosec")).toBeDefined();
  });
});

async function linkSig(action: "approve" | "deny", id: string, exp: number): Promise<string> {
  return new URL(await linkFor(action, id, exp), "https://fleet.local").searchParams.get("sig") ?? "";
}

describe("admin token sealed at rest (AES-GCM)", () => {
  it("seal round-trips and the stored form is not plaintext", async () => {
    const sealed = await sealAdminToken(SEAL_KEY, ADMIN_PLAIN);
    expect(sealed).not.toContain(ADMIN_PLAIN);
    expect(await unsealAdminToken(SEAL_KEY, sealed)).toBe(ADMIN_PLAIN);
  });

  it("wrong key fails; tampered blob fails; empty unseals to null", async () => {
    const sealed = await sealAdminToken(SEAL_KEY, ADMIN_PLAIN);
    await expect(unsealAdminToken("wrong-key", sealed)).rejects.toThrow();
    const middle = Math.floor(sealed.length / 2);
    const flip = sealed[middle] === "A" ? "B" : "A";
    await expect(unsealAdminToken(SEAL_KEY, sealed.slice(0, middle) + flip + sealed.slice(middle + 1))).rejects.toThrow();
    await expect(unsealAdminToken(SEAL_KEY, "")).resolves.toBeNull();
  });

  it("enrollment with admin_token stores only the sealed form, never plaintext", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "seal-1", hostname: "seal-1.buyallmemes.com", enroll_token: NEW_TOKEN, admin_token: ADMIN_PLAIN },
      rec.notify,
      fixedNow,
      TEST_SECRETS,
    );
    const pending = store.getPending("seal-1");
    expect(pending?.admin_token_sealed).toBeDefined();
    expect(pending?.admin_token_sealed).not.toContain(ADMIN_PLAIN);
    expect(await unsealAdminToken(SEAL_KEY, pending?.admin_token_sealed ?? "")).toBe(ADMIN_PLAIN);
    const row = await approveEnrollment(store, "seal-1");
    expect(row?.admin_token_sealed).toBe(pending?.admin_token_sealed);
    expect(row?.admin_token_hash).toBe("");
    expect(await unsealAdminToken(SEAL_KEY, row?.admin_token_sealed ?? "")).toBe(ADMIN_PLAIN);
    expect(rec.texts.join("\n")).not.toContain(ADMIN_PLAIN);
    const logged = error.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
    expect(logged).not.toContain(ADMIN_PLAIN);
  });

  it("admin_token without a seal key fails loud with no pending row (never silently dropped)", async () => {
    const store = new MemStore();
    await expect(
      requestEnrollment(
        store,
        { id: "seal-loud", hostname: "seal-loud.buyallmemes.com", enroll_token: NEW_TOKEN, admin_token: ADMIN_PLAIN },
        async () => {},
        fixedNow,
        { capSecret: CAP_TEST_KEY },
      ),
    ).rejects.toThrow("seal key");
    expect(store.getPending("seal-loud")).toBeUndefined();
  });

  it("enrollment without admin_token needs no seal key and seals nothing", async () => {
    const store = new MemStore();
    const result = await requestEnrollment(
      store,
      { id: "seal-none", hostname: "seal-none.buyallmemes.com", enroll_token: NEW_TOKEN },
      async () => {},
      fixedNow,
      { capSecret: CAP_TEST_KEY },
    );
    expect(result).toEqual({ status: "pending", id: "seal-none", rotated: false, trusted: false });
    expect(store.getPending("seal-none")?.admin_token_sealed).toBe("");
    const row = await approveEnrollment(store, "seal-none");
    expect(row?.admin_token_sealed).toBe("");
    await expect(unsealAdminToken(SEAL_KEY, row?.admin_token_sealed ?? "")).resolves.toBeNull();
  });

  it("known-id rebind with a new admin_token overwrites; without preserves", async () => {
    const store = new MemStore();
    await requestEnrollment(
      store,
      { id: "seal-re", hostname: "seal-re.buyallmemes.com", enroll_token: NEW_TOKEN, admin_token: ADMIN_PLAIN },
      async () => {},
      fixedNow,
      TEST_SECRETS,
    );
    const first = await approveEnrollment(store, "seal-re");
    await requestEnrollment(
      store,
      { id: "seal-re", hostname: "seal-re.buyallmemes.com", enroll_token: CLONE_TOKEN },
      async () => {},
      fixedNow,
      TEST_SECRETS,
    );
    const kept = await approveEnrollment(store, "seal-re");
    expect(kept?.admin_token_sealed).toBe(first?.admin_token_sealed);
    await requestEnrollment(
      store,
      { id: "seal-re", hostname: "seal-re.buyallmemes.com", enroll_token: "rotated-enroll-token-3", admin_token: "rotated-admin-plain-8" },
      async () => {},
      fixedNow,
      TEST_SECRETS,
    );
    const rotated = await approveEnrollment(store, "seal-re");
    expect(rotated?.admin_token_sealed).not.toBe(first?.admin_token_sealed);
    expect(await unsealAdminToken(SEAL_KEY, rotated?.admin_token_sealed ?? "")).toBe("rotated-admin-plain-8");
  });
});

describe("enrolled fast-path admin rotation", () => {
  it("rotate-ok: bound token + new admin_token seals, stores, reports rotated:true, pings once", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "rot-1");
    const rec = recorder();
    const result = await requestEnrollment(
      store,
      { id: "rot-1", hostname: "rot-1.buyallmemes.com", enroll_token: KNOWN_TOKEN, admin_token: "fresh-admin-rotation-1" },
      rec.notify,
      fixedNow,
      TEST_SECRETS,
    );
    expect(result).toEqual({ status: "enrolled", id: "rot-1", rotated: true, trusted: true, dns: NO_DNS });
    expect(store.getPending("rot-1")).toBeUndefined();
    const row = store.getBox("rot-1");
    expect(row?.admin_token_sealed).not.toContain("fresh-admin-rotation-1");
    expect(await unsealAdminToken(SEAL_KEY, row?.admin_token_sealed ?? "")).toBe("fresh-admin-rotation-1");
    expect(row).toMatchObject({ last_seq: 11, last_ts: 5000, enrolled: 1 });
    // Two messages: the rotation, and the DNS this brain could not
    // write (it has no credential).
    expect(rec.texts).toHaveLength(2);
    const rotation = rec.texts.find((t) => t.includes("Admin token rotated"));
    expect(rotation).toBeDefined();
    expect(rotation).toContain("rot-1");
    expect(rotation).toContain(new Date(FIXED_NOW * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z");
    expect(rotation).not.toContain("fresh-admin-rotation-1");
    const again = await requestEnrollment(
      store,
      { id: "rot-1", hostname: "rot-1.buyallmemes.com", enroll_token: KNOWN_TOKEN, admin_token: "fresh-admin-rotation-1" },
      rec.notify,
      fixedNow,
      TEST_SECRETS,
    );
    expect(again).toEqual({ status: "enrolled", id: "rot-1", rotated: false, trusted: true, dns: NO_DNS });
    // No new rotation message; the DNS is reported again, because this
    // is another enrolment.
    expect(rec.texts).toHaveLength(3);
  });

  it("rotation overwrites a previously bound admin token", async () => {
    const store = new MemStore();
    const box = await seedEnrolled(store, "rot-2");
    store.putBox({ ...box, admin_token_sealed: await sealAdminToken(SEAL_KEY, "old-admin-1") });
    const result = await requestEnrollment(
      store,
      { id: "rot-2", hostname: "rot-2.buyallmemes.com", enroll_token: KNOWN_TOKEN, admin_token: "new-admin-2" },
      async () => {},
      fixedNow,
      TEST_SECRETS,
    );
    expect(result).toEqual({ status: "enrolled", id: "rot-2", rotated: true, trusted: true, dns: NO_DNS });
    expect(await unsealAdminToken(SEAL_KEY, store.getBox("rot-2")?.admin_token_sealed ?? "")).toBe("new-admin-2");
  });

  it("rotate-without-seal-key fails loud, row untouched, nothing pending", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "rot-3");
    await expect(
      requestEnrollment(
        store,
        { id: "rot-3", hostname: "rot-3.buyallmemes.com", enroll_token: KNOWN_TOKEN, admin_token: "fresh-admin-rotation-1" },
        async () => {},
        fixedNow,
        { capSecret: CAP_TEST_KEY },
      ),
    ).rejects.toThrow("seal key");
    expect(store.getBox("rot-3")?.admin_token_sealed).toBe("");
    expect(store.getPending("rot-3")).toBeUndefined();
  });

  it("handler reports the rotated flag in JSON", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "rot-4");
    const res = await handleEnrollRequest(
      jsonRequest("/enroll", {
        id: "rot-4",
        hostname: "rot-4.buyallmemes.com",
        enroll_token: KNOWN_TOKEN,
        admin_token: "fresh-admin-rotation-2",
      }),
      store,
      async () => {},
      fixedNow,
      TEST_SECRETS,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "enrolled", id: "rot-4", enrolled: true, rotated: true, trusted: true, dns: NO_DNS });
  });
});

describe("enrollment hostname policy", () => {
  const good = (hostname: string) => ({ id: "h-1", hostname, enroll_token: NEW_TOKEN });

  it("accepts multi-label names under the default suffix, including the bare suffix", () => {
    for (const hostname of ["box1.buyallmemes.com", "deep.sub.buyallmemes.com", "buyallmemes.com"]) {
      expect(isPinnedHostname(hostname)).toBe(true);
      expect(parseEnrollBody(good(hostname))).toMatchObject({ hostname });
    }
  });

  it("rejects IP literals, localhost, single-label, .local, and off-suffix names", () => {
    const bad = [
      "1.2.3.4",
      "10.0.0.5",
      "127.0.0.1",
      "::1",
      "localhost",
      "LOCALHOST",
      "box.localhost",
      "mybox",
      "printer.local",
      "evil.com",
      "x.buyallmemes.com.evil.com",
      "notbuyallmemes.com",
      "buyallmemes.com.",
    ];
    for (const hostname of bad) {
      expect(isPinnedHostname(hostname)).toBe(false);
      expect(parseEnrollBody(good(hostname))).toBeNull();
    }
  });

  it("suffix allowlist override accepts other suffixes and still rejects the rest", () => {
    expect(parseHostSuffixes(undefined)).toEqual(["buyallmemes.com"]);
    expect(parseHostSuffixes("")).toEqual(["buyallmemes.com"]);
    expect(parseHostSuffixes("Example.COM , other.test ")).toEqual(["example.com", "other.test"]);
    expect(parseEnrollBody(good("db.example.com"), ["example.com"])).toMatchObject({
      hostname: "db.example.com",
    });
    expect(parseEnrollBody(good("db.example.com"))).toBeNull();
    expect(parseEnrollBody(good("1.2.3.4"), ["1.2.3.4"])).toBeNull();
    expect(parseEnrollBody(good("other.test"), ["example.com"])).toBeNull();
  });

  it("handler 400s intake violations without touching state or pinging", async () => {
    const store = new MemStore();
    const rec = recorder();
    for (const hostname of ["9.9.9.9", "mybox", "box.local", "localhost", "evil.com"]) {
      const res = await handleEnrollRequest(
        jsonRequest("/enroll", { id: "h-bad", hostname, enroll_token: NEW_TOKEN }),
        store,
        rec.notify,
        fixedNow,
        TEST_SECRETS,
      );
      expect(res.status).toBe(400);
    }
    expect(store.pending.size).toBe(0);
    expect(rec.texts).toHaveLength(0);
  });

  it("handler honors the hostSuffixes override", async () => {
    const store = new MemStore();
    const res = await handleEnrollRequest(
      jsonRequest("/enroll", { id: "h-ov", hostname: "db.example.com", enroll_token: NEW_TOKEN }),
      store,
      async () => {},
      fixedNow,
      { ...TEST_SECRETS, hostSuffixes: ["example.com"] },
    );
    expect(res.status).toBe(200);
    expect(store.getPending("h-ov")?.hostname).toBe("db.example.com");
  });

  it("requestEnrollment enforces the policy for direct callers", async () => {
    const store = new MemStore();
    await expect(
      requestEnrollment(store, good("10.1.2.3"), async () => {}, fixedNow, TEST_SECRETS),
    ).rejects.toThrow("bad_request");
    expect(store.getPending("h-1")).toBeUndefined();
  });
});

describe("pending-path rotation ping", () => {
  it("approve that swaps the sealed admin token pings the owner once", async () => {
    const store = new MemStore();
    const box = await seedEnrolled(store, "rot-p");
    store.putBox({ ...box, admin_token_sealed: await sealAdminToken(SEAL_KEY, "old-admin-1") });
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "rot-p", hostname: "rot-p.buyallmemes.com", enroll_token: CLONE_TOKEN, admin_token: "new-admin-9" },
      rec.notify,
      fixedNow,
      TEST_SECRETS,
    );
    expect(rec.texts).toHaveLength(1);
    const row = await approveEnrollment(store, "rot-p", rec.notify, fixedNow);
    expect(await unsealAdminToken(SEAL_KEY, row?.admin_token_sealed ?? "")).toBe("new-admin-9");
    expect(rec.texts).toHaveLength(2);
    expect(rec.texts[1]).toContain("rot-p");
    expect(rec.texts[1]).toContain("Admin token rotated");
    expect(rec.texts[1]).not.toContain("new-admin-9");
  });

  it("approve that preserves the sealed value stays silent", async () => {
    const store = new MemStore();
    const box = await seedEnrolled(store, "rot-q");
    const sealed = await sealAdminToken(SEAL_KEY, "keep-admin-1");
    store.putBox({ ...box, admin_token_sealed: sealed });
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "rot-q", hostname: "rot-q.buyallmemes.com", enroll_token: CLONE_TOKEN },
      rec.notify,
      fixedNow,
      TEST_SECRETS,
    );
    const row = await approveEnrollment(store, "rot-q", rec.notify, fixedNow);
    expect(row?.admin_token_sealed).toBe(sealed);
    expect(rec.texts).toHaveLength(1);
  });

  it("first-time approve never pings rotation", async () => {
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "rot-new", hostname: "rot-new.buyallmemes.com", enroll_token: NEW_TOKEN, admin_token: ADMIN_PLAIN },
      rec.notify,
      fixedNow,
      TEST_SECRETS,
    );
    await approveEnrollment(store, "rot-new", rec.notify, fixedNow);
    expect(rec.texts).toHaveLength(1);
  });
});

describe("deny leaves a marker row", () => {
  it("denyEnrollment persists id + timestamp", async () => {
    const store = new MemStore();
    await requestEnrollment(
      store,
      { id: "deny-m", hostname: "deny-m.buyallmemes.com", enroll_token: NEW_TOKEN },
      async () => {},
      fixedNow,
      TEST_SECRETS,
    );
    expect(denyEnrollment(store, "deny-m", fixedNow)).toBe(true);
    expect(store.getPending("deny-m")).toBeUndefined();
    expect(store.getDenial("deny-m")).toEqual({ id: "deny-m", denied_at: FIXED_NOW });
    expect(denyEnrollment(store, "deny-m", fixedNow)).toBe(false);
  });

  it("deny through the capability handler persists the marker", async () => {
    const store = new MemStore();
    await requestEnrollment(
      store,
      { id: "deny-h", hostname: "deny-h.buyallmemes.com", enroll_token: NEW_TOKEN },
      async () => {},
      fixedNow,
      TEST_SECRETS,
    );
    const res = await handleEnrollDeny(
      getRequest(await linkFor("deny", "deny-h", FIXED_NOW + 900)),
      store,
      CAPS,
      fixedNow,
    );
    expect(res.status).toBe(200);
    expect(store.getDenial("deny-h")).toEqual({ id: "deny-h", denied_at: FIXED_NOW });
    expect(store.getBox("deny-h")).toBeUndefined();
  });
});

describe("capability binding (approval TOCTOU)", () => {
  function approveLink(ping: string): string {
    const match = ping.match(/<a href="([^"]+)">Approve<\/a>/);
    if (!match) {
      throw new Error("test: no approve link in ping");
    }
    return match[1];
  }

  function denyLink(ping: string): string {
    const match = ping.match(/<a href="([^"]+)">Deny<\/a>/);
    if (!match) {
      throw new Error("test: no deny link in ping");
    }
    return match[1];
  }

  it("ping links bind the pending token hash + hostname into the MAC", async () => {
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "bind-1", hostname: "bind-1.buyallmemes.com", enroll_token: NEW_TOKEN },
      rec.notify,
      fixedNow,
      { ...TEST_SECRETS, baseUrl: "https://fleet.test" },
    );
    const pending = store.getPending("bind-1");
    const url = new URL(approveLink(rec.texts[0]));
    expect(url.searchParams.get("token_hash")).toBe(pending?.heartbeat_token_hash);
    expect(url.searchParams.get("hostname")).toBe("bind-1.buyallmemes.com");
    const binding: CapabilityBinding = {
      tokenHash: pending?.heartbeat_token_hash ?? "",
      hostname: pending?.hostname ?? "",
    };
    expect(
      await verifyCapability(
        CAP_TEST_KEY,
        "approve",
        "bind-1",
        FIXED_NOW + 900,
        url.searchParams.get("sig") ?? "",
        fixedNow,
        capBinding(binding.tokenHash, binding.hostname),
      ),
    ).toBe(true);
    expect(
      await verifyCapability(
        CAP_TEST_KEY,
        "approve",
        "bind-1",
        FIXED_NOW + 900,
        url.searchParams.get("sig") ?? "",
        fixedNow,
        capBinding(await hashToken("other-token"), binding.hostname),
      ),
    ).toBe(false);
  });

  it("overwrite-then-approve-with-old-link fails closed; the fresh link still works", async () => {
    const store = new MemStore();
    const first = recorder();
    await requestEnrollment(
      store,
      { id: "bind-2", hostname: "bind-2.buyallmemes.com", enroll_token: NEW_TOKEN },
      first.notify,
      fixedNow,
      TEST_SECRETS,
    );
    const oldLink = approveLink(first.texts[0]);
    const second = recorder();
    await requestEnrollment(
      store,
      { id: "bind-2", hostname: "bind-2.buyallmemes.com", enroll_token: CLONE_TOKEN },
      second.notify,
      fixedNow,
      TEST_SECRETS,
    );
    const stale = await handleEnrollApprove(getRequest(oldLink), store, CAPS, fixedNow);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: "forbidden" });
    // Overwritten pending is untouched: still the new token, still pending.
    expect(store.getPending("bind-2")?.heartbeat_token_hash).toBe(await hashToken(CLONE_TOKEN));
    const fresh = await handleEnrollApprove(getRequest(approveLink(second.texts[0])), store, CAPS, fixedNow);
    expect(fresh.status).toBe(200);
    expect(await tokenMatches(CLONE_TOKEN, store.getBox("bind-2")?.heartbeat_token_hash ?? "")).toBe(true);
  });

  it("old deny link after overwrite is 403; the fresh deny link denies + marks", async () => {
    const store = new MemStore();
    const first = recorder();
    await requestEnrollment(
      store,
      { id: "bind-3", hostname: "bind-3.buyallmemes.com", enroll_token: NEW_TOKEN },
      first.notify,
      fixedNow,
      TEST_SECRETS,
    );
    const oldDeny = denyLink(first.texts[0]);
    const second = recorder();
    await requestEnrollment(
      store,
      { id: "bind-3", hostname: "bind-3.buyallmemes.com", enroll_token: CLONE_TOKEN },
      second.notify,
      fixedNow,
      TEST_SECRETS,
    );
    expect((await handleEnrollDeny(getRequest(oldDeny), store, CAPS, fixedNow)).status).toBe(403);
    expect(store.getPending("bind-3")).toBeDefined();
    const res = await handleEnrollDeny(getRequest(denyLink(second.texts[0])), store, CAPS, fixedNow);
    expect(res.status).toBe(200);
    expect(store.getPending("bind-3")).toBeUndefined();
    expect(store.getDenial("bind-3")).toEqual({ id: "bind-3", denied_at: FIXED_NOW });
  });
});

describe("enrollment code claim (typed code from Telegram)", () => {
  const CODE = "typed-code-abc-123";
  const CLAIM_ADMIN = "claimed-admin-secret-9";
  const NOW = 1700000100;
  const SECRETS = { capSecret: "test-cap-secret", sealKey: "test-seal-key" };
  // Owner-issued: the bot asked for this box in Telegram, so the pending
  // row is trusted and the typed code may claim it without an approve tap.
  const TRUSTED = { ...SECRETS, trusted: true };

  async function issue(
    store: MemStore,
    id = "code-1",
    hostname = "code-1.buyallmemes.com",
    token: string = CODE,
    config = TRUSTED,
  ) {
    const rec = recorder();
    const res = await requestEnrollment(store, { id, hostname, enroll_token: token }, rec.notify, () => NOW, config);
    expect(res.status).toBe("pending");
    return rec;
  }

  it("typed code enrolls immediately with no second ping", async () => {
    const store = new MemStore();
    const first = await issue(store);
    expect(first.texts).toHaveLength(1);
    const rec = recorder();
    const res = await requestEnrollment(
      store,
      { id: "code-1", hostname: "code-1.buyallmemes.com", enroll_token: CODE, admin_token: CLAIM_ADMIN },
      rec.notify,
      () => NOW + 60,
      TRUSTED,
    );
    expect(res).toEqual({ status: "enrolled", id: "code-1", rotated: false, trusted: true, dns: NO_DNS });
    // No second ping: the typed code was the approval, so there is no
    // approve tap to wait for. The one message is the DNS report — this
    // brain has no credential, so the enrolment ends with a DNS it could
    // not write, and the owner must hear about it.
    expect(rec.texts).toHaveLength(1);
    expect(rec.texts[0]).toContain("code-1");
    expect(rec.texts[0]).not.toContain("/api/enroll/approve");
    expect(store.getPending("code-1")).toBeUndefined();
    const box = store.getBox("code-1");
    expect(box?.enrolled).toBe(1);
    expect(box?.heartbeat_token_hash).toBe(await hashToken(CODE));
    expect(await unsealAdminToken("test-seal-key", box?.admin_token_sealed ?? "")).toBe(CLAIM_ADMIN);
  });

  it("wrong code overwrites pending and re-pings", async () => {
    const store = new MemStore();
    await issue(store);
    const rec = recorder();
    const res = await requestEnrollment(
      store,
      { id: "code-1", hostname: "code-1.buyallmemes.com", enroll_token: "wrong-code" },
      rec.notify,
      () => NOW + 60,
      SECRETS,
    );
    expect(res.status).toBe("pending");
    expect(store.getBox("code-1")).toBeUndefined();
    expect(store.getPending("code-1")?.heartbeat_token_hash).toBe(await hashToken("wrong-code"));
    expect(rec.texts).toHaveLength(1);
  });

  it("expired code re-pends instead of enrolling", async () => {
    const store = new MemStore();
    await issue(store);
    const rec = recorder();
    const res = await requestEnrollment(
      store,
      { id: "code-1", hostname: "code-1.buyallmemes.com", enroll_token: CODE },
      rec.notify,
      () => NOW + 901,
      SECRETS,
    );
    expect(res.status).toBe("pending");
    expect(store.getBox("code-1")).toBeUndefined();
    expect(rec.texts).toHaveLength(1);
  });

  it("hostname mismatch does not claim", async () => {
    const store = new MemStore();
    await issue(store);
    const rec = recorder();
    const res = await requestEnrollment(
      store,
      { id: "code-1", hostname: "other.buyallmemes.com", enroll_token: CODE },
      rec.notify,
      () => NOW + 60,
      SECRETS,
    );
    expect(res.status).toBe("pending");
    expect(store.getBox("code-1")).toBeUndefined();
  });

  it("claim on a known box rotates admin with a ping", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "known-1");
    await issue(store, "known-1", "known-1.buyallmemes.com");
    const rec = recorder();
    const res = await requestEnrollment(
      store,
      { id: "known-1", hostname: "known-1.buyallmemes.com", enroll_token: CODE, admin_token: CLAIM_ADMIN },
      rec.notify,
      () => NOW + 60,
      TRUSTED,
    );
    expect(res.status).toBe("enrolled");
    expect(res.rotated).toBe(true);
    expect(rec.texts.some((t) => t.includes("known-1"))).toBe(true);
  });

  it("untrusted pending cannot be claimed by typing the code", async () => {
    // An unauthenticated caller may start an enrollment, but it must not
    // be able to bind a live box: without the owner-issued trust flag the
    // typed code only re-pends, and the approve tap stays mandatory.
    const store = new MemStore();
    await seedEnrolled(store, "live-1");
    const rec = recorder();
    const first = await requestEnrollment(
      store,
      { id: "live-1", hostname: "live-1.buyallmemes.com", enroll_token: "attacker-token" },
      rec.notify,
      () => NOW,
      SECRETS,
    );
    expect(first.status).toBe("pending");
    const second = await requestEnrollment(
      store,
      { id: "live-1", hostname: "live-1.buyallmemes.com", enroll_token: "attacker-token" },
      rec.notify,
      () => NOW + 60,
      SECRETS,
    );
    expect(second.status).toBe("pending");
    const box = store.getBox("live-1");
    expect(box?.heartbeat_token_hash).toBe(await hashToken(KNOWN_TOKEN));
  });

  it("trusted claim may repoint the hostname the owner asked for", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "moved-1");
    await issue(store, "moved-1", "new-host.buyallmemes.com", CODE, TRUSTED);
    const res = await requestEnrollment(
      store,
      { id: "moved-1", hostname: "new-host.buyallmemes.com", enroll_token: CODE },
      recorder().notify,
      () => NOW + 60,
      TRUSTED,
    );
    expect(res.status).toBe("enrolled");
    expect(store.getBox("moved-1")?.hostname).toBe("new-host.buyallmemes.com");
  });

  it("quiet enroll parks pending with no approve/deny ping", async () => {
    const store = new MemStore();
    const rec = recorder();
    const res = await requestEnrollment(
      store,
      { id: "quiet-1", hostname: "quiet-1.buyallmemes.com", enroll_token: NEW_TOKEN, quiet: true },
      rec.notify,
      () => 1700000100,
      { capSecret: "test-cap-secret", sealKey: "test-seal-key" },
    );
    expect(res.status).toBe("pending");
    expect(store.getPending("quiet-1")).toBeDefined();
    expect(rec.texts).toHaveLength(0);
  });
});

describe("the enrolment writes the box's DNS", () => {
  const ZONE = "zone-dns-1";
  const TOKEN = "cf-dns-token-test-9";
  const CODE = "dns-code-abc-123";
  const NOW = 1700000100;

  // The fake Cloudflare API: the brain's DNS writer talks to it, and the
  // test asserts what the brain wrote.
  class FakeCloudflare {
    calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    records: Array<Record<string, unknown>> = [];
    // Set to make every call answer with this status and API code.
    failWith: { status: number; code: number } | null = null;

    get fetcher(): typeof fetch {
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        this.calls.push({ method, url: url.toString(), body });
        if (this.failWith) {
          return this.reply(this.failWith.status, {
            success: false,
            errors: [{ code: this.failWith.code }],
            result: null,
          });
        }
        if (method === "GET") {
          return this.reply(200, {
            success: true,
            result: this.records,
            result_info: { total_pages: 1 },
          });
        }
        const record = { id: `rec-${this.records.length + 1}`, ...body };
        this.records.push(record);
        return this.reply(200, { success: true, result: record });
      }) as typeof fetch;
    }

    private reply(status: number, doc: unknown): Response {
      return new Response(JSON.stringify(doc), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // The box's own names: the tap host is what the box enrols with, the UI
  // host is the same name without "tap-" (the rule the box's onboarding
  // uses — internal/onboard/tunnel.go).
  const TAP = "oc-tap-dns-1.buyallmemes.com";
  const UI = "oc-dns-1.buyallmemes.com";

  function configWith(fetcher: typeof fetch, deadlineMs?: number): EnrollConfig {
    return {
      capSecret: CAP_TEST_KEY,
      sealKey: SEAL_KEY,
      trusted: true,
      baseUrl: "https://fleet.test",
      dns: { zoneId: ZONE, token: TOKEN, fetcher, deadlineMs },
    };
  }

  // The box asks to enrol (the brain parks a pending row), then the
  // owner-issued code claims it: the enrolment commits.
  async function enroll(
    store: MemStore,
    config: EnrollConfig,
    id: string,
    hostname: string,
    tunnelId?: string,
  ): Promise<Response> {
    const body = {
      id,
      hostname,
      enroll_token: CODE,
      ...(tunnelId === undefined ? {} : { tunnel_id: tunnelId }),
    };
    const parked = await requestEnrollment(store, body, async () => {}, () => NOW, config);
    expect(parked.status).toBe("pending");
    return handleEnrollRequest(jsonRequest("/enroll", body), store, async () => {}, () => NOW + 60, config);
  }

  it("a claim with a tunnel id writes both CNAMEs and reports dns ok", async () => {
    const store = new MemStore();
    const cf = new FakeCloudflare();
    const config = configWith(cf.fetcher);

    const res = await enroll(store, config, "dns-1", TAP, "tun-9");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "enrolled", enrolled: true, dns: "ok" });

    // Both CNAMEs, pointing at the box's tunnel.
    const posts = cf.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body?.["name"])).toEqual([TAP, UI]);
    for (const post of posts) {
      expect(post.body).toMatchObject({
        type: "CNAME",
        content: "tun-9.cfargotunnel.com",
        proxied: true,
      });
    }
  });

  it("a box that re-enrols with a new tunnel id writes the DNS for that tunnel", async () => {
    const store = new MemStore();
    const cf = new FakeCloudflare();
    const config = configWith(cf.fetcher);
    const box = await seedEnrolled(store, "dns-4");
    store.putBox({ ...box, hostname: "oc-tap-dns-4.buyallmemes.com" });

    // The box re-enrols with the tunnel it created today.
    const res = await handleEnrollRequest(
      jsonRequest("/enroll", {
        id: "dns-4",
        hostname: "oc-tap-dns-4.buyallmemes.com",
        enroll_token: KNOWN_TOKEN,
        tunnel_id: "tun-new",
      }),
      store,
      async () => {},
      () => NOW,
      config,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "enrolled", dns: "ok" });
    expect(store.getBox("dns-4")?.tunnel_id).toBe("tun-new");

    const posts = cf.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body?.["name"])).toEqual([
      "oc-tap-dns-4.buyallmemes.com",
      "oc-dns-4.buyallmemes.com",
    ]);
    for (const post of posts) {
      expect(post.body).toMatchObject({ content: "tun-new.cfargotunnel.com" });
    }
  });

  it("a box whose hostname names no domain gets no DNS at all", async () => {
    const store = new MemStore();
    const cf = new FakeCloudflare();
    const config = configWith(cf.fetcher);
    const box = await seedEnrolled(store, "dns-6");
    // A row that holds a bare hostname: there is no UI host to derive,
    // and the brain must not write one record and call it done.
    store.putBox({ ...box, hostname: "dns-6", tunnel_id: "tun-6" });

    const res = await handleEnrollRequest(
      jsonRequest("/enroll", {
        id: "dns-6",
        hostname: "dns-6.buyallmemes.com",
        enroll_token: KNOWN_TOKEN,
      }),
      store,
      async () => {},
      () => NOW,
      config,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnrolResponse;
    expect(body.dns).toMatch(/^failed:/);
    expect(body.dns).toContain("dns-6");
    expect(cf.calls).toHaveLength(0);
  });

  it("a box with no tunnel id enrols and writes no DNS", async () => {
    const store = new MemStore();
    const cf = new FakeCloudflare();
    const config = configWith(cf.fetcher);

    // A box that enrolled before the tunnel id existed (home and mac
    // today): it enrols, and the brain has nothing to point at.
    const res = await enroll(store, config, "dns-2", "oc-tap-dns-2.buyallmemes.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnrolResponse;
    expect(body).toMatchObject({ status: "enrolled", enrolled: true });
    expect(body.dns).toBe("skipped: no tunnel id recorded for dns-2 — re-enrol to bind one");
    // The API was never called: there was nothing to point at.
    expect(cf.calls).toHaveLength(0);
  });

  it("a refused DNS write is reported and the enrolment still commits", async () => {
    const store = new MemStore();
    const cf = new FakeCloudflare();
    cf.failWith = { status: 403, code: 9109 };
    const config = configWith(cf.fetcher);

    const res = await enroll(store, config, "dns-3", "oc-tap-dns-3.buyallmemes.com", "tun-3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnrolResponse;
    expect(body).toMatchObject({ status: "enrolled", enrolled: true });
    expect(body.dns).toMatch(/^failed:/);
    expect(body.dns).toContain("403");
    // The box row is committed: the enrolment is the commit point and
    // the DNS never rolls it back.
    expect(store.getBox("dns-3")?.enrolled).toBe(1);
  });

  it("the approve tap is an enrolment too: it writes the DNS", async () => {
    const store = new MemStore();
    const cf = new FakeCloudflare();
    const config = configWith(cf.fetcher);

    // The box asks to enrol; the owner approves it in Telegram.
    await requestEnrollment(
      store,
      { id: "dns-5", hostname: "oc-tap-dns-5.buyallmemes.com", enroll_token: CODE, tunnel_id: "tun-5" },
      async () => {},
      () => NOW,
      config,
    );
    const link = await linkFor("approve", "dns-5", NOW + 900);
    const res = await handleEnrollApprove(getRequest(link), store, config, () => NOW, async () => {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "approved", enrolled: true, dns: "ok" });

    const posts = cf.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body?.["name"])).toEqual([
      "oc-tap-dns-5.buyallmemes.com",
      "oc-dns-5.buyallmemes.com",
    ]);
  });

  it("a claim names the tunnel the box just made, when the brain issued the code", async () => {
    const store = new MemStore();
    const cf = new FakeCloudflare();
    const config = configWith(cf.fetcher);

    // The brain issues the code itself (the /enrollcode flow): it does
    // not know the box's tunnel yet, so the pending row names none.
    const parked = await requestEnrollment(
      store,
      { id: "dns-7", hostname: "oc-tap-dns-7.buyallmemes.com", enroll_token: CODE },
      async () => {},
      () => NOW,
      config,
    );
    expect(parked.status).toBe("pending");
    expect(store.getPending("dns-7")?.tunnel_id).toBe("");

    // The box creates its tunnel and claims with the code and the id.
    const res = await handleEnrollRequest(
      jsonRequest("/enroll", {
        id: "dns-7",
        hostname: "oc-tap-dns-7.buyallmemes.com",
        enroll_token: CODE,
        tunnel_id: "tun-7",
      }),
      store,
      async () => {},
      () => NOW + 60,
      config,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "enrolled", dns: "ok" });
    expect(store.getBox("dns-7")?.tunnel_id).toBe("tun-7");

    // Both CNAMEs, pointing at the tunnel the box named.
    const posts = cf.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body?.["name"])).toEqual([
      "oc-tap-dns-7.buyallmemes.com",
      "oc-dns-7.buyallmemes.com",
    ]);
    for (const post of posts) {
      expect(post.body).toMatchObject({ content: "tun-7.cfargotunnel.com" });
    }
  });

  it("a row without a tunnel id field is a skip, not a crash", async () => {
    const store = new MemStore();
    const cf = new FakeCloudflare();
    const config = configWith(cf.fetcher);
    const box = await seedEnrolled(store, "dns-8");
    // A store that answers without the field: the brain must not answer
    // with a TypeError.
    store.putBox({ ...box, tunnel_id: undefined as unknown as string });

    const res = await handleEnrollRequest(
      jsonRequest("/enroll", {
        id: "dns-8",
        hostname: "dns-8.buyallmemes.com",
        enroll_token: KNOWN_TOKEN,
      }),
      store,
      async () => {},
      () => NOW,
      config,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnrolResponse;
    expect(body.dns).toBe("skipped: no tunnel id recorded for dns-8 — re-enrol to bind one");
    expect(cf.calls).toHaveLength(0);
  });

  it("a Cloudflare call that hangs is a reported failure, not a hung enrolment", async () => {
    const store = new MemStore();
    // The API never answers: the deadline must end the call.
    const hanging: typeof fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const config = configWith(hanging, 50);

    const res = await enroll(store, config, "dns-9", "oc-tap-dns-9.buyallmemes.com", "tun-9");
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnrolResponse;
    expect(body).toMatchObject({ status: "enrolled", enrolled: true });
    expect(body.dns).toMatch(/^failed:/);
    expect(body.dns).toContain("did not answer");
    // The box row is committed: a DNS that timed out never rolls the
    // enrolment back.
    expect(store.getBox("dns-9")?.enrolled).toBe(1);
  });
});

// The enrolment is the commit point: a DNS that could not be written is
// reported to the owner, never rolled back. Nobody else can see that
// report — the box's console is not the owner's Telegram — so the brain
// must send it.
describe("the DNS failure reaches the owner", () => {
  const ZONE = "zone-dns-owner-1";
  const TOKEN = "cf-dns-token-owner-9";
  const CODE = "owner-code-abc-123";
  const NOW = 1700000100;

  // A Cloudflare that answers every call with an empty zone: the brain
  // writes the records and says "ok".
  function workingFetcher(): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ success: true, result: [], result_info: { total_pages: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  }

  // A Cloudflare that refuses every write: the brain could not write the
  // records and says so.
  function refusingFetcher(): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 9109 }], result: null }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  }

  const configWith = (fetcher: typeof fetch): EnrollConfig => ({
    capSecret: CAP_TEST_KEY,
    sealKey: SEAL_KEY,
    trusted: true,
    baseUrl: "https://fleet.test",
    dns: { zoneId: ZONE, token: TOKEN, fetcher },
  });

  it("a failed DNS tells the owner once: the box is enrolled, the DNS needs them", async () => {
    const store = new MemStore();
    const rec = recorder();
    const box = await seedEnrolled(store, "own-1");
    store.putBox({ ...box, hostname: "oc-tap-own-1.buyallmemes.com", tunnel_id: "tun-own-1" });

    const res = await handleEnrollRequest(
      jsonRequest("/enroll", {
        id: "own-1",
        hostname: "oc-tap-own-1.buyallmemes.com",
        enroll_token: KNOWN_TOKEN,
      }),
      store,
      rec.notify,
      () => NOW,
      configWith(refusingFetcher()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnrolResponse;
    expect(body.dns).toMatch(/^failed:/);

    // Exactly one message, and it is about the DNS.
    expect(rec.texts).toHaveLength(1);
    const ping = rec.texts[0];
    expect(ping).toContain("own-1");
    expect(ping).toMatch(/DNS/);
    // The reason is in the message, the credential is not.
    expect(ping).toContain("403");
    expect(ping).not.toContain(TOKEN);
  });

  it("a DNS the brain wrote tells nobody", async () => {
    const store = new MemStore();
    const rec = recorder();
    const box = await seedEnrolled(store, "own-2");
    store.putBox({ ...box, hostname: "oc-tap-own-2.buyallmemes.com", tunnel_id: "tun-own-2" });

    const res = await handleEnrollRequest(
      jsonRequest("/enroll", {
        id: "own-2",
        hostname: "oc-tap-own-2.buyallmemes.com",
        enroll_token: KNOWN_TOKEN,
      }),
      store,
      rec.notify,
      () => NOW,
      configWith(workingFetcher()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnrolResponse;
    expect(body.dns).toBe("ok");
    expect(rec.texts).toHaveLength(0);
  });

  it("the claim path tells the owner once too", async () => {
    const store = new MemStore();
    const rec = recorder();
    // The brain issues the code; the box claims it with its tunnel id.
    await requestEnrollment(
      store,
      { id: "own-3", hostname: "oc-tap-own-3.buyallmemes.com", enroll_token: CODE },
      async () => {},
      () => NOW,
      configWith(refusingFetcher()),
    );
    const res = await handleEnrollRequest(
      jsonRequest("/enroll", {
        id: "own-3",
        hostname: "oc-tap-own-3.buyallmemes.com",
        enroll_token: CODE,
        tunnel_id: "tun-own-3",
      }),
      store,
      rec.notify,
      () => NOW + 60,
      configWith(refusingFetcher()),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as EnrolResponse).toMatchObject({ status: "enrolled" });
    expect(rec.texts).toHaveLength(1);
    expect(rec.texts[0]).toContain("own-3");
    expect(rec.texts[0]).toMatch(/DNS/);
  });

  it("the approve tap tells the owner once too", async () => {
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "own-4", hostname: "oc-tap-own-4.buyallmemes.com", enroll_token: CODE, tunnel_id: "tun-own-4" },
      async () => {},
      () => NOW,
      configWith(refusingFetcher()),
    );
    const link = await linkFor("approve", "own-4", NOW + 900);
    const res = await handleEnrollApprove(getRequest(link), store, configWith(refusingFetcher()), () => NOW, rec.notify);
    expect(res.status).toBe(200);
    expect((await res.json()) as EnrolResponse).toMatchObject({ status: "approved" });
    expect(rec.texts).toHaveLength(1);
    expect(rec.texts[0]).toContain("own-4");
    expect(rec.texts[0]).toMatch(/DNS/);
  });

  it("a skipped DNS is not a failure: nobody is told", async () => {
    const store = new MemStore();
    const rec = recorder();
    const box = await seedEnrolled(store, "own-5");
    // No tunnel id: the brain has nothing to point at, so it skips.
    store.putBox({ ...box, hostname: "oc-tap-own-5.buyallmemes.com", tunnel_id: "" });

    const res = await handleEnrollRequest(
      jsonRequest("/enroll", {
        id: "own-5",
        hostname: "oc-tap-own-5.buyallmemes.com",
        enroll_token: KNOWN_TOKEN,
      }),
      store,
      rec.notify,
      () => NOW,
      configWith(refusingFetcher()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnrolResponse;
    expect(body.dns).toMatch(/^skipped:/);
    expect(rec.texts).toHaveLength(0);
  });
});
