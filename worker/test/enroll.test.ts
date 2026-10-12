import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveEnrollment,
  denyEnrollment,
  enrollPingText,
  handleEnrollApprove,
  handleEnrollDeny,
  handleEnrollRequest,
  mismatchAlertText,
  parseEnrollBody,
  requestEnrollment,
  sendTelegramMessage,
  type EnrollStore,
  type NotifyFn,
  type PendingRow,
} from "../src/enroll";
import { handleHeartbeat, hashToken, tokenMatches } from "../src/heartbeat";
import app from "../src/index";
import type { BoxRow } from "../src/state";

const NEW_TOKEN = "enroll-brand-new-token-1";
const KNOWN_TOKEN = "enroll-known-token-1";
const CLONE_TOKEN = "enroll-clone-token-xyz-9";
const ADMIN_TOKEN = "enroll-admin-token-1";

class MemStore implements EnrollStore {
  boxes = new Map<string, BoxRow>();
  pending = new Map<string, PendingRow>();
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
    this.pending.set(row.id, { ...row });
  }
  deletePending(id: string): void {
    this.pending.delete(id);
  }
}

function recorder(): { texts: string[]; notify: NotifyFn } {
  const texts: string[] = [];
  const notify: NotifyFn = async (text: string) => {
    texts.push(text);
  };
  return { texts, notify };
}

async function seedEnrolled(store: MemStore, id: string): Promise<BoxRow> {
  const box: BoxRow = {
    id,
    hostname: `${id}.example.com`,
    heartbeat_token_hash: await hashToken(KNOWN_TOKEN),
    admin_token_hash: await hashToken(ADMIN_TOKEN),
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
      { id: "nb-1", hostname: "nb-1.example.com", enroll_token: NEW_TOKEN },
      rec.notify,
      () => 1700000100,
    );
    expect(result).toEqual({ status: "pending", id: "nb-1" });
    const row = store.getPending("nb-1");
    expect(row).toMatchObject({ id: "nb-1", hostname: "nb-1.example.com", first_seen: 1700000100 });
    expect(row?.heartbeat_token_hash).toBe(await hashToken(NEW_TOKEN));
    expect(row?.heartbeat_token_hash).not.toContain(NEW_TOKEN);
    expect(rec.texts).toHaveLength(1);
    expect(rec.texts[0]).toContain("nb-1");
    expect(rec.texts[0]).toContain("nb-1.example.com");
    expect(rec.texts[0]).toContain("/api/enroll/approve");
    expect(rec.texts[0]).toContain("/api/enroll/deny");
    expect(rec.texts[0]).not.toContain(NEW_TOKEN);
  });

  it("leaves an already-bound id alone: no pending row, no ping", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "bound-1");
    const rec = recorder();
    const result = await requestEnrollment(
      store,
      { id: "bound-1", hostname: "bound-1.example.com", enroll_token: KNOWN_TOKEN },
      rec.notify,
    );
    expect(result).toEqual({ status: "enrolled", id: "bound-1" });
    expect(store.getPending("bound-1")).toBeUndefined();
    expect(rec.texts).toHaveLength(0);
  });

  it("parks a known id presenting a new token (cloned-env case) as pending + ping", async () => {
    const store = new MemStore();
    await seedEnrolled(store, "clone-1");
    const rec = recorder();
    const result = await requestEnrollment(
      store,
      { id: "clone-1", hostname: "clone-1.example.com", enroll_token: CLONE_TOKEN },
      rec.notify,
    );
    expect(result).toEqual({ status: "pending", id: "clone-1" });
    expect(store.getPending("clone-1")?.heartbeat_token_hash).toBe(await hashToken(CLONE_TOKEN));
    expect(rec.texts).toHaveLength(1);
    expect(rec.texts[0]).not.toContain(CLONE_TOKEN);
  });

  it("approve binds a new id permanently: heartbeat accepted, ping text matches", async () => {
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "fresh-1", hostname: "fresh-1.example.com", enroll_token: NEW_TOKEN },
      rec.notify,
    );
    const row = await approveEnrollment(store, "fresh-1");
    expect(row).toMatchObject({ id: "fresh-1", hostname: "fresh-1.example.com", enrolled: 1 });
    expect(await tokenMatches(NEW_TOKEN, row?.heartbeat_token_hash ?? "")).toBe(true);
    expect(store.getPending("fresh-1")).toBeUndefined();
    expect(enrollPingText({ id: "fresh-1", hostname: "fresh-1.example.com" })).toBe(rec.texts[0]);
    const hb = await handleHeartbeat(heartbeatRequest("fresh-1", 1, 100, NEW_TOKEN), store, () => 1700000200);
    expect(hb.status).toBe(200);
    expect(await hb.json()).toMatchObject({ id: "fresh-1", enrolled: true });
  });

  it("approve on a known id swaps the heartbeat binding but keeps admin hash and presence", async () => {
    const store = new MemStore();
    const before = await seedEnrolled(store, "rotate-1");
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "rotate-1", hostname: "rotate-1.example.com", enroll_token: CLONE_TOKEN },
      rec.notify,
    );
    const row = await approveEnrollment(store, "rotate-1");
    expect(await tokenMatches(CLONE_TOKEN, row?.heartbeat_token_hash ?? "")).toBe(true);
    expect(await tokenMatches(KNOWN_TOKEN, row?.heartbeat_token_hash ?? "")).toBe(false);
    expect(row?.admin_token_hash).toBe(before.admin_token_hash);
    expect(row).toMatchObject({ last_seq: 11, last_ts: 5000, last_seen: 1700000000, enrolled: 1 });
    const stale = await handleHeartbeat(heartbeatRequest("rotate-1", 12, 6000, KNOWN_TOKEN), store);
    expect(stale.status).toBe(401);
  });

  it("deny drops the pending row; re-deny and late approve miss", async () => {
    const store = new MemStore();
    const rec = recorder();
    await requestEnrollment(
      store,
      { id: "deny-1", hostname: "deny-1.example.com", enroll_token: NEW_TOKEN },
      rec.notify,
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
      { hostname: "x.example.com", enroll_token: NEW_TOKEN },
      { id: "", hostname: "x.example.com", enroll_token: NEW_TOKEN },
      { id: "x", enroll_token: NEW_TOKEN },
      { id: "x", hostname: "", enroll_token: NEW_TOKEN },
      { id: "x", hostname: "https://evil.example/pwn", enroll_token: NEW_TOKEN },
      { id: "x", hostname: "evil example.com", enroll_token: NEW_TOKEN },
      { id: "x", hostname: "x.example.com" },
      { id: "x", hostname: "x.example.com", enroll_token: "" },
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
      for (const body of [{}, { id: "" }, { id: 7 }, null]) {
        const res = await handler(jsonRequest("/x", body), store);
        expect(res.status).toBe(400);
      }
    }
  });

  it("approve/deny with no pending row resolve 404, never 500", async () => {
    const store = new MemStore();
    expect((await handleEnrollApprove(jsonRequest("/enroll/approve", { id: "ghost" }), store)).status).toBe(404);
    expect(await (await handleEnrollApprove(jsonRequest("/enroll/approve", { id: "ghost" }), store)).json()).toMatchObject({
      error: "no_pending",
    });
    expect((await handleEnrollDeny(jsonRequest("/enroll/deny", { id: "ghost" }), store)).status).toBe(404);
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

describe("telegram ping (Bot API, direct fetch)", () => {
  it("posts chat_id + text to sendMessage and reports ok", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const ok = await sendTelegramMessage("bot-secret-1", "chat-1", "hello", fetcher);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botbot-secret-1/sendMessage");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ chat_id: "chat-1", text: "hello" });
  });

  it("never throws and never logs secrets on transport or API failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const apiFail = (async () => new Response("nope", { status: 429 })) as typeof fetch;
    await expect(sendTelegramMessage("bot-secret-9", "chat-9", "t", apiFail)).resolves.toBe(false);
    const netFail = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    await expect(sendTelegramMessage("bot-secret-9", "chat-9", "t", netFail)).resolves.toBe(false);
    const logged = error.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
    expect(logged).not.toContain("bot-secret-9");
    expect(logged).not.toContain("api.telegram.org");
  });
});

describe("enroll routes through the worker + DO", () => {
  function readPending(id: string): Promise<PendingRow | undefined> {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    return runInDurableObject(stub, async (instance) => instance.getPending(id));
  }

  function readBox(id: string): Promise<BoxRow | undefined> {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    return runInDurableObject(stub, async (instance) => instance.getBox(id));
  }

  it("POST /api/enroll parks a new id as pending", async () => {
    const res = await SELF.fetch("https://fleet.local/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "enr-new", hostname: "enr-new.example.com", enroll_token: NEW_TOKEN }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "pending", id: "enr-new", enrolled: false });
    expect((await readPending("enr-new"))?.hostname).toBe("enr-new.example.com");
  });

  it("POST /api/enroll/approve binds the token; heartbeat then accepted", async () => {
    await SELF.fetch("https://fleet.local/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "enr-loop", hostname: "enr-loop.example.com", enroll_token: NEW_TOKEN }),
    });
    const approve = await SELF.fetch("https://fleet.local/api/enroll/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "enr-loop" }),
    });
    expect(approve.status).toBe(200);
    expect(await approve.json()).toMatchObject({ status: "approved", id: "enr-loop", enrolled: true });
    expect(await readPending("enr-loop")).toBeUndefined();
    const box = await readBox("enr-loop");
    expect(await tokenMatches(NEW_TOKEN, box?.heartbeat_token_hash ?? "")).toBe(true);
    const hb = await SELF.fetch("https://fleet.local/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${NEW_TOKEN}` },
      body: JSON.stringify({ id: "enr-loop", seq: 1, box_now: 100, epoch: 0 }),
    });
    expect(hb.status).toBe(200);
    expect(await hb.json()).toMatchObject({ id: "enr-loop", enrolled: true });
  });

  it("POST /api/enroll/deny clears pending; second deny is 404", async () => {
    await SELF.fetch("https://fleet.local/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "enr-deny", hostname: "enr-deny.example.com", enroll_token: NEW_TOKEN }),
    });
    const deny = await SELF.fetch("https://fleet.local/api/enroll/deny", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "enr-deny" }),
    });
    expect(deny.status).toBe(200);
    expect(await deny.json()).toMatchObject({ status: "denied", id: "enr-deny" });
    expect(await readPending("enr-deny")).toBeUndefined();
    const again = await SELF.fetch("https://fleet.local/api/enroll/deny", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "enr-deny" }),
    });
    expect(again.status).toBe(404);
  });

  it("malformed enroll bodies are 400 through the route", async () => {
    const res = await SELF.fetch("https://fleet.local/api/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "enr-bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("fails loud when the FLEET_STATE binding is missing", async () => {
    for (const path of ["/api/enroll", "/api/enroll/approve", "/api/enroll/deny"]) {
      const res = await app.fetch(
        new Request(`http://x${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "x" }),
        }),
      );
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("FLEET_STATE");
    }
  });
});
