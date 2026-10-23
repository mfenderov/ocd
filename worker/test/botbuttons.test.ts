import { describe, expect, it } from "vitest";
import { callbackData, fleetBoard, openButton, pairButton, parseCallback } from "../src/botbuttons";
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
  // The board is the fleet's front door: one row per box, an Open
  // button carrying the box's tap link and a Pair button asking for the
  // pairing URL. Each box's actions stay in its own row.
  it("offers Open and Pair buttons per box", () => {
    const rows = fleetBoard(
      [
        box({ id: "home" }),
        box({ id: "mac", last_seen: NOW - 3600 }),
        box({ id: "vm" }),
      ],
      new Map([
        ["home", "https://tap.example/home?t=1"],
        ["mac", "https://tap.example/mac?t=2"],
        ["vm", "https://tap.example/vm?t=3"],
      ]),
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([
      { label: "🚀 Open home", link: "https://tap.example/home?t=1" },
      { label: "🔑 Pair home", tap: "pair:home" },
    ]);
    expect(rows[1][0]).toMatchObject({ label: "🚀 Open mac" });
    expect(rows[1][1]).toMatchObject({ tap: "pair:mac" });
    expect(rows[2][0]).toMatchObject({ label: "🚀 Open vm" });
  });

  // A box with no tap link — offline, or its mint failed — keeps its
  // Pair button: the tap explains instead of minting blind.
  it("leaves a box with no link at its Pair button", () => {
    const rows = fleetBoard([box({ id: "mac", last_seen: NOW - 3600 })], new Map());

    expect(rows).toEqual([[{ label: "🔑 Pair mac", tap: "pair:mac" }]]);
  });

  it("has no buttons when no box is enrolled", () => {
    expect(fleetBoard([], new Map())).toEqual([]);
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
    for (const action of ["link", "pair", "revoke", "audit", "board"] as const) {
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

describe("the Pair button", () => {
  // The tap carries the box it acts on, so the brain knows which
  // machine to mint for.
  it("names the box the button acts on", () => {
    expect(pairButton("mac")).toEqual({ label: "🔑 Pair mac", tap: "pair:mac" });
  });
});
