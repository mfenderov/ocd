import { describe, expect, it } from "vitest";
import { isExcluded, matchesGlob } from "./glob.ts";

describe("the glob", () => {
  it("matches a name", () => {
    expect(matchesGlob("*.ts", "a.ts")).toBe(true);
    expect(matchesGlob("*.ts", "a.js")).toBe(false);
  });

  it("matches the whole name, not a part of it", () => {
    expect(matchesGlob("a.ts", "a.ts")).toBe(true);
    expect(matchesGlob("a.ts", "ba.ts")).toBe(false);
  });

  it("never crosses a separator", () => {
    expect(matchesGlob("*.ts", "dir/a.ts")).toBe(false);
    expect(matchesGlob("*/*.ts", "dir/a.ts")).toBe(true);
    expect(matchesGlob("dir/*.ts", "dir/a.ts")).toBe(true);
  });

  it("matches one character with a question mark", () => {
    expect(matchesGlob("a?c.ts", "abc.ts")).toBe(true);
    expect(matchesGlob("a?c.ts", "ac.ts")).toBe(false);
  });

  it("matches a class of characters", () => {
    expect(matchesGlob("[ab].ts", "a.ts")).toBe(true);
    expect(matchesGlob("[a-c].ts", "b.ts")).toBe(true);
    expect(matchesGlob("[a-c].ts", "d.ts")).toBe(false);
  });

  it("matches everything a negated class does not", () => {
    expect(matchesGlob("[^a-c].ts", "d.ts")).toBe(true);
    expect(matchesGlob("[^a-c].ts", "b.ts")).toBe(false);
  });

  it("matches nothing when the pattern does not parse", () => {
    expect(matchesGlob("[abc.ts", "a.ts")).toBe(false);
    expect(matchesGlob("[]]", "]")).toBe(false);
    expect(matchesGlob("[a-]", "a")).toBe(false);
  });

  it("reads a backslash as an escape", () => {
    expect(matchesGlob("a\\*b", "a*b")).toBe(true);
    expect(matchesGlob("a\\*b", "axb")).toBe(false);
    expect(matchesGlob("\\?", "?")).toBe(true);
    expect(matchesGlob("\\?", "x")).toBe(false);
    expect(matchesGlob("[\\]]", "]")).toBe(true);
  });

  it("never crosses a separator, not even with two stars", () => {
    expect(matchesGlob("**/x.ts", "a/x.ts")).toBe(true);
    expect(matchesGlob("**/x.ts", "a/b/x.ts")).toBe(false);
  });

  it("leaves a file out when the pattern matches its path or its name", () => {
    expect(isExcluded("dir/a.ts", ["*.ts"])).toBe(true);
    expect(isExcluded("dir/a.ts", ["dir/*"])).toBe(true);
    expect(isExcluded("dir/a.ts", ["*.js"])).toBe(false);
    expect(isExcluded("dir/a.ts", [])).toBe(false);
  });
});
