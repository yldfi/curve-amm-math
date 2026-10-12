// Published-API compatibility check: compares the local build (dist/) with the
// latest version on npm. Run after `pnpm build`.
//
// - Runtime: every export of every published entry (CJS and ESM) must still
//   exist with the same kind, function arity and constant value.
// - Types: every published export (namespace members expanded) must be
//   mutually assignable between the published and local declarations.
//
// New exports are allowed; anything removed, changed or broken fails.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { entries, getPublished, readPackageJson, root } from "./published.mjs";

const require = createRequire(import.meta.url);
const ts = createRequire(join(root, "package.json"))("typescript");
const published = getPublished();
const pubEntries = entries(readPackageJson(published.dir));
const localEntries = new Map(entries().map((e) => [e.subpath, e]));
const problems = [];

console.log(`Comparing local build with ${published.name}@${published.version}`);

// --- Runtime exports ---------------------------------------------------------
const describe = (mod) =>
  Object.fromEntries(
    Object.keys(mod).map((k) => {
      const v = mod[k];
      const t = typeof v;
      if (t === "function") return [k, `function/${v.length}`];
      if (["bigint", "number", "string", "boolean"].includes(t)) return [k, `${t}:${String(v)}`];
      if (t === "object" && v) {
        return [k, `object:${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : typeof x === "function" ? `fn/${x.length}` : x))}`];
      }
      return [k, t];
    }),
  );

for (const e of pubEntries) {
  const local = localEntries.get(e.subpath);
  if (!local) {
    problems.push(`exports subpath ${e.subpath} was removed`);
    continue;
  }
  for (const fmt of ["require", "import"]) {
    const load = (dir, rel) =>
      fmt === "require" ? require(join(dir, rel)) : import(pathToFileURL(join(dir, rel)).href);
    const before = describe(await load(published.dir, e[fmt]));
    const after = describe(await load(root, local[fmt]));
    let changed = 0;
    for (const [name, sig] of Object.entries(before)) {
      if (!(name in after)) problems.push(`${e.subpath} [${fmt}] export removed: ${name}`), changed++;
      else if (after[name] !== sig) problems.push(`${e.subpath} [${fmt}] ${name}: ${sig.slice(0, 80)} -> ${after[name].slice(0, 80)}`), changed++;
    }
    const added = Object.keys(after).filter((k) => !(k in before)).length;
    console.log(`  runtime ${e.subpath} [${fmt}]: ${Object.keys(before).length} published exports, ${changed} changed/removed, ${added} added`);
  }
}

// --- Type declarations -------------------------------------------------------
function exportKeys(file) {
  const program = ts.createProgram([file], { strict: true, noEmit: true, types: [] });
  const checker = program.getTypeChecker();
  const out = [];
  const walk = (moduleSymbol, prefix, depth) => {
    for (const sym of checker.getExportsOfModule(moduleSymbol)) {
      const s = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      const name = prefix + sym.name;
      if (s.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule) && depth < 3) {
        out.push({ name, kind: "value" });
        walk(s, `${name}.`, depth + 1);
        continue;
      }
      if (s.flags & ts.SymbolFlags.Value) out.push({ name, kind: "value" });
      if (s.flags & ts.SymbolFlags.Type) {
        out.push({ name, kind: "type", params: (checker.getDeclaredTypeOfSymbol(s).typeParameters || []).length });
      }
    }
  };
  walk(checker.getSymbolAtLocation(program.getSourceFile(file)), "", 0);
  return out;
}

const workDir = join(root, ".compat", "types-check");
mkdirSync(workDir, { recursive: true });
const lines = [];
let typeCount = 0;
for (const e of pubEntries) {
  const local = localEntries.get(e.subpath);
  if (!local) continue;
  const spec = (dir, rel) => JSON.stringify(join(dir, rel).replace(/\.d\.(m|c)?ts$/, ""));
  const P = `import(${spec(published.dir, e.types)})`;
  const L = `import(${spec(root, local.types)})`;
  for (const k of exportKeys(join(published.dir, e.types))) {
    const args = k.params ? `<${Array(k.params).fill("any").join(", ")}>` : "";
    const ref = (X) => (k.kind === "type" ? `${X}.${k.name}${args}` : `typeof ${X}.${k.name}`);
    typeCount++;
    lines.push(`// ${e.subpath} ${k.kind} ${k.name}`);
    lines.push(`{ const a: ${ref(P)} = null! as ${ref(L)}; const b: ${ref(L)} = null! as ${ref(P)}; void a; void b; }`);
  }
}
const checkFile = join(workDir, "check.ts");
writeFileSync(checkFile, `${lines.join("\n")}\n`);
const program = ts.createProgram([checkFile], {
  strict: true,
  noEmit: true,
  types: [],
  skipLibCheck: false,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
for (const d of diagnostics) {
  const where = d.file
    ? d.file.fileName === checkFile
      ? lines[d.file.getLineAndCharacterOfPosition(d.start).line - 1]
      : `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
    : "";
  problems.push(`types ${where.replace(/^\/\/ /, "")}: ${ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 200)}`);
}
console.log(`  types: ${typeCount} published exports checked for mutual assignability, ${diagnostics.length} problem(s)`);

if (problems.length) {
  console.error(`\nFAIL: ${problems.length} incompatibility(ies) with ${published.name}@${published.version}:`);
  for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
  console.error("\nIf this API change is intentional, add the `api-change` label to the PR.");
  process.exit(1);
}
console.log("OK: local build is compatible with the published package");
