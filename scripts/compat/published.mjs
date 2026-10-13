// Shared helpers for the published-package compatibility checks.
//
// Downloads the latest published version of this package from npm (cached in
// .compat/) and resolves the files each package.json "exports" subpath points
// at, for both the published copy and the local build in dist/.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

export function getPublished() {
  const version = execFileSync("npm", ["view", pkg.name, "version"], { encoding: "utf8" }).trim();
  const dir = join(root, ".compat", version);
  const pkgDir = join(dir, "package");
  if (!existsSync(join(pkgDir, "package.json"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const tgz = execFileSync("npm", ["pack", `${pkg.name}@${version}`, "--pack-destination", dir, "--silent"], {
      encoding: "utf8",
    }).trim().split("\n").pop();
    execFileSync("tar", ["xzf", join(dir, tgz), "-C", dir]);
  }
  return { name: pkg.name, version, dir: pkgDir };
}

// For every exports subpath: { subpath, require, import, types } as paths relative to the package root.
export function entries(pkgJson = pkg) {
  return Object.entries(pkgJson.exports).map(([subpath, target]) => ({
    subpath,
    require: target.require,
    import: target.import,
    types: target.types,
  }));
}

export function readPackageJson(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}
