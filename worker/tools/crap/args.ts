/**
 * The command line of the CRAP tool, kept apart from the file reading
 * so it can be tested without touching the disk.
 */

/** What the tool was asked to do. */
export interface Options {
  /** The coverage report to read. */
  coverage: string;
  /** The highest CRAP score a function may have. */
  max: number;
  /** Show every function, not only the ones over the threshold. */
  verbose: boolean;
  /** The globs of the files to leave out. */
  exclude: string[];
  /** The root the sources are found under; empty means the caller's. */
  root: string;
  /** The directory under the root the sources live in. */
  src: string;
}

/** The default threshold: a function above this is worth a look. */
export const DEFAULT_MAX = 10;

/** The flags that take a value, and what each one sets. */
const VALUE_FLAGS: Partial<Record<string, (options: Options, value: string) => void>> = {
  "-c": (options, value) => {
    options.coverage = value;
  },
  "--coverprofile": (options, value) => {
    options.coverage = value;
  },
  "-max": (options, value) => {
    options.max = Number(value);
  },
  "--exclude": (options, value) => {
    options.exclude.push(value);
  },
  "--root": (options, value) => {
    options.root = value;
  },
  "--src": (options, value) => {
    options.src = value;
  },
};

/** The flags that stand alone. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["-v", "--verbose"]);

/** Parse the arguments. Throws when the tool cannot run. */
export function parseArgs(argv: string[]): Options {
  const options: Options = {
    coverage: "",
    max: DEFAULT_MAX,
    verbose: false,
    exclude: [],
    root: "",
    src: "src",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (BOOLEAN_FLAGS.has(arg)) {
      options.verbose = true;
      continue;
    }
    const set = VALUE_FLAGS[arg];
    if (!set) {
      throw new Error(`unknown argument "${arg}"`);
    }
    set(options, argv[++i] ?? "");
  }
  checkUsable(options);
  return options;
}

/** The arguments a run needs to be possible. */
function checkUsable(options: Options): void {
  if (options.coverage === "") {
    throw new Error("-c <coverage.json> is required");
  }
  if (!Number.isFinite(options.max)) {
    throw new Error("-max wants a number");
  }
}
