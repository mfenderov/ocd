import { describe, expect, it } from "vitest";

// The layers point inward: the domain must not depend on the Durable
// Object. The Durable Object is the application's layer — the brain's
// tables, its routes, its alarm. The domain (the audit relay, the
// enrolment, the bot's command layer) must speak about boxes, not about
// the object that stores them.
//
// Only two modules may name it: the transport (index.ts), which wires
// the Durable Object up, and the Durable Object itself.
//
// The second rule points the other way: the domain must not depend on
// an outbound adapter either. The domain says what it needs — "tell
// the owner this", "point these two names at this tunnel", "ask this
// box for its status" — and the ports module (ports.ts) holds those
// needs. The adapters (telegram.ts, dns.ts, boxapi.ts) provide them,
// and the wiring (state.ts) hands one to the other. A domain module
// that reaches for an adapter has the arrow backwards again.
//
// The sources are read as text: the Workers runtime has no filesystem,
// so the build inlines them.
const sources = import.meta.glob<string>("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

// The modules that may name the Durable Object. The whole path, not the
// base name: a module that happens to be called state.ts somewhere else
// is not the Durable Object.
const ALLOWED = new Set(["../src/index.ts", "../src/state.ts"]);

// The import of the Durable Object, in either spelling.
const IMPORTS_STATE = /from\s+["']\.\/state["']|import\(\s*["']\.\/state["']\s*\)/;

// The outbound adapters: the modules that speak to the outside world
// (Telegram, Cloudflare's DNS, the boxes). The domain names its needs
// in ports.ts; these provide them.
const ADAPTERS = ["telegram", "dns", "boxapi"];

// The modules that may name an adapter: the transport (index.ts), the
// composition root (state.ts) and the route table (routes.ts). The
// composition root is where the concrete adapters are created and
// handed to the domain — that is its whole job.
const MAY_NAME_ADAPTER = new Set(["../src/index.ts", "../src/state.ts", "../src/routes.ts"]);

// The import of one adapter, in either spelling.
function importsAdapter(source: string, adapter: string): boolean {
  return new RegExp(`from\\s+["']\\./${adapter}["']|import\\(\\s*["']\\./${adapter}["']\\s*\\)`).test(source);
}

describe("the architecture", () => {
  it("the glob found the tree it checks", () => {
    // A glob that resolves to nothing would leave the rule below with
    // nothing to check, and it would pass without checking anything.
    const paths = Object.keys(sources);
    expect(paths.length).toBeGreaterThan(0);
    for (const allowed of ALLOWED) {
      expect(paths, "the glob must find the tree it checks").toContain(allowed);
    }
    for (const adapter of ADAPTERS) {
      expect(paths, "the glob must find the tree it checks").toContain(`../src/${adapter}.ts`);
    }
  });

  it("no module but the transport imports the Durable Object", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (ALLOWED.has(path)) {
        continue;
      }
      if (IMPORTS_STATE.test(source)) {
        offenders.push(path);
      }
    }
    expect(
      offenders,
      `the domain must not depend on the Durable Object: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("no domain module imports an outbound adapter", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (MAY_NAME_ADAPTER.has(path)) {
        continue;
      }
      for (const adapter of ADAPTERS) {
        if (importsAdapter(source, adapter)) {
          offenders.push(`${path} imports ${adapter}`);
        }
      }
    }
    expect(
      offenders,
      `the domain must not depend on an adapter: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
