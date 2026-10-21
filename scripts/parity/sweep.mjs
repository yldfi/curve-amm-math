// Differential parity sweep: every Curve pool with TVL on a chain, read at one
// block with rpc.detectPool / rpc.readPoolState, each view the library ports
// compared with the pool's own view at that block. Sizes are a fixed ladder
// plus seeded log-uniform random fractions of the pool's balances / supply.
// Run after `pnpm build`:
//
//   node scripts/parity/sweep.mjs --chain ethereum --rpc <url> [--block N]
//     [--random 8] [--seed 1] [--pools 0xabc,0xdef] [--min-tvl 0]
//     [--concurrency 4] [--out .parity/<chain>-<block>.json]
//
// Network only; never part of `pnpm test`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lib = await import(pathToFileURL(join(root, "dist", "index.mjs")).href);
const rpc = await import(pathToFileURL(join(root, "dist", "rpc", "index.mjs")).href);
const { pools } = lib;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, k, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[k + 1]?.startsWith("--") ? "true" : (all[k + 1] ?? "true")]);
    return acc;
  }, []),
);
const chain = args.chain ?? "ethereum";
const rpcUrl = args.rpc ?? process.env.RPC_URL;
if (!rpcUrl) throw new Error("--rpc <url> (or RPC_URL) is required");
const nRandom = Number(args.random ?? 8);
const concurrency = Number(args.concurrency ?? 4);
const minTvl = Number(args["min-tvl"] ?? 0);
const LADDER = [1e-4, 1e-3, 1e-2, 5e-2];

// --- seeded randomness --------------------------------------------------------
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fractions = (rand) => [
  ...LADDER,
  ...Array.from({ length: nRandom }, () => 10 ** (-7 + rand() * Math.log10(0.5 / 1e-7))),
];
const part = (x, f) => (x * BigInt(Math.round(f * 1e12))) / 10n ** 12n;

// --- ABI encoding -----------------------------------------------------------------
const u = (x) => BigInt.asUintN(256, BigInt(x)).toString(16).padStart(64, "0");
const SEL = {
  getDyI: "0x5e0d443f",
  getDyU: "0x556d6e9f",
  getDyUnderlyingI: "0x07211ef7",
  cwoI: "0xcc2b27d7",
  cwoU: "0x4fb08c5e",
  vp: "0xbb7b8b80",
  ctaBool: { 2: "0xed8e84f3", 3: "0x3883e119", 4: "0xcf701ff7", 5: "0x7ede89c5" },
  ctaNoBool: { 2: "0x8d8ea727", 3: "0x5b6f1b5a" },
  ctaDyn: "0x3db06dd8",
};

// Calldata candidates; the first that does not revert is the pool's view
// (stable-ng plain pools and the first stable-ng metapools take a DynArray)
function ctaCalldata(state, amounts, isDeposit) {
  const n = amounts.length;
  const dyn = SEL.ctaDyn + u(64) + u(isDeposit ? 1 : 0) + u(n) + amounts.map(u).join("");
  const fixed = SEL.ctaBool[n] + amounts.map(u).join("") + u(isDeposit ? 1 : 0);
  if (state.family === "stableswap" && state.params.variant === "ng") return state.base ? [fixed, dyn] : [dyn];
  if (state.family === "cryptoswap") return [SEL.ctaNoBool[n] + amounts.map(u).join("")];
  return [fixed];
}

// --- eth_call batches: null only for genuine reverts; other errors retry, then throw
const REVERT = /revert|invalid opcode|out of gas|stack underflow|bad instruction|vm exception/i;
async function ethCalls(list, block) {
  const tag = "0x" + block.toString(16);
  const out = [];
  for (let k = 0; k < list.length; k += 100) {
    const part = list.slice(k, k + 100);
    const body = part.map((c, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [c, tag] }));
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const byId = new Map(json.map((r) => [r.id, r]));
        out.push(
          ...part.map((c, id) => {
            const r = byId.get(id);
            if (!r) throw new Error("missing batch item");
            if (r.error) {
              if (r.error.code === 3 || REVERT.test(r.error.message ?? "")) return null;
              throw new Error(r.error.message);
            }
            return r.result && r.result !== "0x" ? r.result : null;
          }),
        );
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  return out;
}

// --- one pool -------------------------------------------------------------------------
async function sweepPool(meta, block, seed) {
  const out = { address: meta.address, name: meta.name, registry: meta.registryId, usdTotal: meta.usdTotal, views: {} };
  let state;
  try {
    const lpToken = meta.lpTokenAddress && meta.lpTokenAddress.toLowerCase() !== meta.address.toLowerCase() ? meta.lpTokenAddress : undefined;
    const descriptor = await rpc.detectPool(rpcUrl, meta.address, { blockTag: block, lpToken });
    out.descriptor = descriptor;
    if (descriptor.family === "unsupported") {
      out.status = "unsupported";
      out.reason = descriptor.reason;
      return out;
    }
    state = await rpc.readPoolState(rpcUrl, meta.address, { blockTag: block, descriptor });
  } catch (e) {
    out.status = "read-error";
    out.reason = e.message;
    return out;
  }
  out.family = state.family;
  const rand = mulberry32(seed);
  const fr = fractions(rand);
  const n = pools.nCoins(state);
  const balances =
    state.family === "tricryptoLegacy" ? state.state.params.balances : state.params.balances;
  const supply =
    state.family === "stableswap" || state.family === "tricryptoNg" || state.family.startsWith("twocrypto")
      ? state.params.totalSupply
      : state.family === "cryptoswap"
        ? state.totalSupply
        : state.state.totalSupply;
  const crypto = state.family !== "stableswap";
  const cases = [];
  const add = (view, label, data, quote) => cases.push({ view, label, data: [data].flat(), quote });

  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      for (const f of fr) {
        const dx = part(balances[i], f);
        if (dx === 0n) continue;
        add("get_dy", `${i}->${j} ${f.toExponential(2)}`, (crypto ? SEL.getDyU : SEL.getDyI) + u(i) + u(j) + u(dx), () =>
          pools.getDy(state, i, j, dx),
        );
      }
    }
  if (state.family === "stableswap" && state.base) {
    const nu = state.base.balances.length + 1;
    const ub = [state.params.balances[0], ...state.base.balances];
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nu; j++) {
        if (i === j || (i > 0 && j > 0)) continue;
        for (const f of fr) {
          const dx = part(ub[i], f);
          if (dx === 0n) continue;
          add("get_dy_underlying", `${i}->${j} ${f.toExponential(2)}`, SEL.getDyUnderlyingI + u(i) + u(j) + u(dx), () =>
            pools.getDyUnderlying(state, i, j, dx),
          );
        }
      }
  }
  const hasCwo = state.family !== "stableswap" || state.hasCalcWithdrawOneCoin;
  if (hasCwo)
    for (let i = 0; i < n; i++)
      for (const f of fr) {
        const amt = part(supply, f);
        if (amt === 0n) continue;
        add("calc_withdraw_one_coin", `${i} ${f.toExponential(2)}`, (crypto ? SEL.cwoU : SEL.cwoI) + u(amt) + u(i), () =>
          pools.calcWithdrawOneCoin(state, amt, i),
        );
      }
  if (state.family !== "tricryptoLegacy") {
    const dirs = state.family === "cryptoswap" ? [true] : [true, false];
    for (const dep of dirs)
      for (const f of fr) {
        const shapes = [...Array.from({ length: n }, (_, i) => i), "all"];
        for (const s of shapes) {
          const amounts = balances.map((b, k) => (s === "all" || s === k ? part(b, f) : 0n));
          if (amounts.every((a) => a === 0n)) continue;
          add(dep ? "calc_token_amount(dep)" : "calc_token_amount(wd)", `${s} ${f.toExponential(2)}`, ctaCalldata(state, amounts, dep), () =>
            pools.calcTokenAmount(state, amounts, dep),
          );
        }
      }
  }
  add("get_virtual_price", "", SEL.vp, () => pools.getVirtualPrice(state));

  let raws;
  try {
    const flat = await ethCalls(cases.flatMap((c) => c.data.map((data) => ({ to: meta.address, data }))), block);
    let k = 0;
    raws = cases.map((c) => {
      const tries = flat.slice(k, (k += c.data.length));
      return tries.find((r) => r !== null) ?? null;
    });
  } catch (e) {
    out.status = "read-error";
    out.reason = `pool views: ${e.message}`;
    return out;
  }
  let mismatches = 0;
  cases.forEach((c, k) => {
    const v = (out.views[c.view] ??= { n: 0, exact: 0, bothRevert: 0, libThrows: 0, libReturnsPoolReverts: 0, maxDiffWei: "0", maxDiffBps: 0, worst: null });
    v.n++;
    const raw = raws[k];
    const chainValue = raw === null ? null : BigInt(raw.slice(0, 66));
    let libValue;
    let libError;
    try {
      libValue = c.quote();
    } catch (e) {
      libError = e.message;
    }
    if (chainValue === null && libError !== undefined) return v.bothRevert++;
    if (chainValue === null) {
      v.libReturnsPoolReverts++;
      mismatches++;
      v.worst ??= { label: c.label, chain: "revert", lib: String(libValue) };
      return;
    }
    if (libError !== undefined) {
      v.libThrows++;
      mismatches++;
      v.worst ??= { label: c.label, chain: String(chainValue), lib: `throws: ${libError}` };
      return;
    }
    if (libValue === chainValue) return v.exact++;
    mismatches++;
    const diff = libValue > chainValue ? libValue - chainValue : chainValue - libValue;
    const bps = chainValue === 0n ? Infinity : Number((diff * 10n ** 8n) / chainValue) / 1e4;
    if (diff > BigInt(v.maxDiffWei)) {
      v.maxDiffWei = String(diff);
      v.maxDiffBps = bps;
      v.worst = { label: c.label, chain: String(chainValue), lib: String(libValue) };
    }
  });
  out.cases = cases.length;
  out.mismatches = mismatches;
  const onlyPoolReverts = Object.values(out.views).every((v) => v.exact + v.bothRevert + v.libReturnsPoolReverts === v.n);
  out.status = mismatches === 0 ? "exact" : onlyPoolReverts ? "pool-reverts" : "differs";
  return out;
}

// --- main --------------------------------------------------------------------------------
const block = args.block ? Number(args.block) : Number(await rpc.getBlockNumber(rpcUrl)) - 5;
const res = await fetch(`https://api.curve.finance/v1/getPools/all/${chain}`);
let list = (await res.json()).data.poolData.filter((p) => !p.isBroken && (p.usdTotal ?? 0) > minTvl);
if (args.pools) {
  const want = new Set(args.pools.toLowerCase().split(","));
  list = list.filter((p) => want.has(p.address.toLowerCase()));
}
const seen = new Set();
list = list.filter((p) => !seen.has(p.address.toLowerCase()) && seen.add(p.address.toLowerCase()));
console.log(`${chain} @ ${block}: ${list.length} pools`);

const results = [];
let next = 0;
async function worker() {
  while (next < list.length) {
    const k = next++;
    const r = await sweepPool(list[k], block, Number(args.seed ?? 1) + k);
    results.push(r);
    if (r.status !== "exact") console.log(`  ${r.status.padEnd(11)} ${r.address} ${r.name} ${r.reason ?? `${r.mismatches}/${r.cases}`}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const by = (s) => results.filter((r) => r.status === s);
const tvl = (rs) => Math.round(rs.reduce((a, r) => a + (r.usdTotal ?? 0), 0));
const summary = Object.fromEntries(
  ["exact", "differs", "pool-reverts", "unsupported", "read-error"].map((s) => [s, { pools: by(s).length, usdTotal: tvl(by(s)) }]),
);
console.log(JSON.stringify(summary, null, 2));
const outFile = args.out ?? join(root, ".parity", `${chain}-${block}.json`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify({ chain, block, seed: Number(args.seed ?? 1), random: nRandom, summary, results }, (_, x) => (typeof x === "bigint" ? x.toString() : x), 1),
);
console.log(`report: ${outFile}`);
