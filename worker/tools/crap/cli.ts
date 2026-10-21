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
import { isExcluded } from "./glob.ts";
import { entryFor, formatReport, type CrapEntry } from "./score.ts";

/** The source files to measure: every TypeScript file under the source directory. */
function sourceFiles(root: string, src: string, exclude: string[]): string[] {
  const dir = resolve(root, src);
  const found = readdirSync(dir, { recursive: true, encoding: "utf8" });
  return found
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .filter((name) => !name.endsWith(".d.ts"))
    .filter((name) => !isExcluded(name, exclude))
    .map((name) => join(dir, name));
}

/** The functions of every source file. */
function allFunctions(root: string, src: string, exclude: string[]): FunctionInfo[] {
  return sourceFiles(root, src, exclude).flatMap((path) =>
    functionsInFile(path, readFileSync(path, "utf8")),
  );
}

/** The score of every function, with the coverage the report gives it. */
function scoreAll(functions: FunctionInfo[], report: CoverageReport): CrapEntry[] {
  return functions.map((fn) =>
    entryFor(
      fn,
      coverageFor(report, fn.file, fn.name, fn.startLine, fn.endLine),
    ),
  );
}

/** Run the tool. Returns the exit code. */
export function main(argv: string[]): number {
  const options = parseOptions(argv);
  if (options === null) {
    return 2;
  }
  const entries = scoreSources(options);
  if (entries === null) {
    return 1;
  }
  console.log(formatReport(entries, options.max, options.verbose));
  return exitCode(entries, options.max);
}

/** The options, or null when the command line cannot be run. */
function parseOptions(argv: string[]): Options | null {
  try {
    return parseArgs(argv);
  } catch (err) {
    console.error(`error: ${describe(err)}`);
    console.error("usage: crap -c <coverage.json> [-max N] [-v] [--exclude GLOB]");
    return null;
  }
}

/** The scores of the sources, or null when they cannot be read. */
function scoreSources(options: Options): CrapEntry[] | null {
  try {
    return scoreAll(functionsInSources(options), readReport(options.coverage));
  } catch (err) {
    console.error(`error: ${describe(err)}`);
    return null;
  }
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

/**
 * The exit code: 1 when a function is over the bar, 0 otherwise. A bar
 * of zero is no bar — the gate is off, the way gocrap reads it.
 */
function exitCode(entries: CrapEntry[], max: number): number {
  if (max <= 0) {
    return 0;
  }
  const above = entries.filter((e) => e.crap > max).length;
  if (above > 0) {
    console.error(`FAIL: ${above} function(s) exceed max CRAP score ${max}`);
    return 1;
  }
  return 0;
}

/** What an error says. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The entry point, when this file is run and not imported. */
if (process.argv[1]?.endsWith("cli.ts")) {
  process.exit(main(process.argv.slice(2)));
}
