import { describe, expect, it } from "vitest";
import {
  backButton,
  boardFooter,
  boxButton,
  boxView,
  callbackData,
  enrollPromptButtons,
  fleetBoard,
  nukeConfirmButtons,
  openButton,
  pairButton,
  parseCallback,
  revokeConfirmButtons,
} from "../src/botbuttons";
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
  // button carrying the box's tap link, a Pair button asking for the
  // pairing URL, and the box itself opening its view — then the footer's
  // row. Each box's actions stay in its own row.
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

    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual([
      { label: "🚀 Open home", link: "https://tap.example/home?t=1" },
      { label: "🔑 Pair home", tap: "pair:home" },
      { label: "📦 home", tap: "box:home" },
    ]);
    expect(rows[1][0]).toMatchObject({ label: "🚀 Open mac" });
    expect(rows[1][1]).toMatchObject({ tap: "pair:mac" });
    expect(rows[2][0]).toMatchObject({ label: "🚀 Open vm" });
    expect(rows[3][0]).toMatchObject({ label: "🕘 History" });
  });

  // A box with no tap link — offline, or its mint failed — keeps its
  // Pair button and its box button: the tap explains instead of minting
  // blind, and the view still opens.
  it("leaves a box with no link at its Pair and box buttons", () => {
    const rows = fleetBoard([box({ id: "mac", last_seen: NOW - 3600 })], new Map());

    expect(rows).toEqual([
      [
        { label: "🔑 Pair mac", tap: "pair:mac" },
        { label: "📦 mac", tap: "box:mac" },
      ],
      [
        { label: "🕘 History", tap: "audit:" },
        { label: "＋ Box", tap: "enroll:" },
        { label: "☠️ Nuke", tap: "nuke:" },
        { label: "❓ Help", tap: "help:" },
      ],
    ]);
  });

  it("carries only the footer when no box is enrolled", () => {
    expect(fleetBoard([], new Map())).toEqual([
      [
        { label: "🕘 History", tap: "audit:" },
        { label: "＋ Box", tap: "enroll:" },
        { label: "☠️ Nuke", tap: "nuke:" },
        { label: "❓ Help", tap: "help:" },
      ],
    ]);
  });
});

describe("the board's footer", () => {
  // The footer is the board's last row: the global actions live on the
  // board, not in typed commands.
  it("carries History, Box, Nuke and Help", () => {
    expect(boardFooter()).toEqual([
      [
        { label: "🕘 History", tap: "audit:" },
        { label: "＋ Box", tap: "enroll:" },
        { label: "☠️ Nuke", tap: "nuke:" },
        { label: "❓ Help", tap: "help:" },
      ],
    ]);
  });

  it("rides under the per-box rows, even when no box is enrolled", () => {
    const rows = fleetBoard([], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toMatchObject({ label: "🕘 History" });
  });

  it("rides under the per-box rows", () => {
    const rows = fleetBoard(
      [box({ id: "home" }), box({ id: "mac" })],
      new Map([
        ["home", "https://tap.example/home?t=1"],
        ["mac", "https://tap.example/mac?t=2"],
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toMatchObject({ label: "🚀 Open home" });
    expect(rows[1][0]).toMatchObject({ label: "🚀 Open mac" });
    expect(rows[2][0]).toMatchObject({ label: "🕘 History" });
  });
});

describe("the box button", () => {
  // Every box row ends in the box itself: tapping it opens that box's
  // view. It is appended, so the Open and Pair buttons keep their
  // places.
  it("names the box and taps its view", () => {
    expect(boxButton("mac")).toEqual({ label: "📦 mac", tap: "box:mac" });
  });

  it("rides last in the box's row", () => {
    const rows = fleetBoard([box({ id: "home" })], new Map([["home", "https://tap.example/home?t=1"]]));
    expect(rows[0][2]).toEqual({ label: "📦 home", tap: "box:home" });
  });
});

describe("the box view", () => {
  // One box's actions: its Open and Pair buttons, its Status and
  // Revoke buttons, and the Back button that returns to the board.
  it("shows the box's actions with a Back button", () => {
    const rows = boxView(box({ id: "home" }), "https://tap.example/home?t=1");
    // The first row is the box's own row, as on the board — the view
    // header names the box, so no box button rides here.
    expect(rows[0]).toEqual([
      { label: "🚀 Open home", link: "https://tap.example/home?t=1" },
      { label: "🔑 Pair home", tap: "pair:home" },
    ]);
    expect(rows[1]).toEqual([
      { label: "📊 Status home", tap: "status:home" },
      { label: "🗑 Revoke home", tap: "rask:home" },
    ]);
    expect(rows[2]).toEqual([backButton()]);
  });

  it("keeps Pair, Status, Revoke and Back when the box has no link", () => {
    const rows = boxView(box({ id: "mac", last_seen: NOW - 3600 }), undefined);
    expect(rows[0]).toEqual([{ label: "🔑 Pair mac", tap: "pair:mac" }]);
    expect(rows[1]).toHaveLength(2);
    expect(rows[2]).toEqual([{ label: "‹ Back", tap: "board:" }]);
  });
});

describe("the confirm views", () => {
  it("asks YES or Cancel before revoking one box, back to its view", () => {
    expect(revokeConfirmButtons("mac")).toEqual([
      [
        { label: "YES", tap: "ryes:mac" },
        { label: "Cancel", tap: "box:mac" },
      ],
    ]);
  });

  it("asks YES or Cancel before the nuke, back to the board", () => {
    expect(nukeConfirmButtons()).toEqual([
      [
        { label: "YES", tap: "nukeyes:" },
        { label: "Cancel", tap: "board:" },
      ],
    ]);
  });

  it("cancels the enroll prompt", () => {
    expect(enrollPromptButtons()).toEqual([[{ label: "Cancel", tap: "encancel:" }]]);
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

  it("reads the board's new taps back", () => {
    for (const action of [
      "box",
      "status",
      "rask",
      "ryes",
      "nuke",
      "nukeyes",
      "help",
      "enroll",
      "encancel",
    ] as const) {
      expect(parseCallback(callbackData(action, "mac"))).toEqual({ action, boxId: "mac" });
    }
    expect(parseCallback(callbackData("audit", ""))).toEqual({ action: "audit", boxId: "" });
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
