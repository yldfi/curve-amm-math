// Records the JSON-RPC traffic of rpc.detectPool / rpc.readPoolState for a
// set of pools at one block, plus each pool's own get_virtual_price and one
// get_dy, into src/__fixtures__/rpc-pools-recorded.json. src/rpc/pools.test.ts
// replays it offline. Run after `pnpm build`:
//
//   RPC_URL=<ethereum archive rpc> node scripts/parity/record.mjs [--block N]
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rpc = await import(pathToFileURL(join(root, "dist", "rpc", "index.mjs")).href);
const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) throw new Error("RPC_URL is required");
const blockArg = process.argv.indexOf("--block");
const block = blockArg > 0 ? Number(process.argv[blockArg + 1]) : 26236847;

// One pool per detector branch
const POOLS = [
  ["3pool (main, no A_precise, no token())", "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7", "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490"],
  ["compound (lending, no calc_withdraw_one_coin)", "0xA2B47E3D5c44877cca798226B7B8118F9BFb7A56", "0x845838DF265Dcd2c412A1Dc9e959c7d08537f8a2"],
  ["aave (offpeg)", "0xDeBF20617708857ebe4F679508E7b7863a8A8EeE", "0xFd2a8fA60Abd58Efe3EeE34dd494cD491dC14900"],
  ["ETH/rETH (getExchangeRate, no -1)", "0xF9440930043eb3997fc70e1339dBb11F341de7A8", "0x53a901d48795C58f485cBB38df08FA96a24669D5"],
  ["RAI3CRV (redemption-price rate)", "0x618788357D0EBd8A37e763ADab3bc575D54c2C7d", "0x6BA5b4e438FA0aAf7C1bD179285aF65d13bD3D90"],
  ["Origin v1 metapool (forwarder proxy, no base_pool)", "0x87650D7bbfC3A9F10587d7778206671719d9910D"],
  ["USDV-3crv (stable-ng metapool, BASE_POOL)", "0x00e6Fd108C4640d21B40d02f18Dd6fE7c7F725CA"],
  ["crvUSD-STBT (crvUSD factory v5.0.0)", "0x707EAe1CcFee0B8fef07D3F18EAFD1246762d587"],
  ["crvUSD/USDC (crvUSD factory v6.0.1)", "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E"],
  ["agEUR/ibEUR (factory v1 plain2basic)", "0xB37D6c07482Bc11cd28a1f11f1a6ad7b66Dec933"],
  ["stETH-ng (factory v1, stored_rates)", "0x21E27a5E5513D6e65C4f830167390997aA84843a"],
  ["Euro pool (factory v1 plain3basic)", "0xe7A3b38c39F97E977723bd1239C3470702568e7B"],
  ["EUROC/3Crv (CurveCryptoSwap2, single-div newton_y)", "0xE84f5b1582BA325fDf9cE6B0c1F087ccfC924e54"],
  ["tricrypto2", "0xD51a44d3FaE010294C616388b506AcdA1bfAAE46"],
  ["tricrypto v1", "0x80466c64868E1ab14a1Ddf27A676C3fcBE638Fe5"],
  ["TriDBR (tricrypto-ng v2.0.1)", "0x66da369fC5dBBa0774Da70546Bd20F2B242Cd34d"],
  ["SPOT/USDC (twocrypto-ng v2.1.0)", "0x256fbdA404B96A283b1Ae851b465D4B9601C25a6"],
  ["Yield Basis cbBTC (twocrypto v3.0.0)", "0x862CB4E988FB66E72f128d1183829f8c05B6c6A0"],
  ["Strategic USD Reserves (stable-ng plain)", "0x4f493B7dE8aAC7d55F71853688b1F7C8F0243C85"],
  ["busd (yearn lending, get_dy without - 1)", "0x79a8C46DeA5aDa233ABaFFD40F3A0A2B1e5A4F27", "0x3B3Ac5386837Dc563660FB6a0937DFAa5924333B"],
  ["4pool (main pool with a version)", "0x4e0915C88bC70750D68C481540F081fEFaF22273"],
  ["crvUSD/WETH Oraclized Policy (dynamic POLICY)", "0x846254836ab71E53fa66FAdB95129036C837C030"],
  ["WBTC-USDC Pilot (stable-ng without stored_rates)", "0x0dda89A44BACAaF11a2c3183E4B44DfF6f13f2e6"],
  // near-empty factory v1 metapools: get_dy_underlying reverts, so detection reads the code; every view reverts
  ["Titanium Dollar metapool (forwarder proxy, near-empty)", "0xA77d09743F77052950C4eb4e6547E9665299BecD"],
  ["SORA TBC Dollar metapool (EIP-1167, zero supply)", "0x110cc323ca53d622469EdD217387E2E6B33F1dF5"],
  ["REUSD/3Crv (coin 0 has no decimals(): MetaRegistry decimals)", "0xC61557C5d177bd7DC889A3b621eEC333e168f68A"],
];

const recorded = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  const json = await res.json();
  const req = JSON.parse(init.body);
  const reqs = Array.isArray(req) ? req : [req];
  const resps = Array.isArray(json) ? json : [json];
  const byId = new Map(resps.map((r) => [r.id, r]));
  for (const r of reqs) {
    const resp = byId.get(r.id);
    if (resp) recorded.set(JSON.stringify([r.method, r.params]), resp.error ? { error: resp.error } : { result: resp.result });
  }
  return new Response(JSON.stringify(json), { status: res.status, headers: { "Content-Type": "application/json" } });
};

const u = (x) => BigInt(x).toString(16).padStart(64, "0");
const cases = [];
for (const [name, pool, lpToken] of POOLS) {
  const descriptor = await rpc.detectPool(rpcUrl, pool, { blockTag: block, lpToken });
  const entry = { name, pool, lpToken, descriptor };
  if (descriptor.family !== "unsupported") {
    const state = await rpc.readPoolState(rpcUrl, pool, { blockTag: block, lpToken, descriptor });
    const balances = state.family === "tricryptoLegacy" ? state.state.params.balances : state.params.balances;
    const crypto = state.family !== "stableswap";
    // 0 -> 1, or 1 -> 0 where the pool reverts on the first (SPOT/USDC)
    const swaps = [[0, 1], [1, 0]].map(([i, j]) => ({ i, j, dx: balances[i] / 1000n }));
    const [vp, ...dys] = await rpc.batchRpcRawCalls(
      rpcUrl,
      [{ to: pool, data: "0xbb7b8b80" }, ...swaps.map(({ i, j, dx }) => ({ to: pool, data: (crypto ? "0x556d6e9f" : "0x5e0d443f") + u(i) + u(j) + u(dx) }))],
      { blockTag: block },
    );
    // null where the pool's own view reverts (near-empty pools)
    entry.get_virtual_price = vp === null ? null : BigInt(vp.slice(0, 66)).toString();
    const k = Math.max(0, dys.findIndex((d) => d !== null));
    entry.get_dy = { ...swaps[k], dx: swaps[k].dx.toString(), result: dys[k] === null ? null : BigInt(dys[k].slice(0, 66)).toString() };
    if (state.family === "tricryptoLegacy") {
      // calc_token_amount(uint256[3],bool), 0.1% of each balance in and out
      const amounts = balances.map((b) => b / 1000n);
      const ctas = await rpc.batchRpcRawCalls(
        rpcUrl,
        [true, false].map((d) => ({ to: pool, data: "0x3883e119" + amounts.map(u).join("") + u(d ? 1 : 0) })),
        { blockTag: block },
      );
      entry.calc_token_amount = [true, false].map((isDeposit, n) => ({
        amounts: amounts.map(String),
        isDeposit,
        result: BigInt(ctas[n].slice(0, 66)).toString(),
      }));
    }
  }
  cases.push(entry);
  console.log(`${descriptor.family.padEnd(20)} ${name}`);
}

const out = join(root, "src", "__fixtures__", "rpc-pools-recorded.json");
writeFileSync(
  out,
  JSON.stringify(
    {
      description: `rpc.detectPool / rpc.readPoolState JSON-RPC traffic at Ethereum block ${block}, recorded by scripts/parity/record.mjs; get_virtual_price and get_dy are the pools' own views at that block`,
      block,
      cases,
      responses: Object.fromEntries([...recorded].sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    1,
  ) + "\n",
);
console.log(`${recorded.size} responses -> ${out}`);
