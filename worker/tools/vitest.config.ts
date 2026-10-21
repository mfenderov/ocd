import { defineConfig } from "vitest/config";

/**
 * The tools' own tests. They run in node, not in the Workers runtime:
 * the CRAP tool reads files, and the Workers runtime has no filesystem.
 */
export default defineConfig({
  // The tools have their own root: the CRAP tool lives beside this file,
  // not under src/.
  root: import.meta.dirname,
  test: {
    name: "tools",
    include: ["crap/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      reportsDirectory: "./coverage",
      include: ["crap/**/*.ts"],
      exclude: ["**/*.test.ts"],
    },
  },
});
