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

// The import of a module, in either spelling: a value, a type, a
// dynamic import. A type import is an import too — the cycle it closes
// is a cycle in the code, whatever the compiler erases.
const IMPORTS = /(?:\bfrom|\bimport)\s*\(?\s*["']\.\/([\w-]+)["']/g;

// The import graph of the brain's own modules: every module, and the
// modules it names.
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [path, source] of Object.entries(sources)) {
    const named = new Set<string>();
    for (const match of source.matchAll(IMPORTS)) {
      named.add(`../src/${match[1]}.ts`);
    }
    graph.set(path, [...named]);
  }
  return graph;
}

// The modules a module can reach, directly or through others.
function reachable(graph: Map<string, string[]>, from: string): Set<string> {
  const seen = new Set<string>();
  const queue = [...(graph.get(from) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    queue.push(...(graph.get(node) ?? []));
  }
  return seen;
}

// The shortest path from one module to another.
function pathTo(graph: Map<string, string[]>, from: string, to: string): string[] | undefined {
  const queue: string[][] = [[from]];
  const seen = new Set<string>([from]);
  while (queue.length > 0) {
    const path = queue.shift() as string[];
    for (const next of graph.get(path[path.length - 1]) ?? []) {
      if (next === to) {
        return [...path, next];
      }
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return undefined;
}

// The cycle's name: the same cycle read from another module is the same
// cycle.
function cycleName(cycle: string[]): string {
  const names = cycle.slice(0, -1);
  let smallest = 0;
  for (let i = 1; i < names.length; i++) {
    if (names[i] < names[smallest]) {
      smallest = i;
    }
  }
  return [...names.slice(smallest), ...names.slice(0, smallest)].join(" -> ");
}

// Every cycle in the graph, each one named by the modules it goes
// through.
//
// Two modules that import each other are really one module, or a third
// one is missing: the fix is a module that holds what they share, not a
// re-export that leaves the cycle in place.
function findCycles(graph: Map<string, string[]>): string[][] {
  const found = new Map<string, string[]>();
  for (const [from] of graph) {
    for (const to of reachable(graph, from)) {
      if (to === from || !reachable(graph, to).has(from)) {
        continue;
      }
      const there = pathTo(graph, from, to);
      const back = pathTo(graph, to, from);
      if (!there || !back) {
        continue;
      }
      const cycle = [...there, ...back.slice(1)];
      found.set(cycleName(cycle), cycle);
    }
  }
  return [...found.values()];
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

  it("the import graph has no cycles", () => {
    const cycles = findCycles(importGraph());
    expect(
      cycles,
      `the import graph must be a tree of layers: ${cycles.map((cycle) => cycle.join(" -> ")).join(" | ")}`,
    ).toEqual([]);
  });
});
