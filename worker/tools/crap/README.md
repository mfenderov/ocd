# crap — the CRAP score for TypeScript

The twin of [gocrap](https://github.com/mfenderov/gocrap), the Go tool.
Same formula, same table, same exit code.

```
CRAP(function) = complexity² × (1 − coverage)³ + complexity
```

- **complexity** — the number of decision points: `if`, `for`, `for-in`,
  `for-of`, `while`, `do`, `catch`, the ternary, `case` clauses (not the
  `default` of a switch), and the short-circuiting operators `&&`, `||`,
  `??`.
- **coverage** — the share of the function's statements the tests
  reached, from the coverage provider's JSON report.

A simple, fully covered function scores 1. A function with ten paths and
no tests scores 110.

## Where the twin differs from gocrap

Two differences:

- **A nested function is measured on its own.** Its decisions are not
  counted again in the function that holds it. gocyclo walks the whole
  declaration, so a nested literal's decisions belong to the function
  that holds it and the literal is never reported on its own. The
  twin's way is the CRAP way: a function's complexity belongs to the
  function, and the coverage that goes with it belongs to the function
  too. Counting it twice would charge the same decision points — and
  the same coverage — to two functions.
- **The ternary and the catch are decisions here.** Go has neither, so
  gocyclo cannot count them. A TypeScript function is never flattered
  by the comparison.

Everything else is gocrap's rule: the same decision points (the `default`
of a switch is not one of them), the same count of a statement that
overlaps a function's lines, the same glob for `--exclude`, the same
exit codes.

## Why the bar is 10

The coverage term is never negative, so **CRAP ≥ complexity always**. A
bar of 10 therefore says two things at once:

- no function may have more than ten decision points, however well it is
  tested — the complexity has to come down;
- and the complex ones need high coverage: complexity 8 needs 85%,
  complexity 5 needs 42%, complexity 3 needs 9%.

A function of complexity 10 needs **100%** coverage to sit at the bar,
which is a knife edge: one percent of missed coverage puts it over. The
answer is to lower the complexity, not to chase the coverage.

## Running it

```bash
cd worker
npm run coverage                                   # the coverage report
npm run crap -- -c coverage/coverage-final.json -max 10
npm run crap -- -c coverage/coverage-final.json -max 10 -v   # every function
```

The flags mirror gocrap's:

| flag | what it does |
|---|---|
| `-c`, `--coverprofile` | the coverage report to read (required) |
| `-max N` | the highest score a function may have (default 10); zero turns the gate off, the way gocrap reads it |
| `-v` | show every function, not only the ones over the bar |
| `--exclude GLOB` | leave files out (repeatable): the glob is matched the way Go's `filepath.Match` matches it — `*` and `?` never cross a `/`, `[...]` is a class of characters, a `\` stands for the character after it — and the pattern is tried against the file's path and against its base name |
| `--root DIR` | where the sources are (default: the working directory) |
| `--src DIR` | the directory under the root the sources live in (default `src`) |

The exit code is 1 when a function is over the bar, so it is a gate. A
command line it cannot run exits 2, and a report it cannot read exits 1
— the codes gocrap uses.

## The tool measuring itself

```bash
npm run crap:self
```

The tool is held to the same bar it applies to everything else: its own
suite runs in node, its own coverage is measured, and its own functions
must score 10 or less. It currently passes with 0 of 70 functions over
the bar, average 2.2.

Its first draft failed that bar on four of its own functions — the flag
parsing, the name resolution, the decision-point table and the command
line. Splitting them is what the tool asks of everything else.

## The shape

```
tools/crap/
  complexity.ts   the AST walk: the functions, their lines, their complexity
  coverage.ts     the coverage report: the statements, the share that was hit
  score.ts        the formula, the summary, the table
  args.ts         the command line
  glob.ts         the glob of --exclude: `*`, `?` and `[...]`
  cli.ts          the reading: the files, the report, the exit code
```

The library is pure — source text and a coverage report in, scores out.
The command line does the reading, and the tests for the library never
touch the disk. The command line's own test works in a temporary
directory.

The tools have their own suite and their own `tsconfig.json`: they run
in node, because they read files and the Workers runtime has no
filesystem. The worker's own suite runs in the Workers runtime and
excludes them.
