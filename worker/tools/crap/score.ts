import type { FunctionInfo } from "./complexity.ts";

/**
 * The CRAP score: how expensive a function is to change, because it
 * combines how many paths it has with how little of it the tests
 * reach.
 *
 *     CRAP = complexity^2 * (1 - coverage)^3 + complexity
 *
 * A simple, fully covered function scores 1. A complex function nobody
 * tests scores its complexity squared.
 */
export function crapScore(complexity: number, coverage: number): number {
  const missed = 1 - Math.min(Math.max(coverage, 0), 100) / 100;
  return complexity * complexity * missed * missed * missed + complexity;
}

/** One function's score. */
export interface CrapEntry {
  name: string;
  file: string;
  line: number;
  complexity: number;
  coverage: number;
  crap: number;
}

/** The score of one function, given its complexity and its coverage. */
export function entryFor(fn: FunctionInfo, coverage: number): CrapEntry {
  return {
    name: fn.name,
    file: fn.file,
    line: fn.startLine,
    complexity: fn.complexity,
    coverage,
    crap: crapScore(fn.complexity, coverage),
  };
}

/** The summary a report ends with. */
export interface CrapSummary {
  functions: number;
  average: number;
  above: number;
}

/** The summary of a set of entries: how many, the average, how many over. */
export function summarize(entries: CrapEntry[], max: number): CrapSummary {
  const total = entries.reduce((sum, e) => sum + e.crap, 0);
  return {
    functions: entries.length,
    average: entries.length === 0 ? 0 : total / entries.length,
    above: entries.filter((e) => e.crap > max).length,
  };
}

/** The columns of the report. */
const COLUMNS = [
  { head: "", width: 4 },
  { head: "CRAP", width: 8 },
  { head: "Complexity", width: 11 },
  { head: "Coverage", width: 10 },
  { head: "Function", width: 34 },
  { head: "Location", width: 40 },
];

/** One row of the report. */
function row(cells: string[]): string {
  const padded = cells.map((cell, i) => cell.padEnd(COLUMNS[i].width));
  return padded.join(" ").trimEnd();
}

/** The report, as a table: the worst first. */
export function formatReport(entries: CrapEntry[], max: number, verbose: boolean): string {
  const sorted = [...entries].sort((a, b) => b.crap - a.crap);
  const shown = verbose ? sorted : sorted.filter((e) => e.crap > max);
  const lines = [row(COLUMNS.map((c) => c.head))];
  for (const entry of shown) {
    const verdict = entry.crap > max ? "FAIL" : "ok";
    lines.push(
      row([
        verdict,
        entry.crap.toFixed(1),
        String(entry.complexity),
        `${entry.coverage.toFixed(1)}%`,
        entry.name,
        `${shortPath(entry.file)}:${entry.line}`,
      ]),
    );
  }
  const summary = summarize(entries, max);
  lines.push("");
  lines.push(
    `Average CRAP: ${summary.average.toFixed(1)} | Functions: ${summary.functions} | Above ${max}: ${summary.above}`,
  );
  return lines.join("\n");
}

/** The path as it should read in a report: relative to the working directory. */
function shortPath(path: string): string {
  const marker = "/worker/";
  const at = path.indexOf(marker);
  if (at < 0) {
    return path;
  }
  return path.slice(at + marker.length);
}
