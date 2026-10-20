import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runCommand, type AuditRow, type CommandDeps, type LinkRecord } from "../src/botcommands";
import type { RevokeResult } from "../src/revoke";
import type { BoxPublic } from "../src/state";
import type { TelegramClient } from "../src/telegram";
import { inState } from "./helpers";

// One row of the fleet's history, the shape the brain's audit answers with.
const AUDIT_ROW: AuditRow = {
  box: "home",
  at: 1699999900,
  actor: "owner",
  action: "tapped",
  device: "dev",
  ip: "1.2.3.4",
  result: "ok",
  ua: "Mozilla/5.0",
  tainted: false,
};

// A box that could not be read: the marker row, not an event.
const AUDIT_ERROR_ROW: AuditRow = {
  box: "mac",
  at: 1699999901,
  actor: "",
  action: "",
  device: "",
  ip: "",
  result: "",
  ua: "",
  tainted: true,
  error: "box_timeout",
};

// The keyboard the brain sent, as Telegram reads it.
interface RecordedMarkup {
  inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

// The command layer owns every reply, so the client is the seam the tests
// watch: it records what the brain would have sent to Telegram.
class RecordingTelegram implements TelegramClient {
  readonly sent: Array<{ chatId: number; text: string; markup?: RecordedMarkup }> = [];
  readonly answered: string[] = [];

  async sendMessage(chatId: number, text: string, opts?: { replyMarkup?: unknown }): Promise<{ message_id: number }> {
    this.sent.push({ chatId, text, markup: opts?.replyMarkup as RecordedMarkup | undefined });
    return { message_id: this.sent.length };
  }

  async editMessageText(): Promise<boolean> {
    return true;
  }

  async answerCallbackQuery(callbackId: string): Promise<void> {
    this.answered.push(callbackId);
  }

  async setWebhook(): Promise<void> {}
}

// The deps the command layer is a pure function of: every fleet read is
// recorded, so a test can assert what the command asked for.
interface Calls {
  mintLink: string[];
  audit: Array<{ boxId: string; limit: number }>;
  revoke: string[];
  revokeAll: number;
  issueEnrollCode: string[];
  boxStatus: string[];
  recorded: LinkRecord[];
}

// What the fleet answers with. The harness always records the calls, so a
// test never has to trade the recording for a canned answer.
interface HarnessOptions {
  boxes?: BoxPublic[];
  auditRows?: AuditRow[];
  revokeResult?: RevokeResult;
  revokeAllResults?: RevokeResult[];
  primaryBox?: string;
  // The fleet read that fails: the command layer must survive it.
  listBoxesFails?: Error;
  // The mint that fails: a tap must still be answered.
  mintFails?: Error;
}

function harness(options: HarnessOptions = {}): {
  deps: CommandDeps;
  telegram: RecordingTelegram;
  calls: Calls;
} {
  const telegram = new RecordingTelegram();
  const calls: Calls = {
    mintLink: [],
    audit: [],
    revoke: [],
    revokeAll: 0,
    issueEnrollCode: [],
    boxStatus: [],
    recorded: [],
  };
  const deps: CommandDeps = {
    telegram,
    listBoxes: () => {
      if (options.listBoxesFails) {
        throw options.listBoxesFails;
      }
      return options.boxes ?? [];
    },
    mintLink: async (boxId) => {
      calls.mintLink.push(boxId);
      if (options.mintFails) {
        throw options.mintFails;
      }
      return "https://tap.example/?t=tok-1";
    },
    audit: async (boxId, limit) => {
      calls.audit.push({ boxId, limit });
      return options.auditRows ?? [];
    },
    revoke: async (boxId) => {
      calls.revoke.push(boxId);
      return options.revokeResult ?? { id: boxId, status: "revoked", epoch: 2 };
    },
    revokeAll: async () => {
      calls.revokeAll += 1;
      return options.revokeAllResults ?? [];
    },
    issueEnrollCode: async (boxId) => {
      calls.issueEnrollCode.push(boxId);
      return { code: "CODE", command: `ocd onboard ${boxId} CODE` };
    },
    boxStatus: async (boxId) => {
      calls.boxStatus.push(boxId);
      return "service=http://127.0.0.1:49374 remote=? devices=2 mints24h=5";
    },
    recordLink: (link) => {
      calls.recorded.push(link);
    },
    primaryBox: options.primaryBox ?? "home",
  };
  return { deps, telegram, calls };
}

function box(overrides: Partial<BoxPublic> & { id: string }): BoxPublic {
  return {
    hostname: `oc-tap-${overrides.id}.buyallmemes.com`,
    epoch: 1,
    last_seq: 1,
    last_ts: 0,
    last_seen: Math.floor(Date.now() / 1000) - 10,
    enrolled: 1,
    tombstoned: false,
    ...overrides,
  };
}

describe("/fleet", () => {
  it("names every box and says which one is offline", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { deps, telegram } = harness({
      boxes: [
        box({ id: "home", last_seen: now - 10 }),
        box({ id: "mac", epoch: 2, last_seen: now - 3600 }),
      ],
    });

    await runCommand({ name: "/fleet", args: [], chatId: 7 }, deps);

    expect(telegram.sent).toHaveLength(1);
    const text = telegram.sent[0].text;
    expect(text).toContain("home");
    expect(text).toContain("mac");
    expect(text).toContain("offline");
    expect(text).toContain("ok");
  });

  it("says so when no box is enrolled", async () => {
    const { deps, telegram } = harness({ boxes: [] });

    await runCommand({ name: "/fleet", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain("No boxes");
  });

  it("reads the @botname suffix a group chat adds", async () => {
    const { deps, telegram } = harness({ boxes: [box({ id: "home" })] });

    await runCommand({ name: "/fleet@ocd_fleet_bot", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain("home");
  });

  it("marks a box whose revoke is pending", async () => {
    const { deps, telegram } = harness({
      boxes: [box({ id: "mac", tombstoned: true })],
    });

    await runCommand({ name: "/fleet", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain("tombstoned");
  });
});

describe("/link", () => {
  it("shows the menu of boxes", async () => {
    const { deps, telegram } = harness({ boxes: [box({ id: "home" })] });

    await runCommand({ name: "/link", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain("home");
    // The menu: one button per box.
    expect(telegram.sent[0].markup?.inline_keyboard?.[0]).toHaveLength(1);
  });
});

describe("the keyboards", () => {
  it("rides the board under the fleet's text", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { deps, telegram } = harness({
      boxes: [box({ id: "home", last_seen: now - 10 }), box({ id: "mac", last_seen: now - 3600 })],
    });

    await runCommand({ name: "/fleet", args: [], chatId: 7 }, deps);

    const keyboard = telegram.sent[0].markup?.inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard?.[0]).toHaveLength(2);
    // Every button names the box it acts on.
    expect(keyboard?.[0][0].callback_data).toBe("link:home");
    expect(keyboard?.[0][1].callback_data).toBe("link:mac");
    // The offline box is marked, not hidden.
    expect(keyboard?.[0][1].text).toContain("🔴");
  });

  it("sends no keyboard when no box is enrolled", async () => {
    const { deps, telegram } = harness({ boxes: [] });

    await runCommand({ name: "/fleet", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].markup).toBeUndefined();
  });

  // The board's label and the fleet's text read one clock and one rule,
  // so they can never call the same box ok and offline.
  it("labels a box the way the text reads it", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { deps, telegram } = harness({
      boxes: [box({ id: "home", last_seen: now - 10 }), box({ id: "mac", last_seen: now - 3600 })],
    });

    await runCommand({ name: "/fleet", args: [], chatId: 7 }, deps);

    const text = telegram.sent[0].text;
    const labels = telegram.sent[0].markup?.inline_keyboard?.[0].map((button) => button.text) ?? [];
    expect(text).toContain("ok");
    expect(text).toContain("offline");
    expect(labels[0]).toContain("🟢");
    expect(labels[1]).toContain("🔴");
  });
});

describe("/flink", () => {
  it("mints a link for the box and replies with the URL", async () => {
    const { deps, telegram, calls } = harness();

    await runCommand({ name: "/flink", args: ["mac"], chatId: 7 }, deps);

    expect(calls.mintLink).toEqual(["mac"]);
    expect(telegram.sent[0].text).toContain("https://tap.example/?t=tok-1");
    expect(telegram.sent[0].text).toContain("mac");
  });

  it("shows the usage when no box is named", async () => {
    const { deps, telegram, calls } = harness();

    await runCommand({ name: "/flink", args: [], chatId: 7 }, deps);

    expect(calls.mintLink).toEqual([]);
    expect(telegram.sent[0].text).toContain("/flink");
  });
});

describe("/login", () => {
  it("mints for the primary box", async () => {
    const { deps, telegram, calls } = harness({ primaryBox: "mac" });

    await runCommand({ name: "/login", args: [], chatId: 7 }, deps);

    expect(calls.mintLink).toEqual(["mac"]);
    expect(telegram.sent[0].text).toContain("https://tap.example/?t=tok-1");
    expect(telegram.sent[0].text).toContain("OpenCode ready");
  });
});

describe("/faudit", () => {
  it("asks for the last ten rows of the whole fleet and lists them", async () => {
    const { deps, telegram, calls } = harness({ auditRows: [AUDIT_ROW] });

    await runCommand({ name: "/faudit", args: [], chatId: 7 }, deps);

    expect(calls.audit).toEqual([{ boxId: "", limit: 10 }]);
    const text = telegram.sent[0].text;
    expect(text).toContain("Audit");
    expect(text).toContain("tapped");
    expect(text).toContain("home");
    expect(text).toContain("1.2.3.4");
  });

  it("lists a box that could not be read as an error row", async () => {
    const { deps, telegram } = harness({ auditRows: [AUDIT_ERROR_ROW] });

    await runCommand({ name: "/faudit", args: ["mac"], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain("error");
    expect(telegram.sent[0].text).toContain("mac");
  });

  it("says so when there is no history", async () => {
    const { deps, telegram } = harness({ auditRows: [] });

    await runCommand({ name: "/faudit", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain("No audit rows");
  });

  it("marks a row whose revoke is pending", async () => {
    const { deps, telegram } = harness({
      auditRows: [{ ...AUDIT_ROW, tainted: true }],
    });

    await runCommand({ name: "/faudit", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain("revoke pending");
  });
});

describe("/frevoke", () => {
  it("revokes the box and reports the outcome", async () => {
    const { deps, telegram, calls } = harness({
      revokeResult: { id: "mac", status: "revoked", epoch: 2 },
    });

    await runCommand({ name: "/frevoke", args: ["mac", "YES"], chatId: 7 }, deps);

    expect(calls.revoke).toEqual(["mac"]);
    expect(telegram.sent[0].text).toContain("mac");
    expect(telegram.sent[0].text).toContain("revoked");
  });

  it("asks for the YES before it revokes anything", async () => {
    const { deps, telegram, calls } = harness();

    await runCommand({ name: "/frevoke", args: ["mac"], chatId: 7 }, deps);

    expect(calls.revoke).toEqual([]);
    expect(telegram.sent[0].text).toContain("/frevoke mac YES");
  });
});

describe("/fnuke", () => {
  it("revokes every box and counts the outcomes", async () => {
    const { deps, telegram, calls } = harness({
      revokeAllResults: [
        { id: "home", status: "revoked", epoch: 2 },
        { id: "mac", status: "tombstoned", epoch: 3, detail: "box_unreachable" },
      ],
    });

    await runCommand({ name: "/fnuke", args: ["YES"], chatId: 7 }, deps);

    expect(calls.revokeAll).toBe(1);
    const text = telegram.sent[0].text;
    expect(text).toContain("1 revoked");
    expect(text).toContain("1 blocked");
    expect(text).toContain("home");
    expect(text).toContain("mac");
  });

  it("asks for the YES before it nukes anything", async () => {
    const { deps, telegram, calls } = harness();

    await runCommand({ name: "/fnuke", args: [], chatId: 7 }, deps);

    expect(calls.revokeAll).toBe(0);
    expect(telegram.sent[0].text).toContain("/fnuke YES");
  });
});

describe("/enrollcode", () => {
  it("issues a code and replies with the paste-ready command", async () => {
    const { deps, telegram, calls } = harness();

    await runCommand({ name: "/enrollcode", args: ["mac"], chatId: 7 }, deps);

    expect(calls.issueEnrollCode).toEqual(["mac"]);
    const text = telegram.sent[0].text;
    expect(text).toContain("mac");
    expect(text).toContain("ocd onboard mac CODE");
  });

  it("shows the usage when no box is named", async () => {
    const { deps, telegram, calls } = harness();

    await runCommand({ name: "/enrollcode", args: [], chatId: 7 }, deps);

    expect(calls.issueEnrollCode).toEqual([]);
    expect(telegram.sent[0].text).toContain("/enrollcode");
  });
});

describe("/status", () => {
  it("relays the primary box's status", async () => {
    const { deps, telegram, calls } = harness({ primaryBox: "mac" });

    await runCommand({ name: "/status", args: [], chatId: 7 }, deps);

    expect(calls.boxStatus).toEqual(["mac"]);
    expect(telegram.sent[0].text).toContain("service=http://127.0.0.1:49374");
  });
});

describe("the taps", () => {
  it("mints for the box the tap names and answers the tap", async () => {
    const { deps, telegram, calls } = harness();

    await runCommand({ name: "link", args: ["mac"], chatId: 7, callbackId: "cb-1" }, deps);

    expect(calls.mintLink).toEqual(["mac"]);
    // The tap is answered, so the button never spins.
    expect(telegram.answered).toEqual(["cb-1"]);
    // The link rides the Open button, never the visible text.
    expect(telegram.sent[0].text).toContain("mac");
    expect(telegram.sent[0].markup?.inline_keyboard?.[0][0].url).toBe("https://tap.example/?t=tok-1");
  });

  it("explains an offline box instead of minting", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { deps, telegram, calls } = harness({ boxes: [box({ id: "mac", last_seen: now - 3600 })] });

    await runCommand({ name: "link", args: ["mac"], chatId: 7, callbackId: "cb-2" }, deps);

    expect(calls.mintLink).toEqual([]);
    expect(telegram.sent[0].text).toContain("offline");
    expect(telegram.sent[0].text).toContain("mac");
    expect(telegram.answered).toEqual(["cb-2"]);
  });

  it("answers a tap whose command fails", async () => {
    const { deps, telegram } = harness({ mintFails: new Error("boom") });

    await runCommand({ name: "link", args: ["mac"], chatId: 7, callbackId: "cb-3" }, deps);

    expect(telegram.answered).toEqual(["cb-3"]);
    // The Go's callback wording: the link failed, not the fleet.
    expect(telegram.sent[0].text).toContain("Link failed");
    expect(telegram.sent[0].text).not.toContain("Fleet failed");
  });

  it("answers a tap for an action it does not know", async () => {
    const { deps, telegram } = harness();

    await runCommand({ name: "nope", args: ["mac"], chatId: 7, callbackId: "cb-4" }, deps);

    expect(telegram.answered).toEqual(["cb-4"]);
    expect(telegram.sent).toEqual([]);
  });

  it("shows the board again", async () => {
    const { deps, telegram } = harness({ boxes: [box({ id: "home" })] });

    await runCommand({ name: "board", args: [], chatId: 7, callbackId: "cb-2" }, deps);

    expect(telegram.sent[0].text).toContain("home");
  });

  it("asks for the YES before it revokes", async () => {
    const { deps, telegram, calls } = harness();

    await runCommand({ name: "revoke", args: ["mac"], chatId: 7, callbackId: "cb-3" }, deps);

    expect(calls.revoke).toEqual([]);
    expect(telegram.sent[0].text).toContain("/frevoke mac YES");
  });

  it("reads the audit of the box the tap names", async () => {
    const { deps, telegram, calls } = harness({ auditRows: [AUDIT_ROW] });

    await runCommand({ name: "audit", args: ["mac"], chatId: 7, callbackId: "cb-4" }, deps);

    expect(calls.audit).toEqual([{ boxId: "mac", limit: 10 }]);
    expect(telegram.sent[0].text).toContain("Audit");
  });
});

describe("the edges", () => {
  it("ignores an unknown command", async () => {
    const { deps, telegram } = harness();

    await runCommand({ name: "/nope", args: [], chatId: 7 }, deps);

    expect(telegram.sent).toEqual([]);
  });

  it("answers a failure instead of throwing at the dispatch", async () => {
    const { deps, telegram } = harness({ listBoxesFails: new Error("boom <b> & </b>") });

    await expect(runCommand({ name: "/fleet", args: [], chatId: 7 }, deps)).resolves.toBeUndefined();

    expect(telegram.sent[0].text).toContain("Fleet failed");
    // The message is HTML: the error's own markup is escaped.
    expect(telegram.sent[0].text).toContain("boom &lt;b&gt; &amp; &lt;/b&gt;");
  });
});

describe("the link registry", () => {
  it("records the link a tap handed out, with the message it rides on", async () => {
    const { deps, calls } = harness();

    await runCommand({ name: "link", args: ["mac"], chatId: 7 }, deps);

    expect(calls.recorded).toEqual([{ token: "tok-1", box: "mac", chatId: 7, messageId: 1 }]);
  });

  it("records the link /flink handed out", async () => {
    const { deps, calls } = harness();

    await runCommand({ name: "/flink", args: ["home"], chatId: 7 }, deps);

    expect(calls.recorded).toEqual([{ token: "tok-1", box: "home", chatId: 7, messageId: 1 }]);
  });

  it("records the link /login handed out, for the primary box", async () => {
    const { deps, calls } = harness({ primaryBox: "mac" });

    await runCommand({ name: "/login", args: [], chatId: 7 }, deps);

    expect(calls.recorded).toEqual([{ token: "tok-1", box: "mac", chatId: 7, messageId: 1 }]);
  });

  it("records nothing when the reply carries no link", async () => {
    const { deps, calls } = harness();

    await runCommand({ name: "/fleet", args: [], chatId: 7 }, deps);

    expect(calls.recorded).toEqual([]);
  });
});

describe("the Durable Object's dispatch", () => {
  it("answers /fleet from the DO's own state", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-commands"));
    const telegram = new RecordingTelegram();

    await inState(stub, async (instance) => {
      instance.putBox({
        id: "home",
        hostname: "oc-tap-home.buyallmemes.com",
        heartbeat_token_hash: "hb-hash",
        admin_token_hash: "admin-hash",
        admin_token_sealed: "",
        epoch: 1,
        last_seq: 1,
        last_ts: 0,
        last_seen: Math.floor(Date.now() / 1000) - 5,
        enrolled: 1,
      });

      await instance.dispatchCommand({ name: "/fleet", args: [], chatId: 7 }, telegram);
    });

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].text).toContain("home");
  });

  // The brain's own history, not the boxes: the answer covers the boxes
  // that are offline and the ones that were replaced.
  it("answers /faudit from the brain's own history", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-commands-audit"));
    const telegram = new RecordingTelegram();

    await inState(stub, async (instance) => {
      instance.putBox({
        id: "home",
        hostname: "oc-tap-home.buyallmemes.com",
        heartbeat_token_hash: "hb-hash",
        admin_token_hash: "admin-hash",
        admin_token_sealed: "",
        epoch: 1,
        last_seq: 1,
        last_ts: 0,
        last_seen: Math.floor(Date.now() / 1000) - 5,
        enrolled: 1,
      });
      instance.addAuditRow({
        box: "home",
        at: 1699999900,
        actor: "web:1.2.3.4",
        action: "tapped",
        device: "",
        ip: "1.2.3.4",
        result: "ok",
        ua: "",
        token: "",
      });

      await instance.dispatchCommand({ name: "/faudit", args: [], chatId: 7 }, telegram);
    });

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].text).toContain("tapped");
    expect(telegram.sent[0].text).toContain("home");
    expect(telegram.sent[0].text).toContain("1.2.3.4");
  });
});
