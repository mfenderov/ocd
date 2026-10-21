/**
 * The coverage side of the CRAP score: how much of a function the tests
 * actually reached.
 *
 * The input is the JSON report of the coverage provider: for every file,
 * the statements it knows and how many times each was hit. A function's
 * coverage is the share of the statements inside it that were hit.
 */

/** One statement the coverage provider knows about. */
export interface Statement {
  startLine: number;
  endLine: number;
  hits: number;
}

/** The coverage of one file. */
export interface FileCoverage {
  statements: Statement[];
  /** The hit count per function, by the function's name and start line. */
  functions: Map<string, number>;
}

/** The coverage of every file in a report. */
export type CoverageReport = Map<string, FileCoverage>;

/** The key a function is known by in the coverage report. */
function functionKey(name: string, line: number): string {
  return `${name}:${line}`;
}

/**
 * Read a coverage report from the provider's JSON. The file paths in
 * the report are absolute; they are kept as they are, and the caller
 * matches them against the files it analysed.
 */
export function parseCoverage(json: string): CoverageReport {
  const raw = JSON.parse(json) as Record<string, RawFileCoverage>;
  const report: CoverageReport = new Map();
  for (const [file, entry] of Object.entries(raw)) {
    report.set(file, {
      statements: statementsOf(entry),
      functions: functionsOf(entry),
    });
  }
  return report;
}

/** The shape of the coverage report this reader accepts. */
interface RawFileCoverage {
  statementMap?: Record<string, { start: { line: number }; end: { line: number } }>;
  s?: Record<string, number>;
  fnMap?: Record<string, { name: string; decl?: { start: { line: number } } }>;
  f?: Record<string, number>;
}

/** The statements of one file, in a flat list. */
function statementsOf(entry: RawFileCoverage): Statement[] {
  const map = entry.statementMap ?? {};
  const hits = entry.s ?? {};
  return Object.entries(map).map(([id, span]) => ({
    startLine: span.start.line,
    endLine: span.end.line,
    hits: hits[id] ?? 0,
  }));
}

/** The functions of one file, by name and start line. */
function functionsOf(entry: RawFileCoverage): Map<string, number> {
  const map = entry.fnMap ?? {};
  const hits = entry.f ?? {};
  const functions = new Map<string, number>();
  for (const [id, fn] of Object.entries(map)) {
    const line = fn.decl?.start.line;
    if (line === undefined) {
      continue;
    }
    functions.set(functionKey(fn.name, line), hits[id] ?? 0);
  }
  return functions;
}

/**
 * The coverage of a function, as a percentage.
 *
 * A statement counts when it overlaps the function's lines, the way
 * gocrap counts it: a statement that starts inside the function and
 * ends outside it still belongs to it.
 */
export function coverageFor(
  report: CoverageReport,
  file: string,
  name: string,
  startLine: number,
  endLine: number,
): number {
  const entry = report.get(file);
  if (!entry) {
    return 0;
  }
  const inside = entry.statements.filter((s) => s.endLine >= startLine && s.startLine <= endLine);
  if (inside.length === 0) {
    return 0;
  }
  const hit = inside.filter((s) => s.hits > 0).length;
  return (hit / inside.length) * 100;
}

/** Whether the coverage report saw a function at all. */
export function functionWasCalled(
  report: CoverageReport,
  file: string,
  name: string,
  startLine: number,
): boolean {
  const entry = report.get(file);
  if (!entry) {
    return false;
  }
  return (entry.functions.get(functionKey(name, startLine)) ?? 0) > 0;
}
