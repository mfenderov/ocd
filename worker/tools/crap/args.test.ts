import { describe, expect, it } from "vitest";
import { DEFAULT_MAX, parseArgs } from "./args.ts";

describe("arguments", () => {
  it("reads the coverage report and the threshold", () => {
    const options = parseArgs(["-c", "cov.json", "-max", "12"]);
    expect(options.coverage).toBe("cov.json");
    expect(options.max).toBe(12);
  });

  it("defaults the threshold", () => {
    expect(parseArgs(["-c", "cov.json"]).max).toBe(DEFAULT_MAX);
  });

  it("reads the verbose flag", () => {
    expect(parseArgs(["-c", "cov.json", "-v"]).verbose).toBe(true);
  });

  it("collects the exclusions", () => {
    const options = parseArgs(["-c", "cov.json", "--exclude", "a.ts", "--exclude", "b.ts"]);
    expect(options.exclude).toEqual(["a.ts", "b.ts"]);
  });

  it("refuses to run without a coverage report", () => {
    expect(() => parseArgs([])).toThrow(/coverage/);
  });

  it("refuses a threshold that is not a number", () => {
    expect(() => parseArgs(["-c", "cov.json", "-max", "many"])).toThrow(/number/);
  });

  it("refuses an argument it does not know", () => {
    expect(() => parseArgs(["-c", "cov.json", "--wat"])).toThrow(/unknown/);
  });
});
