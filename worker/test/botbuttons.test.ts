import { describe, expect, it } from "vitest";
import { callbackData, fleetBoard, linkMenu, openButton, parseCallback } from "../src/botbuttons";
import type { BoxPublic } from "../src/state";

// A box, with the fields the board reads: its id and when it was last
// seen. The rest is what the fleet always sends.
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

describe("the fleet board", () => {
  // The board is the Go bot's board (internal/tg/buttons.go): one button
  // per box, labeled with the box's state, so the owner sees which
  // machine is up without asking.
  it("offers one button per box, labeled with its state", () => {
    const now = Math.floor(Date.now() / 1000);
    const rows = fleetBoard([
      box({ id: "home", last_seen: now - 10 }),
      box({ id: "mac", last_seen: now - 3600 }),
      box({ id: "vm", last_seen: now - 10 }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(3);
    expect(rows[0][0].text).toContain("home");
    expect(rows[0][0].text).toContain("🟢");
    expect(rows[0][1].text).toContain("mac");
    // The offline box is marked, not hidden.
    expect(rows[0][1].text).toContain("🔴");
    expect(rows[0][2].text).toContain("vm");
    expect(rows[0][2].text).toContain("🟢");
  });

  it("marks a box whose revoke is pending", () => {
    const rows = fleetBoard([box({ id: "mac", tombstoned: true })]);

    expect(rows[0][0].text).toContain("🟠");
    expect(rows[0][0].text).toContain("mac");
  });

  // The button's payload names the box it acts on, so a tap knows which
  // machine it means.
  it("names the box the button acts on", () => {
    const rows = fleetBoard([box({ id: "mac" })]);

    expect(rows[0][0].callback_data).toBe("link:mac");
  });

  it("has no buttons when no box is enrolled", () => {
    expect(fleetBoard([])).toEqual([]);
  });
});

describe("the link menu", () => {
  // The Go bot sends one keyboard for /fleet and /link — "/link is the
  // menu: which machine do you want to work in?" (internal/tg/tg.go) —
  // so the menu and the board are the same buttons.
  it("offers the same boxes the board offers", () => {
    const boxes = [box({ id: "home" }), box({ id: "mac" })];

    expect(linkMenu(boxes)).toEqual(fleetBoard(boxes));
  });
});

describe("the callback data", () => {
  it("reads the action and the box", () => {
    expect(parseCallback("link:mac")).toEqual({ action: "link", boxId: "mac" });
  });

  it("reads an action that names no box", () => {
    expect(parseCallback("board:")).toEqual({ action: "board", boxId: "" });
  });

  it("refuses data that names no action", () => {
    expect(parseCallback(":mac")).toBeNull();
    expect(parseCallback("")).toBeNull();
  });

  // The encoder and the decoder are a pair: every button the brain
  // builds must read back as the action and the box it was built for.
  it("agrees with the encoder", () => {
    for (const action of ["link", "revoke", "audit", "board"] as const) {
      expect(parseCallback(callbackData(action, "mac"))).toEqual({ action, boxId: "mac" });
    }
  });
});

describe("the Open button", () => {
  // The link travels as the button's target, never as visible text.
  it("carries the link", () => {
    expect(openButton("🚀 Open mac", "https://tap.example/?t=tok-1")).toEqual({
      text: "🚀 Open mac",
      url: "https://tap.example/?t=tok-1",
    });
  });
});
