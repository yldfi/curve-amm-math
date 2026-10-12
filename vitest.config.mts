import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts"],
      thresholds: {
        // Core math modules should have high coverage.
        // Statement thresholds re-based for vitest 4's AST-based v8 coverage
        // (vitest 1 counted lines as statements: 94.75 -> 90.26, 91.61 -> 84.46
        // for the same tests); branch/function thresholds are unchanged.
        "src/stableswap.ts": {
          statements: 89,
          branches: 77,
          functions: 95,
        },
        "src/cryptoswap.ts": {
          statements: 83,
          branches: 68,
          functions: 95,
        },
      },
    },
  },
});
