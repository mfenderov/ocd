/**
 * crap — the CRAP score for TypeScript.
 *
 * The library is pure: it takes source text and a coverage report, and
 * gives back the scores. The command line in cli.ts does the reading.
 */
export { functionsIn, functionsInFile, complexityOf, type FunctionInfo } from "./complexity.ts";
export { parseCoverage, coverageFor, functionWasCalled, type CoverageReport } from "./coverage.ts";
export { crapScore, entryFor, summarize, formatReport, type CrapEntry, type CrapSummary } from "./score.ts";
export { parseArgs, DEFAULT_MAX, type Options } from "./args.ts";
