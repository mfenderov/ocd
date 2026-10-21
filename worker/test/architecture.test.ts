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
const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// The modules that may name the Durable Object.
const ALLOWED = new Set(["index.ts", "state.ts"]);

// The import of the Durable Object, in either spelling.
const IMPORTS_STATE = /from\s+["']\.\/state["']|import\(\s*["']\.\/state["']\s*\)/;

describe("the architecture", () => {
  it("no module but the transport imports the Durable Object", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      const name = path.split("/").pop() ?? path;
      if (ALLOWED.has(name)) {
        continue;
      }
      if (IMPORTS_STATE.test(source)) {
        offenders.push(name);
      }
    }
    expect(
      offenders,
      `the domain must not depend on the Durable Object: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
