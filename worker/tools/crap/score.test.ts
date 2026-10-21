import { describe, expect, it } from "vitest";
import { crapScore, entryFor, formatReport, summarize } from "./score.ts";

describe("crap score", () => {
  it("scores a simple fully covered function as one", () => {
    expect(crapScore(1, 100)).toBe(1);
  });

  it("scores a complex untested function as its complexity squared", () => {
    expect(crapScore(10, 0)).toBe(110);
  });

  it("punishes missing coverage harder than it rewards complexity", () => {
    expect(crapScore(5, 0)).toBeGreaterThan(crapScore(5, 100));
  });

  it("keeps a well covered function cheap even when it is complex", () => {
    expect(crapScore(8, 100)).toBe(8);
  });
});

describe("entry", () => {
  it("carries the function's numbers into the entry", () => {
    const entry = entryFor(
      { name: "f", file: "/a.ts", startLine: 3, endLine: 9, complexity: 4 },
      75,
    );
    expect(entry).toMatchObject({ name: "f", line: 3, complexity: 4, coverage: 75, crap: crapScore(4, 75) });
  });
});

describe("summary", () => {
  it("counts the functions over the threshold", () => {
    const entries = [entryFor({ name: "a", file: "f", startLine: 1, endLine: 2, complexity: 1 }, 100)];
    expect(summarize(entries, 10).above).toBe(0);
    expect(summarize(entries, 0).above).toBe(1);
  });

  it("averages the scores", () => {
    const entries = [
      entryFor({ name: "a", file: "f", startLine: 1, endLine: 2, complexity: 1 }, 100),
      entryFor({ name: "b", file: "f", startLine: 1, endLine: 2, complexity: 3 }, 100),
    ];
    expect(summarize(entries, 10).average).toBe(2);
  });
});

describe("report", () => {
  const entries = [
    entryFor({ name: "risky", file: "/worker/src/a.ts", startLine: 3, endLine: 9, complexity: 10 }, 0),
    entryFor({ name: "safe", file: "/worker/src/b.ts", startLine: 1, endLine: 2, complexity: 1 }, 100),
  ];

  it("shows only the functions over the threshold", () => {
    const report = formatReport(entries, 10, false);
    expect(report).toContain("risky");
    expect(report).not.toContain("safe");
  });

  it("shows every function when asked to be verbose", () => {
    expect(formatReport(entries, 10, true)).toContain("safe");
  });

  it("ends with the summary", () => {
    expect(formatReport(entries, 10, true)).toContain("Average CRAP:");
  });
});
