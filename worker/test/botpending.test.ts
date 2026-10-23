import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PENDING_INPUT_TTL_SEC } from "../src/state";
import { inState, requestedUrl } from "./helpers";

// The +Box prompt's pending input: the owner's next message names the
// box. The state lives in the Durable Object next to the fleet state,
// keyed by chat, and it expires — a stale prompt must never claim a
// later unrelated message.

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

// The Bot API behind a recorder: every send answers with a message id,
// like the real API.
function stubTelegram(calls: TelegramCall[]): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestedUrl(input);
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as Record<string, unknown>;
    calls.push({ method: url.split("/").pop() ?? "", body });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

function said(calls: TelegramCall[]): string[] {
  return calls
    .filter((c) => c.method === "sendMessage")
    .map((c) => {
      const text = c.body["text"];
      return typeof text === "string" ? text : JSON.stringify(text);
    });
}

function messageUpdate(updateId: number, text: string): Request {
  return new Request("https://fleet.local/tg/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "test-webhook-secret",
    },
    body: JSON.stringify({
      update_id: updateId,
      message: { text, chat: { id: 7, type: "private" }, from: { id: 7 } },
    }),
  });
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe("the pending-input TTL", () => {
  it("is five minutes, the same order as the other timeouts", () => {
    expect(PENDING_INPUT_TTL_SEC).toBe(300);
  });
});

describe("the pending-input state", () => {
  it("round-trips one prompt per chat and clears it", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-pending-state"));
    await inState(stub, (instance) => {
      expect(instance.getPendingInput(7)).toBeUndefined();
      instance.setPendingInput(7, 1_700_000_000);
      expect(instance.getPendingInput(7)).toEqual({ chatId: 7, promptAt: 1_700_000_000 });
      instance.clearPendingInput(7);
      expect(instance.getPendingInput(7)).toBeUndefined();
      // Clearing what is not there is not an error.
      instance.clearPendingInput(7);
    });
  });
});

describe("the +Box prompt", () => {
  // The message right after the prompt names the box: the brain runs
  // the enroll-code flow for it, exactly as a typed /enrollcode would.
  // The test env carries no capability secret (by design — enroll tests
  // pin the fail-loud degraded behavior), so the flow fails loud here;
  // the consume contract is what this proves: the message was consumed
  // as a name, routed to /enrollcode, and the prompt died.
  it("consumes the next message as the box name", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    const calls: TelegramCall[] = [];
    await inState(stub, (instance) => {
      instance.setPendingInput(7, nowSec());
    });
    stubTelegram(calls);

    const res = await SELF.fetch(messageUpdate(71001, "mac"));

    expect(res.status).toBe(200);
    const texts = said(calls);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("enroll failed");
    await inState(stub, (instance) => {
      // The prompt is spent: a second message is just a message.
      expect(instance.getPendingInput(7)).toBeUndefined();
    });
  });

  // A command cancels the prompt and runs as a command instead: the
  // prompt never eats a command.
  it("cancels the prompt when the next message is a command", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    const calls: TelegramCall[] = [];
    await inState(stub, (instance) => {
      instance.setPendingInput(7, nowSec());
    });
    stubTelegram(calls);

    const res = await SELF.fetch(messageUpdate(71002, "/fleet"));

    expect(res.status).toBe(200);
    // The command ran: the fleet answered.
    expect(said(calls).join("\n")).toContain("No boxes");
    await inState(stub, (instance) => {
      expect(instance.getPendingInput(7)).toBeUndefined();
    });
  });

  // An unanswered prompt expires: a later unrelated message is just a
  // message, and the stale prompt is gone.
  it("expires the prompt after the TTL", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet"));
    const calls: TelegramCall[] = [];
    await inState(stub, (instance) => {
      instance.setPendingInput(7, nowSec() - PENDING_INPUT_TTL_SEC - 1);
    });
    stubTelegram(calls);

    const res = await SELF.fetch(messageUpdate(71003, "mac"));

    expect(res.status).toBe(200);
    // No enroll code: the stale name claimed nothing.
    expect(said(calls)).toEqual([]);
    await inState(stub, (instance) => {
      expect(instance.getPendingInput(7)).toBeUndefined();
      // The update still counts as handled: a retry stays dropped.
      expect(instance.seenUpdate(71003)).toBe(false);
    });
  });

  it("ignores a message when no prompt is armed", async () => {
    const calls: TelegramCall[] = [];
    stubTelegram(calls);

    const res = await SELF.fetch(messageUpdate(71004, "good morning"));

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
