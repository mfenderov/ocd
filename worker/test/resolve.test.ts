import { describe, expect, it } from "vitest";
import { boxAdapter, pairingLink } from "../src/boxapi";
import type { BoxRow } from "../src/boxes";

// A store with one box: the adapter reads the row for the pinned host,
// nothing else.
class MemStore {
  boxes = new Map<string, BoxRow>();
  getBox(id: string): BoxRow | undefined {
    return this.boxes.get(id);
  }
}

function seedBox(store: MemStore, id: string, overrides: Partial<BoxRow> = {}): void {
  store.boxes.set(id, {
    id,
    hostname: `${id}.example.com`,
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
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetcher(status: number, body: string, calls: FetchCall[]): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    calls.push({ url: url.toString(), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
}

const offlineFetcher: typeof fetch = () => Promise.reject(new Error("conn refused"));

function hangingFetcher(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "TimeoutError")));
    })) as typeof fetch;
}

const TAP = (box: string) => `https://${box}.example.com/pair?t=tok-1`;
const PAIRING = "https://oc.home.buyallmemes.com/pair/abc123";

describe("the tap's own answer", () => {
  it("reads the printed link without following the redirect", async () => {
    const store = new MemStore();
    seedBox(store, "home");
    const calls: FetchCall[] = [];

    const answer = await boxAdapter(store, { fetcher: stubFetcher(302, PAIRING, calls) }).resolvePair(
      "home",
      TAP("home"),
    );

    expect(answer).toEqual({ kind: "answered", message: { status: 302, said: PAIRING } });
    // The pinned host, the tap's path — and manual redirect, so the
    // single use is never spent in a fetch the owner never sees.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TAP("home"));
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("answers the box's refusal instead of guessing", async () => {
    const store = new MemStore();
    seedBox(store, "home");

    const answer = await boxAdapter(store, {
      fetcher: stubFetcher(410, "link already used or expired", []),
    }).resolvePair("home", TAP("home"));

    expect(answer).toEqual({
      kind: "answered",
      message: { status: 410, said: "link already used or expired" },
    });
  });

  it("reads an edge error page as a box that did not answer", async () => {
    const store = new MemStore();
    seedBox(store, "home");

    const answer = await boxAdapter(store, {
      fetcher: stubFetcher(530, "tunnel not connected", []),
    }).resolvePair("home", TAP("home"));

    expect(answer).toEqual({ kind: "silent", reason: "box_unreachable" });
  });

  it("reads the edge's plain-text error page as a box that did not answer", async () => {
    const store = new MemStore();
    seedBox(store, "home");

    const answer = await boxAdapter(store, {
      fetcher: stubFetcher(200, "error code: 1033", []),
    }).resolvePair("home", TAP("home"));

    expect(answer).toEqual({ kind: "silent", reason: "box_unreachable" });
  });

  it("is silent for a box the brain does not know", async () => {
    const store = new MemStore();

    const answer = await boxAdapter(store, {
      fetcher: stubFetcher(302, PAIRING, []),
    }).resolvePair("ghost", TAP("ghost"));

    expect(answer).toEqual({ kind: "silent", reason: "unknown_box" });
  });

  it("is silent for a box that is not enrolled", async () => {
    const store = new MemStore();
    seedBox(store, "home", { enrolled: 0 });
    const calls: FetchCall[] = [];

    const answer = await boxAdapter(store, {
      fetcher: stubFetcher(302, PAIRING, calls),
    }).resolvePair("home", TAP("home"));

    expect(answer).toEqual({ kind: "silent", reason: "unknown_box" });
    expect(calls).toEqual([]);
  });

  it("refuses a tap that points at another host instead of following it", async () => {
    const store = new MemStore();
    seedBox(store, "home");
    const calls: FetchCall[] = [];

    await expect(
      boxAdapter(store, { fetcher: stubFetcher(302, PAIRING, calls) }).resolvePair(
        "home",
        "https://evil.example/pair?t=tok-1",
      ),
    ).rejects.toThrow("refused");
    expect(calls).toEqual([]);
  });

  it("refuses a tap URL that does not parse instead of fetching it", async () => {
    const store = new MemStore();
    seedBox(store, "home");
    const calls: FetchCall[] = [];

    await expect(
      boxAdapter(store, { fetcher: stubFetcher(302, PAIRING, calls) }).resolvePair("home", "://bad"),
    ).rejects.toThrow("refused");
    expect(calls).toEqual([]);
  });

  it("reads a hang as a box timeout", async () => {
    const store = new MemStore();
    seedBox(store, "home");

    const answer = await boxAdapter(store, {
      fetcher: hangingFetcher(),
      deadlineMs: 20,
    }).resolvePair("home", TAP("home"));

    expect(answer).toEqual({ kind: "silent", reason: "box_timeout" });
  });

  it("reads a refused connection as a box that cannot be reached", async () => {
    const store = new MemStore();
    seedBox(store, "home");

    const answer = await boxAdapter(store, { fetcher: offlineFetcher }).resolvePair("home", TAP("home"));

    expect(answer).toEqual({ kind: "silent", reason: "box_unreachable" });
  });
});

describe("the pairing link out of the tap's answer", () => {
  it("reads the printed link", () => {
    expect(pairingLink(302, `${PAIRING}\n`)).toBe(PAIRING);
  });

  it("refuses another status", () => {
    expect(() => pairingLink(410, "link already used or expired")).toThrow("the tap answered 410");
  });

  it("refuses a body that is not a pairing link", () => {
    expect(() => pairingLink(302, "Unauthorized")).toThrow("no pairing link");
    expect(() => pairingLink(302, "  \n")).toThrow("no pairing link");
  });
});
