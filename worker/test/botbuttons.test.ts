import { describe, expect, it } from "vitest";
import { callbackData, fleetBoard, linkMenu, openButton, parseCallback } from "../src/botbuttons";
import type { BoxPublic } from "../src/boxes";

// The clock the board reads. A fixed second, so the labels are exact:
// the board takes the clock from its caller, it does not read one of
// its own.
const NOW = 1_700_000_000;

// A box, with the fields the board reads: its id and when it was last
// seen. The rest is what the fleet always sends.
function box(overrides: Partial<BoxPublic> & { id: string }): BoxPublic {
  return {
    hostname: `oc-tap-${overrides.id}.buyallmemes.com`,
    epoch: 1,
    last_seq: 1,
    last_ts: 0,
    last_seen: NOW - 10,
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
    const rows = fleetBoard(
      [
        box({ id: "home" }),
        box({ id: "mac", last_seen: NOW - 3600 }),
        box({ id: "vm" }),
      ],
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(3);
    expect(rows[0][0].label).toContain("home");
    expect(rows[0][0].label).toContain("🟢");
    expect(rows[0][1].label).toContain("mac");
    // The offline box is marked, not hidden.
    expect(rows[0][1].label).toContain("🔴");
    expect(rows[0][2].label).toContain("vm");
    expect(rows[0][2].label).toContain("🟢");
  });

  it("marks a box whose revoke is pending", () => {
    const rows = fleetBoard([box({ id: "mac", tombstoned: true })], NOW);

    expect(rows[0][0].label).toContain("🟠");
    expect(rows[0][0].label).toContain("mac");
  });

  // The board reads the clock its caller gives it, not the wall clock:
  // the label and the fleet's text must never disagree.
  it("reads the clock it is given", () => {
    const boxes = [box({ id: "home" })];
    // Seen ten seconds before the caller's clock, so it is ok — even
    // though the wall clock says the box has been silent for years.
    expect(fleetBoard(boxes, NOW)[0][0].label).toContain("🟢");
    // The same box, read an hour later, is offline.
    expect(fleetBoard(boxes, NOW + 3600)[0][0].label).toContain("🔴");
  });

  // The button's payload names the box it acts on, so a tap knows which
  // machine it means.
  it("names the box the button acts on", () => {
    const rows = fleetBoard([box({ id: "mac" })], NOW);

    expect(rows[0][0]).toMatchObject({ tap: "link:mac" });
  });

  it("has no buttons when no box is enrolled", () => {
    expect(fleetBoard([], NOW)).toEqual([]);
  });
});

describe("the link menu", () => {
  // The Go bot sends one keyboard for /fleet and /link — "/link is the
  // menu: which machine do you want to work in?" (internal/tg/tg.go) —
  // so the menu and the board are the same buttons.
  it("offers the same boxes the board offers", () => {
    const boxes = [box({ id: "home" }), box({ id: "mac" })];

    expect(linkMenu(boxes, NOW)).toEqual(fleetBoard(boxes, NOW));
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
      label: "🚀 Open mac",
      link: "https://tap.example/?t=tok-1",
    });
  });
});
