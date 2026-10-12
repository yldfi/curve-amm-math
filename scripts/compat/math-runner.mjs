// Runs the same deterministic pseudo-random inputs through the published
// package and the local build (CJS and ESM) and requires identical results,
// including which inputs throw and with what message. Catches bundler or
// minifier changes that alter computed values without changing the API.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { entries, getPublished, readPackageJson, root } from "./published.mjs";

export async function runMathCompat(makeCase, { count = 2000, seed = 12345n } = {}) {
  const require = createRequire(import.meta.url);
  const published = getPublished();
  const pubMain = entries(readPackageJson(published.dir)).find((e) => e.subpath === ".");
  const localMain = entries().find((e) => e.subpath === ".");
  const builds = {
    "published-cjs": require(join(published.dir, pubMain.require)),
    "local-cjs": require(join(root, localMain.require)),
    "published-esm": await import(pathToFileURL(join(published.dir, pubMain.import)).href),
    "local-esm": await import(pathToFileURL(join(root, localMain.import)).href),
  };
  let state = seed;
  const rand = (lo, hi) => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return lo + (state % (hi - lo + 1n));
  };
  const run = (fn) => {
    try {
      return JSON.stringify(fn(), (_, x) => (typeof x === "bigint" ? x.toString() : x));
    } catch (e) {
      return `THROW:${e.message}`;
    }
  };
  let checks = 0, throws = 0, mismatches = 0;
  for (let n = 0; n < count; n++) {
    const c = makeCase(rand, n, run);
    const results = Object.fromEntries(Object.entries(builds).map(([k, m]) => [k, c(m)]));
    for (const fn of Object.keys(results["published-cjs"])) {
      const ref = results["published-cjs"][fn];
      if (ref === "skip") continue;
      checks++;
      if (ref.startsWith("THROW")) throws++;
      for (const b of ["local-cjs", "published-esm", "local-esm"]) {
        if (results[b][fn] !== ref && mismatches++ < 10) {
          console.error(`  MISMATCH case ${n} ${fn} [${b}]: ${ref.slice(0, 90)} vs ${results[b][fn].slice(0, 90)}`);
        }
      }
    }
  }
  console.log(`Math compat vs ${published.name}@${published.version}: ${checks} results x 4 builds (${throws} expected throws), ${mismatches} mismatch(es)`);
  if (mismatches) process.exit(1);
}
