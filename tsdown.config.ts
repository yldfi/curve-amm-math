import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "rpc/index": "src/rpc/index.ts",
  },
  // Declarations are generated once, from the ESM build: tsdown's CJS
  // declaration output references a runtime helper (__exportAll) for this
  // package's `export * as` namespaces. tsup also shipped ESM-style .d.ts.
  format: {
    cjs: { dts: false },
    esm: {},
  },
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  target: "es2020", // BigInt support
  platform: "node",
  treeshake: true, // Remove unused code
  // Keep the published file names the package.json exports map points at:
  // CommonJS .js, ESM .mjs, and the shared .d.ts types.
  outExtensions: ({ format }) => (format === "cjs" ? { js: ".js" } : { js: ".mjs", dts: ".d.ts" }),
});
