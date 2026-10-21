// The brain's linter.
//
// The compiler checks the types. This checks the shapes the types cannot
// see: a promise nobody awaits, a condition that can never be false, an
// `any` that hides a type, a `!` that asserts what the compiler already
// knows.
//
// Three layers:
//   1. @eslint/js's recommended rules — the JavaScript floor.
//   2. typescript-eslint's recommended rules, and the type-aware ones on
//      top of them. The type-aware rules are the point: they need the
//      project, and projectService picks the nearest tsconfig for every
//      file — worker/tsconfig.json for the brain and its tests,
//      worker/tools/tsconfig.json for the tools.
//   3. a curated list: the rules that catch the mistakes this codebase
//      has actually made, plus the ones the recommended sets leave out
//      but this codebase wants.
//
// The config file itself is JavaScript, and it is linted too.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // The coverage reports and the dependencies are not the brain's code.
    // The generated types are not either: `wrangler types` writes them,
    // and nobody here edits them.
    ignores: ["coverage/**", "tools/coverage/**", "node_modules/**", "worker-configuration.d.ts"],
  },

  // The JavaScript floor, for everything.
  js.configs.recommended,

  // The TypeScript rules, for the TypeScript. The recommended set and the
  // type-aware set: a promise that is dropped, a promise that is passed
  // where a plain value is expected, and a condition the types prove
  // cannot fail are all invisible to the compiler.
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // The curated rules. Each one is here for a reason.
  {
    files: ["**/*.ts"],
    rules: {
      // "==" hides the difference between 0, "" and false.
      eqeqeq: ["error", "always"],
      // `let` where `const` does the job says the binding may change.
      "no-var": "error",
      "prefer-const": "error",
      // { foo: foo } says the name twice; { foo } says it once.
      "object-shorthand": "error",
      // !!x and x + "" hide a coercion behind a trick.
      "no-implicit-coercion": "error",
      // A type import is erased when the program runs; a value import may
      // not be. The compiler cannot tell them apart.
      "@typescript-eslint/consistent-type-imports": "error",
      // `any` turns the compiler off exactly where the types matter.
      "@typescript-eslint/no-explicit-any": "error",
      // `!` asserts what the compiler should have proved. When it has,
      // the assertion is noise; when it has not, it is a lie.
      "@typescript-eslint/no-non-null-assertion": "error",
      // A condition the types prove cannot fail is dead code, and it
      // hides the truth: either the type is too wide, or the check is a
      // leftover. The recommended sets do not carry this rule; the
      // brain wants it.
      "@typescript-eslint/no-unnecessary-condition": "error",
      // In a Worker the console IS the log: the brain logs to it on
      // purpose, and there is no other log. Off, and it stays off.
      "no-console": "off",
    },
  },

  // The runtimes, declared. The brain runs in the Workers runtime; the
  // tools run in node, because they read files and the Workers runtime
  // has no filesystem.
  {
    files: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.worker },
    },
  },
  {
    files: ["tools/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // A test may assert hard. A non-null assertion and an `any` are the
  // tools of a test that reaches into the shape it is checking, and the
  // shape it is checking is the shape the compiler cannot see.
  {
    files: ["test/**/*.ts", "tools/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
