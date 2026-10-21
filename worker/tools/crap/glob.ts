/**
 * A glob, matched the way Go's filepath.Match matches it: "*" and "?"
 * never cross a "/", "[...]" holds a class of characters, and a "\"
 * stands for the character after it.
 *
 * gocrap leaves a file out when the pattern matches its path or its
 * base name. The twin does the same, so an exclude means the same
 * thing in both.
 */

/** Whether a path matches a glob. */
export function matchesGlob(pattern: string, path: string): boolean {
  return matchFrom(pattern, 0, path, 0);
}

/**
 * Whether a file is left out by one of the patterns. The pattern is
 * tried against the file's path and against its base name, the way
 * gocrap tries it.
 */
export function isExcluded(file: string, patterns: string[]): boolean {
  const base = file.split("/").pop() ?? file;
  return patterns.some((pattern) => matchesGlob(pattern, file) || matchesGlob(pattern, base));
}

/** The match from a place in the pattern and in the path. */
function matchFrom(pattern: string, pi: number, path: string, si: number): boolean {
  while (pi < pattern.length) {
    const c = pattern[pi];
    if (c === "*") {
      return matchStar(pattern, pi, path, si);
    }
    if (c === "[") {
      return matchClass(pattern, pi, path, si);
    }
    if (si >= path.length) {
      return false;
    }
    if (!matchesChar(pattern, pi, path[si])) {
      return false;
    }
    pi += charLength(pattern, pi);
    si++;
  }
  return si === path.length;
}

/** The "*" of a pattern: it takes any run of characters that stops at a "/". */
function matchStar(pattern: string, pi: number, path: string, si: number): boolean {
  for (let next = si; next <= path.length; next++) {
    if (matchFrom(pattern, pi + 1, path, next)) {
      return true;
    }
    if (next < path.length && path[next] === "/") {
      break;
    }
  }
  return false;
}

/** The "[...]" of a pattern: a class of characters. */
function matchClass(pattern: string, pi: number, path: string, si: number): boolean {
  const parsed = parseClass(pattern, pi);
  if (parsed === null || si >= path.length) {
    return false;
  }
  if (classHas(parsed.ranges, path[si]) === parsed.negated) {
    return false;
  }
  return matchFrom(pattern, parsed.end + 1, path, si + 1);
}

/** The class of a pattern: its ranges, its negation, and where it ends. */
interface ParsedClass {
  ranges: [string, string][];
  negated: boolean;
  end: number;
}

/**
 * The class at pi, or null when the pattern is bad. Go's filepath.Match
 * reads it: the class ends at the first "]" that follows an element, an
 * element is a character or a range, and a "-" or a "]" that names
 * nothing is a bad pattern — which gocrap ignores, so it matches
 * nothing.
 */
function parseClass(pattern: string, pi: number): ParsedClass | null {
  let i = pi + 1;
  let negated = false;
  if (pattern[i] === "^") {
    negated = true;
    i++;
  }
  const ranges: [string, string][] = [];
  while (i < pattern.length) {
    if (pattern[i] === "]" && ranges.length > 0) {
      return { ranges, negated, end: i };
    }
    const lo = classChar(pattern, i);
    if (lo === null) {
      return null;
    }
    i = lo.next;
    let hi = lo.char;
    if (pattern[i] === "-") {
      const high = classChar(pattern, i + 1);
      if (high === null) {
        return null;
      }
      hi = high.char;
      i = high.next;
    }
    ranges.push([lo.char, hi]);
  }
  return null;
}

/**
 * The character a class names at i: itself, or the one an escape stands
 * for. Null when the pattern is bad.
 */
function classChar(pattern: string, i: number): { char: string; next: number } | null {
  const c = pattern[i];
  if (c === "\\") {
    if (i + 1 >= pattern.length) {
      return null;
    }
    return { char: pattern[i + 1], next: i + 2 };
  }
  if (c === "-" || c === "]") {
    return null;
  }
  return { char: c, next: i + 1 };
}

/** Whether the ranges of a class hold a character. */
function classHas(ranges: [string, string][], char: string): boolean {
  return ranges.some(([lo, hi]) => char >= lo && char <= hi);
}

/** Whether the pattern's character at pi matches the path's character. */
function matchesChar(pattern: string, pi: number, char: string): boolean {
  const c = pattern[pi];
  if (c === "?") {
    return char !== "/";
  }
  if (c === "\\") {
    return pi + 1 < pattern.length && pattern[pi + 1] === char;
  }
  return c === char;
}

/** How many characters of the pattern the character at pi takes. */
function charLength(pattern: string, pi: number): number {
  return pattern[pi] === "\\" ? 2 : 1;
}
