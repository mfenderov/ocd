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

describe("the architecture", () => {
  it("the glob found the tree it checks", () => {
    // A glob that resolves to nothing would leave the rule below with
    // nothing to check, and it would pass without checking anything.
    const paths = Object.keys(sources);
    expect(paths.length).toBeGreaterThan(0);
    for (const allowed of ALLOWED) {
      expect(paths, "the glob must find the tree it checks").toContain(allowed);
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
});
