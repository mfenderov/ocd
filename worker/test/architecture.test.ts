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
// the owner this", "point these two names at this tunnel", "mint a link
// on this box" — and the ports name those needs. The adapters (the
// Telegram client, the DNS writer, the box client) provide them, and
// the wiring (state.ts) hands one to the other. A domain module that
// reaches for an adapter has the arrow backwards again.
//
// The adapters are derived from the tree, never written down by hand: a
// module that performs an outbound call is an adapter, whatever it is
// called and wherever it lives. A fifth adapter needs no edit here —
// the next run of this rule sees it.
//
// The sources are read as text: the Workers runtime has no filesystem,
// so the build inlines them.
const sources = import.meta.glob<string>("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

// The modules that may name the Durable Object, and the modules that
// may name an adapter: the transport (index.ts) and the composition
// root (state.ts). They are the wiring: they build the concrete
// adapters and hand them to the domain. The whole path, not the base
// name: a module that happens to be called state.ts somewhere else is
// not the Durable Object.
const ALLOWED = new Set(["../src/index.ts", "../src/state.ts"]);

// The Durable Object itself.
const THE_DURABLE_OBJECT = "../src/state.ts";

// One reader for every rule: the specifiers a module names — a value
// import, a type import, a dynamic import, a side-effect import, a
// re-export. The rules below must not disagree about what an import
// is, so they all read the tree this way.
const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

// A module that reaches the outside world: it calls the network. The
// rule is about what the code does, not about what the file is called,
// so a module that grows an outbound call joins the adapters on the
// next run.
const REACHES_OUT = /\b(?:fetch|fetcher)\s*\(|\btypeof\s+fetch\b/;

// The specifiers a module names.
function specifiersOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1]);
}

// The module a specifier names, as a path in the tree. A specifier
// that leaves the tree, or that names a package, names nothing this
// rule can check.
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `${parts.join("/")}.ts`;
}

// The modules a module names, as paths in the tree.
function importsOf(path: string, source: string): string[] {
  const named = new Set<string>();
  for (const specifier of specifiersOf(source)) {
    const resolved = resolveSpecifier(path, specifier);
    if (resolved !== null && resolved in sources) {
      named.add(resolved);
    }
  }
  return [...named];
}

// The adapters: the modules that perform an outbound call. Derived from
// the tree, so a new adapter is in the set without anyone naming it.
function outboundAdapters(): Set<string> {
  const found = new Set<string>();
  for (const [path, source] of Object.entries(sources)) {
    if (REACHES_OUT.test(source)) {
      found.add(path);
    }
  }
  return found;
}

// The import graph of the brain's own modules: every module, and the
// modules it names.
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [path, source] of Object.entries(sources)) {
    graph.set(path, importsOf(path, source));
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
// re-export that leaves the cycle in place. A module that imports
// itself is a cycle of one, and it is reported as one.
function findCycles(graph: Map<string, string[]>): string[][] {
  const found = new Map<string, string[]>();
  for (const [from] of graph) {
    if ((graph.get(from) ?? []).includes(from)) {
      found.set(cycleName([from, from]), [from, from]);
    }
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
    // The rule below needs adapters to find: a tree with none would
    // pass it without checking anything.
    expect(
      outboundAdapters().size,
      "the tree must hold the adapters the rule checks",
    ).toBeGreaterThan(0);
  });

  it("no module but the transport imports the Durable Object", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (ALLOWED.has(path)) {
        continue;
      }
      if (importsOf(path, source).includes(THE_DURABLE_OBJECT)) {
        offenders.push(path);
      }
    }
    expect(
      offenders,
      `the domain must not depend on the Durable Object: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("no domain module imports an outbound adapter", () => {
    const adapters = outboundAdapters();
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      // The wiring names the adapters on purpose, and an adapter may
      // lean on another adapter (the box adapter leans on the box's
      // HTTP client).
      if (ALLOWED.has(path) || adapters.has(path)) {
        continue;
      }
      for (const named of importsOf(path, source)) {
        if (adapters.has(named)) {
          offenders.push(`${path} imports ${named}`);
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
