import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runCommand, type AuditRow, type CommandDeps, type DeviceRow, type LinkRecord } from "../src/botcommands";
import type { BoxPublic, BoxRow } from "../src/boxes";
import type { AuditRow as EventAuditRow } from "../src/events";
import type { RevokeResult } from "../src/revoke";
import type { OwnerButtons, OwnerChat, SentMessage } from "../src/owner";
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

// The command layer owns every reply, so the client's seam is what the
// tests watch: it records what the brain would have said, in the brain's
// own shape — the buttons, not the Bot API's keyboard.
class RecordingTelegram implements OwnerChat {
  readonly sent: Array<{ chatId: number; text: string; buttons?: OwnerButtons }> = [];
  readonly answered: string[] = [];

  say(chatId: number, text: string, buttons?: OwnerButtons): Promise<SentMessage> {
    this.sent.push({ chatId, text, buttons });
    return Promise.resolve({ id: this.sent.length });
  }

  replace(): Promise<boolean> {
    return Promise.resolve(true);
  }

  answerTap(callbackId: string): Promise<void> {
    this.answered.push(callbackId);
    return Promise.resolve();
  }
}

// The deps the command layer is a pure function of: every fleet read is
// recorded, so a test can assert what the command asked for.
interface Calls {
  mintLink: string[];
  audit: Array<{ boxId: string; limit: number }>;
  devices: number;
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
  deviceRows?: DeviceRow[];
  revokeResult?: RevokeResult;
  revokeAllResults?: RevokeResult[];
  primaryBox?: string;
  // The fleet read that fails: the command layer must survive it.
  listBoxesFails?: Error;
  // The mint that fails: a tap must still be answered.
  mintFails?: Error;
  // The URL the mint hands out.
  mintUrl?: string;
  // The status line the box answers with.
  status?: string;
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
    devices: 0,
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
    mintLink: (boxId) => {
      calls.mintLink.push(boxId);
      if (options.mintFails) {
        return Promise.reject(options.mintFails);
      }
      return Promise.resolve(options.mintUrl ?? "https://tap.example/?t=tok-1");
    },
    audit: (boxId, limit) => {
      calls.audit.push({ boxId, limit });
      return Promise.resolve(options.auditRows ?? []);
    },
    devices: () => {
      calls.devices += 1;
      return Promise.resolve(options.deviceRows ?? []);
    },
    revoke: (boxId) => {
      calls.revoke.push(boxId);
      return Promise.resolve(options.revokeResult ?? { id: boxId, status: "revoked", epoch: 2 });
    },
    revokeAll: () => {
      calls.revokeAll += 1;
      return Promise.resolve(options.revokeAllResults ?? []);
    },
    issueEnrollCode: (boxId) => {
      calls.issueEnrollCode.push(boxId);
      return Promise.resolve({ code: "CODE", command: `ocd onboard ${boxId} CODE` });
    },
    boxStatus: (boxId) => {
      calls.boxStatus.push(boxId);
      return Promise.resolve(
        options.status ?? "service=http://127.0.0.1:49374 remote=? devices=2 mints24h=5",
      );
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

// A box in the brain's own table: the row putBox writes.
function boxRow(id: string, overrides: Partial<BoxRow> = {}): BoxRow {
  return {
    id,
    hostname: `oc-tap-${id}.buyallmemes.com`,
    heartbeat_token_hash: "hb-hash",
    admin_token_hash: "admin-hash",
    admin_token_sealed: "",
    tunnel_id: "",
    epoch: 1,
    last_seq: 1,
    last_ts: 0,
    last_seen: 0,
    enrolled: 1,
    ...overrides,
  };
}

// One row of the brain's history, as a box pushes it.
function auditRow(box: string, at: number, action: string, ip: string): EventAuditRow {
  return {
    box,
    at,
    actor: `web:${ip}`,
    action,
    device: "",
    ip,
    result: "ok",
    ua: "",
    token: "",
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
    expect(telegram.sent[0].buttons?.[0]).toHaveLength(1);
  });
});

describe("the keyboards", () => {
  it("rides the board under the fleet's text", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { deps, telegram } = harness({
      boxes: [box({ id: "home", last_seen: now - 10 }), box({ id: "mac", last_seen: now - 3600 })],
    });

    await runCommand({ name: "/fleet", args: [], chatId: 7 }, deps);

    const keyboard = telegram.sent[0].buttons;
    expect(keyboard).toHaveLength(1);
    expect(keyboard?.[0]).toHaveLength(2);
    // Every button names the box it acts on.
    expect(keyboard?.[0][0]).toMatchObject({ tap: "link:home" });
    expect(keyboard?.[0][1]).toMatchObject({ tap: "link:mac" });
    // The offline box is marked, not hidden.
    expect(keyboard?.[0][1].label).toContain("🔴");
  });

  it("sends no keyboard when no box is enrolled", async () => {
    const { deps, telegram } = harness({ boxes: [] });

    await runCommand({ name: "/fleet", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].buttons).toBeUndefined();
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
    const labels = telegram.sent[0].buttons?.[0].map((button) => button.label) ?? [];
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

  // The URL rides inside an href="…" attribute: a quote in it must not
  // end that attribute.
  it("escapes a quote in the minted URL so the href stays one attribute", async () => {
    const { deps, telegram } = harness({ mintUrl: 'https://tap.example/?t=tok"1' });

    await runCommand({ name: "/flink", args: ["mac"], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain('href="https://tap.example/?t=tok&quot;1"');
  });
});

describe("/start and /help", () => {
  it("answer with the same command list", async () => {
    const { deps, telegram } = harness({ boxes: [box({ id: "home" })] });

    await runCommand({ name: "/start", args: [], chatId: 7 }, deps);
    await runCommand({ name: "/help", args: [], chatId: 7 }, deps);

    expect(telegram.sent).toHaveLength(2);
    expect(telegram.sent[0].text).toBe(telegram.sent[1].text);
    expect(telegram.sent[0].text).toContain("/fleet");
    expect(telegram.sent[0].text).toContain("/devices");
    expect(telegram.sent[0].text).toContain("/fnuke");
  });

  it("names every command in one line each", async () => {
    const { deps, telegram } = harness();

    await runCommand({ name: "/help", args: [], chatId: 7 }, deps);

    const text = telegram.sent[0].text;
    for (const cmd of [
      "/start",
      "/help",
      "/fleet",
      "/link",
      "/flink",
      "/login",
      "/devices",
      "/faudit",
      "/audit",
      "/frevoke",
      "/revoke",
      "/fnuke",
      "/enrollcode",
      "/status",
    ]) {
      expect(text).toContain(cmd);
    }
  });
});

describe("/devices", () => {
  it("lists each tapping client with its count and last seen", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { deps, telegram, calls } = harness({
      deviceRows: [
        { ip: "1.2.3.4", ua: "Mozilla/5.0", count: 3, last: now - 10 },
        { ip: "5.6.7.8", ua: "", count: 1, last: now - 300 },
      ],
    });

    await runCommand({ name: "/devices", args: [], chatId: 7 }, deps);

    expect(calls.devices).toBe(1);
    const text = telegram.sent[0].text;
    expect(text).toContain("1.2.3.4");
    expect(text).toContain("3 taps");
    expect(text).toContain("just now");
    expect(text).toContain("5.6.7.8");
    expect(text).toContain("Mozilla/5.0");
  });

  it("says so when no client tapped yet", async () => {
    const { deps, telegram } = harness({ deviceRows: [] });

    await runCommand({ name: "/devices", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain("No taps yet");
  });

  it("escapes a client that names markup", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { deps, telegram } = harness({
      deviceRows: [{ ip: "1.2.3.4", ua: "<b>evil</b>", count: 1, last: now - 10 }],
    });

    await runCommand({ name: "/devices", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(telegram.sent[0].text).not.toContain("<b>evil</b>");
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

describe("typed /audit", () => {
  it("answers the same history /faudit answers", async () => {
    const { deps, telegram, calls } = harness({ auditRows: [AUDIT_ROW] });

    await runCommand({ name: "/audit", args: ["mac", "5"], chatId: 7 }, deps);

    expect(calls.audit).toEqual([{ boxId: "mac", limit: 5 }]);
    expect(telegram.sent[0].text).toContain("Audit");
  });
});

describe("typed /revoke", () => {
  it("says it is retired and names /fnuke, without revoking anything", async () => {
    const { deps, telegram, calls } = harness();

    await runCommand({ name: "/revoke", args: ["YES"], chatId: 7 }, deps);

    expect(calls.revoke).toEqual([]);
    expect(calls.revokeAll).toBe(0);
    const text = telegram.sent[0].text;
    expect(text).toContain("/revoke");
    expect(text).toContain("retired");
    expect(text).toContain("/fnuke");
    expect(text).toContain("credentials");
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

  // The blocked answer is its own sentence: the credentials rotate, so
  // the box gets no new link until it comes back. The detail says why,
  // when the revoke had one to give.
  it("says the box is blocked, with the reason, when the revoke left it tombstoned", async () => {
    const { deps, telegram } = harness({
      revokeResult: { id: "mac", status: "tombstoned", epoch: 3, detail: "box_unreachable" },
    });

    await runCommand({ name: "/frevoke", args: ["mac", "YES"], chatId: 7 }, deps);

    const text = telegram.sent[0].text;
    expect(text).toContain("mac");
    expect(text).toContain("blocked");
    expect(text).toContain("epoch 3");
    expect(text).toContain("box_unreachable");
  });

  it("says the box is blocked without a reason when the revoke had none", async () => {
    const { deps, telegram } = harness({
      revokeResult: { id: "mac", status: "tombstoned", epoch: 3 },
    });

    await runCommand({ name: "/frevoke", args: ["mac", "YES"], chatId: 7 }, deps);

    const text = telegram.sent[0].text;
    expect(text).toContain("blocked");
    expect(text).toContain("epoch 3");
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

  // The box's status line ends in a newline. Inside the <code> block
  // that newline ends the block, and the closing tag lands in the
  // owner's chat as plain text.
  it("trims the status line so the code block stays one block", async () => {
    const { deps, telegram } = harness({ status: "service=up remote=? devices=2 mints24h=5\n" });

    await runCommand({ name: "/status", args: [], chatId: 7 }, deps);

    expect(telegram.sent[0].text).toBe(
      "📊 <b>Status</b>\n• <code>service=up remote=? devices=2 mints24h=5</code>",
    );
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
    expect(telegram.sent[0].buttons?.[0][0]).toMatchObject({ link: "https://tap.example/?t=tok-1" });
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
        tunnel_id: "",
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

  // The owner's chat is not the brain's log: a failed relay shows the
  // status and the reason, never the Worker's raw JSON.
  it("never shows the Worker's raw JSON to the owner", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-commands-relay"));
    const telegram = new RecordingTelegram();

    await inState(stub, async (instance) => {
      instance.putBox({
        id: "home",
        hostname: "oc-tap-home.buyallmemes.com",
        heartbeat_token_hash: "hb-hash",
        admin_token_hash: "admin-hash",
        admin_token_sealed: "",
        tunnel_id: "",
        epoch: 1,
        last_seq: 1,
        last_ts: 0,
        last_seen: Math.floor(Date.now() / 1000) - 5,
        enrolled: 1,
      });
      // A box with a pending revoke: the mint relay refuses it (409).
      instance.putTombstone({ box_id: "home", epoch: 1 });

      await instance.dispatchCommand({ name: "/flink", args: ["home"], chatId: 7 }, telegram);
    });

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].text).toContain("mint failed (409)");
    expect(telegram.sent[0].text).toContain("tainted");
    // The raw JSON stays in the brain.
    expect(telegram.sent[0].text).not.toContain('{"error"');
  });

  // The brain's own history: the rows the boxes pushed. /faudit answers
  // from them, so a box that is offline — or gone for good — keeps its
  // history.
  it("answers /faudit from the brain's own history", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-commands-audit"));
    const telegram = new RecordingTelegram();

    await inState(stub, async (instance) => {
      // The offline box: enrolled, but it went dark a day ago.
      instance.putBox(boxRow("home", { last_seen: Math.floor(Date.now() / 1000) - 86_400 }));
      // The row the offline box pushed before it went dark.
      instance.addAuditRow(auditRow("home", 1699999900, "tapped", "1.2.3.4"));
      // The replaced box: it is not enrolled any more, but its row stays.
      instance.addAuditRow(auditRow("mac", 1699999800, "tapped", "5.6.7.8"));

      await instance.dispatchCommand({ name: "/faudit", args: [], chatId: 7 }, telegram);
      await instance.dispatchCommand({ name: "/faudit", args: ["mac"], chatId: 7 }, telegram);
    });

    expect(telegram.sent).toHaveLength(2);
    const all = telegram.sent[0].text;
    // Both boxes' rows: the brain reads what it stored, not what a box
    // answers now.
    expect(all).toContain("tapped");
    expect(all).toContain("1.2.3.4");
    expect(all).toContain("5.6.7.8");
    // Newest first: the home row is the later one.
    expect(all.indexOf("1.2.3.4")).toBeLessThan(all.indexOf("5.6.7.8"));
    // The fan-out's marker is gone: no box was read.
    expect(all).not.toContain("error");

    // The one box: only its rows.
    const mac = telegram.sent[1].text;
    expect(mac).toContain("mac");
    expect(mac).toContain("5.6.7.8");
    expect(mac).not.toContain("home");
  });

  // The taint is the box's state when it pushed the row: a row that
  // happened while the box's revoke was pending stays marked. The brain's
  // table is the only place that flag lives, so a row that lost it would
  // be shown as a clean row — with nothing to catch it.
  it("marks a history row whose revoke was pending when the box pushed it", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-commands-audit-taint"));
    const telegram = new RecordingTelegram();

    await inState(stub, async (instance) => {
      instance.putBox(boxRow("home", { epoch: 1 }));
      // The revoke is pending: the box's credentials are stale.
      instance.putTombstone({ box_id: "home", epoch: 1 });
      instance.addAuditRow(auditRow("home", 1699999900, "tapped", "1.2.3.4"));

      await instance.dispatchCommand({ name: "/faudit", args: [], chatId: 7 }, telegram);
    });

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].text).toContain("revoke pending");
  });

  it("answers /devices from the brain's own history", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-commands-devices"));
    const telegram = new RecordingTelegram();

    await inState(stub, async (instance) => {
      instance.putBox(boxRow("home", { last_seen: Math.floor(Date.now() / 1000) - 10 }));
      const now = 1699999900;
      instance.addAuditRow({ ...auditRow("home", now, "tapped", "1.2.3.4"), ua: "Mozilla/5.0" });
      instance.addAuditRow({ ...auditRow("home", now - 100, "consumed", "1.2.3.4"), ua: "Mozilla/5.0" });
      // A row that is not a tap is not a tapping client.
      instance.addAuditRow(auditRow("home", now - 200, "admin_denied", "9.9.9.9"));
      instance.addAuditRow(auditRow("mac", now - 300, "tapped", "5.6.7.8"));

      await instance.dispatchCommand({ name: "/devices", args: [], chatId: 7 }, telegram);
    });

    expect(telegram.sent).toHaveLength(1);
    const text = telegram.sent[0].text;
    expect(text).toContain("1.2.3.4");
    expect(text).toContain("2 taps");
    expect(text).toContain("Mozilla/5.0");
    expect(text).toContain("5.6.7.8");
    expect(text).not.toContain("9.9.9.9");
  });

  it("answers /faudit for a box with no rows", async () => {
    const stub = env.FLEET_STATE.get(env.FLEET_STATE.idFromName("fleet-commands-audit-empty"));
    const telegram = new RecordingTelegram();

    await inState(stub, async (instance) => {
      await instance.dispatchCommand({ name: "/faudit", args: ["gone"], chatId: 7 }, telegram);
    });

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].text).toContain("No audit rows");
  });
});
