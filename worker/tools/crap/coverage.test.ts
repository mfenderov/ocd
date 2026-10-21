import { describe, expect, it } from "vitest";
import { coverageFor, functionWasCalled, parseCoverage } from "./coverage.ts";

/** A coverage report with one file, two statements and two functions. */
const REPORT = JSON.stringify({
  "/src/a.ts": {
    statementMap: {
      "0": { start: { line: 1 }, end: { line: 1 } },
      "1": { start: { line: 2 }, end: { line: 2 } },
      "2": { start: { line: 5 }, end: { line: 5 } },
    },
    s: { "0": 3, "1": 0, "2": 1 },
    fnMap: {
      "0": { name: "hit", decl: { start: { line: 1 } } },
      "1": { name: "missed", decl: { start: { line: 2 } } },
    },
    f: { "0": 2, "1": 0 },
  },
});

describe("coverage", () => {
  it("reads the statements of a file", () => {
    const report = parseCoverage(REPORT);
    expect(report.get("/src/a.ts")?.statements).toHaveLength(3);
  });

  it("counts the share of a function's statements that were hit", () => {
    const report = parseCoverage(REPORT);
    expect(coverageFor(report, "/src/a.ts", "hit", 1, 1)).toBe(100);
    expect(coverageFor(report, "/src/a.ts", "missed", 2, 2)).toBe(0);
  });

  it("counts a function with one hit statement and one missed as half", () => {
    const report = parseCoverage(REPORT);
    expect(coverageFor(report, "/src/a.ts", "both", 1, 2)).toBe(50);
  });

  it("says zero for a file the report does not know", () => {
    const report = parseCoverage(REPORT);
    expect(coverageFor(report, "/src/other.ts", "x", 1, 1)).toBe(0);
  });

  it("says zero for a function with no statements", () => {
    const report = parseCoverage(REPORT);
    expect(coverageFor(report, "/src/a.ts", "empty", 90, 91)).toBe(0);
  });

  it("knows whether a function was called at all", () => {
    const report = parseCoverage(REPORT);
    expect(functionWasCalled(report, "/src/a.ts", "hit", 1)).toBe(true);
    expect(functionWasCalled(report, "/src/a.ts", "missed", 2)).toBe(false);
  });
});
