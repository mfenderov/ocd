#!/usr/bin/env node
/**
 * crap — the CRAP score for TypeScript, the twin of gocrap (the Go
 * tool). The same formula, the same table, the same exit code.
 *
 *   crap -c coverage.json -max 10 [-v] [--exclude GLOB] [--root DIR]
 *
 * The coverage report is the JSON of the coverage provider
 * (`vitest run --coverage --coverage.reporter=json`). The sources are
 * the ones under <root>/src.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, type Options } from "./args.ts";
import { functionsInFile, type FunctionInfo } from "./complexity.ts";
import { coverageFor, parseCoverage, type CoverageReport } from "./coverage.ts";
import { entryFor, formatReport, type CrapEntry } from "./score.ts";

/** The source files to measure: every TypeScript file under the source directory. */
function sourceFiles(root: string, src: string, exclude: string[]): string[] {
  const dir = resolve(root, src);
  const found = readdirSync(dir, { recursive: true, encoding: "utf8" });
  return found
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .filter((name) => !name.endsWith(".d.ts"))
    .filter((name) => !exclude.some((glob) => name.includes(glob)))
    .map((name) => join(dir, name));
}

/** The functions of every source file. */
function allFunctions(root: string, src: string, exclude: string[]): FunctionInfo[] {
  return sourceFiles(root, src, exclude).flatMap((path) =>
    functionsInFile(path, readFileSync(path, "utf8")),
  );
}

/** The score of every function, with the coverage the report gives it. */
export function scoreAll(functions: FunctionInfo[], report: CoverageReport): CrapEntry[] {
  return functions.map((fn) =>
    entryFor(
      fn,
      coverageFor(report, fn.file, fn.name, fn.startLine, fn.endLine),
    ),
  );
}

/** Run the tool. Returns the exit code. */
export function main(argv: string[]): number {
  const options = parseArgs(argv);
  const entries = scoreAll(functionsInSources(options), readReport(options.coverage));
  console.log(formatReport(entries, options.max, options.verbose));
  return exitCode(entries, options.max);
}

/** The functions of the sources the options point at. */
function functionsInSources(options: Options): FunctionInfo[] {
  const root = options.root === "" ? process.cwd() : options.root;
  return allFunctions(root, options.src, options.exclude);
}

/** The coverage report, read from disk. */
function readReport(path: string): CoverageReport {
  return parseCoverage(readFileSync(path, "utf8"));
}

/** The exit code: 1 when a function is over the threshold. */
function exitCode(entries: CrapEntry[], max: number): number {
  const above = entries.filter((e) => e.crap > max).length;
  if (above > 0) {
    console.error(`FAIL: ${above} function(s) exceed max CRAP score ${max}`);
    return 1;
  }
  return 0;
}

/** The entry point, when this file is run and not imported. */
if (process.argv[1]?.endsWith("cli.ts")) {
  process.exit(main(process.argv.slice(2)));
}

/** The options a caller may want to read. */
export type { Options };
