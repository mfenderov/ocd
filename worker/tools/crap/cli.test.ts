import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.ts";

const created: string[] = [];

/** A workspace with one source file and the coverage report that goes with it. */
function workspace(): { root: string; coverage: string } {
  const root = mkdtempSync(join(tmpdir(), "crap-"));
  created.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "a.ts"),
    ["export function f() {", "  if (true) {", "    return 1;", "  }", "  return 2;", "}", ""].join("\n"),
  );
  const coverage = join(root, "coverage.json");
  writeFileSync(
    coverage,
    JSON.stringify({
      [join(root, "src", "a.ts")]: {
        statementMap: { "0": { start: { line: 2 }, end: { line: 4 } } },
        s: { "0": 0 },
      },
    }),
  );
  return { root, coverage };
}

/** The arguments that measure the workspace. */
function measure(root: string, coverage: string, ...rest: string[]): string[] {
  return ["-c", coverage, "--root", root, "--src", "src", ...rest];
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the command line", () => {
  it("refuses to run without a coverage report", () => {
    // gocrap's exit code for a command line it cannot run.
    expect(main([])).toBe(2);
  });

  it("says when the coverage report cannot be read", () => {
    expect(main(["-c", "/nowhere/cov.json"])).toBe(1);
  });

  it("fails the build when a function is over the bar", () => {
    const { root, coverage } = workspace();
    expect(main(measure(root, coverage, "-max", "1"))).toBe(1);
  });

  it("turns the gate off when the bar is zero", () => {
    const { root, coverage } = workspace();
    expect(main(measure(root, coverage, "-max", "0"))).toBe(0);
  });

  it("leaves a file out when the exclude pattern matches it", () => {
    const { root, coverage } = workspace();
    // The file is the only one there, and the pattern is a glob.
    expect(main(measure(root, coverage, "-max", "1", "--exclude", "*.ts"))).toBe(0);
  });
});
