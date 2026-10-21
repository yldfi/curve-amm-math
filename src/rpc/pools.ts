/**
 * Pool detection and state readers: probe a pool's views to decide which
 * exact module (and which flags) quote it, then read its state at one block
 * into a `pools.PoolState`.
 */

import * as stableswapExact from "../stableswap-exact";
import type { StableLiquidityParams, StableSwapVariant } from "../stableswap-exact";
import type { PoolState, StableswapPoolState } from "../pools";
import * as tricryptoNg from "../tricrypto-ng";
import * as twocryptoOptimized from "../twocrypto-optimized";
import * as twocryptoStableswap from "../twocrypto-stableswap";
import type { BatchRpcOptions, RpcCall } from "./index";
import { encodeUint256, getTricryptoLegacyState } from "./index";
import type { CurveRpc, RpcTarget } from "./transport";
import { throwIfAborted } from "./transport";

/** Where a StableSwap pool's `rates` come from */
export type StableRateSource =
  /** `10^(36 - decimals)` per coin */
  | { kind: "decimals" }
  /** The pool's `stored_rates()` */
  | { kind: "stored_rates" }
  /** Per coin: plain, a Compound-style cToken, or a yearn v1 yToken (lending pools) */
  | { kind: "lending"; tokens: ("plain" | "compound" | "yearn")[] }
  /** ETH/rETH: coin 1 is rETH, rate `getExchangeRate()` */
  | { kind: "reth" }
  /** ETH/aETH: coin 1 is ankr aETH, rate `1e36 / ratio()` */
  | { kind: "aeth" }
  /** Coin 1's rate is `ORACLE.latestAnswer()` (ETH/wstETH on L2s) */
  | { kind: "oracle"; oracle: string }
  /** Metapool: `[10^(36 - decimals0), base virtual price]` */
  | { kind: "metapool" }
  /** RAI3CRV: `[snappedRedemptionPrice() / 1e9, base virtual price]` */
  | { kind: "rai"; snap: string };

interface DescriptorBase {
  pool: string;
  /** EIP-1167 implementation, when the pool is a minimal proxy */
  implementation?: string;
  /** `version()`, when the pool has it */
  version?: string;
}

/** A StableSwap pool, with the `stableswapExact` flags it needs */
export interface StableswapDescriptor extends DescriptorBase {
  family: "stableswap";
  variant: StableSwapVariant;
  nCoins: number;
  /** 1 for pools without `A_precise()` (3pool-era), else 100 */
  ampPrecision: bigint;
  rates: StableRateSource;
  /** Set (false) when the `calc_token_amount` view omits the imbalance fee */
  calcTokenAmountFee?: boolean;
  /** Set (false) for pools whose `get_dy` does not subtract 1 wei */
  getDySubtractOne?: boolean;
  /** Metapools: the base pool */
  basePool?: string;
  /** Contract holding `totalSupply()` (the pool itself for factory pools) */
  lpToken: string;
  /** False for the lending pools without `calc_withdraw_one_coin` */
  hasCalcWithdrawOneCoin: boolean;
  /** `balances` / `coins` take int128 (Vyper 0.1 pools) */
  int128Args: boolean;
}

/** A classic 2-coin CurveCryptoSwap2 pool */
export interface CryptoswapDescriptor extends DescriptorBase {
  family: "cryptoswap";
  lpToken: string;
  /** EUROC/3Crv's `newton_y` rounding */
  newtonYSingleDivMul2?: boolean;
}

export interface TricryptoLegacyDescriptor extends DescriptorBase {
  family: "tricryptoLegacy";
}

/** Tricrypto-NG / Twocrypto-NG / Twocrypto on StableswapMath */
export interface CryptoNgDescriptor extends DescriptorBase {
  family: "tricryptoNg" | "twocryptoOptimized" | "twocryptoStableswap";
  version: string;
  /** `MATH()` (an L2 deployment is accepted when its code matches the Ethereum one) */
  math: string;
  /** `POLICY()` (Twocrypto v3.0.0) */
  policy?: string;
}

/** A pool no exact module covers, and why */
export interface UnsupportedDescriptor extends DescriptorBase {
  family: "unsupported";
  reason: string;
}

export type PoolDescriptor =
  | StableswapDescriptor
  | CryptoswapDescriptor
  | TricryptoLegacyDescriptor
  | CryptoNgDescriptor
  | UnsupportedDescriptor;

/** Options for {@link detectPool} and {@link readPoolState} */
export interface PoolReadOptions {
  /** Block to read at (default "latest", resolved once so every read uses the same block) */
  blockTag?: BatchRpcOptions["blockTag"];
  /** Timeout in milliseconds for each RPC request to an RPC URL (default 30000; a transport times out on its own) */
  timeout?: number;
  /** eth_calls per JSON-RPC batch, or per `CurveRpc.call` (default 100; some providers accept fewer) */
  batchSize?: number;
  /** Aborts the reads: the URL path stops retrying and rejects with the signal's reason; a transport receives it */
  signal?: AbortSignal;
  /**
   * LP token, for StableSwap pools that are not their own LP token and have
   * no `lp_token()` / `token()` view (3pool, compound, …)
   */
  lpToken?: string;
}

const ETH_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** crvUSD StableSwap factory (Ethereum); its pools report `factory()` */
const CRVUSD_FACTORY = "0x4f8846ae9380b90d2e71d5e3d042dff3e7ebb40d";
/** Ethereum MetaRegistry: `get_pool_from_lp_token` finds old metapools' base pools */
const META_REGISTRY = "0xf98b45fa17de75fb1ad0e7afd971b0ca00e379fc";
/** The y and busd pools: `get_dy` without the `- 1` */
const NO_SUBTRACT_ONE = ["0x45f783cce6b7ff23b2ab2d70e416cdb7d6055f51", "0x79a8c46dea5ada233abaffd40f3a0a2b1e5a4f27"];
/** EUROC/3Crv: CurveCryptoSwap2 with a single-division `newton_y` */
const EUROC_3CRV = "0xe84f5b1582ba325fdf9ce6b0c1f087ccfc924e54";
const MAX_COINS = 8;

/**
 * SHA-256 of the runtime code of each MATH contract the crypto-NG modules
 * port, mapped to its Ethereum address. The L2 deployments are separate
 * contracts with the same code; the detector recognises them by code.
 */
const MATH_BY_CODE_SHA256: Record<string, string> = {
  "11c6ace08c415580a7ba646cf686f92e649ec9ddcc544e5b9c808e137b7983de": "0xcbff3004a20dbfe2731543aa38599a526e0fd6ee",
  // Base 0x5373e1b9…: the same verified CurveTricryptoMathOptimized source, compiled differently
  "4325d360326feee3d5c08b5d5c76a3249cec14b881c77e041c655e27802ed12e": "0xcbff3004a20dbfe2731543aa38599a526e0fd6ee",
  d092fc8d7aaf3b8d0a4adca938fd002cc46a9a753cffec36c6783fd4d66e5c8c: "0x1fd8af16dc4bebd950521308d55d0543b6cdf4a1",
  "7a71b0a681f5ecde922b2ae21ce9d9e61c34a16641ff65a2105349b4f7d23456": "0x2005995a71243be9fb995dab4742327dc76564df",
  "1b37606b3a1cee409ca73dc206707b71716343e79d9897f3d0eb5058c78d2b3f": "0xbfddf58cb6ef84e115ff47c10e49a80b2653ea13",
  d27729f9d38d144c4af642c9bd95de192c842465d1657d9df6edcc11abdcdef9: "0x79839c2d74531a8222c0f555865aac1834e82e51",
};

async function sha256Hex(hex: string): Promise<string> {
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.slice(2 + 2 * k, 4 + 2 * k), 16);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The Ethereum MATH address whose code `math` has, or `math` itself */
async function canonicalMath(ctx: Ctx, math: string): Promise<string> {
  const code = (await request(ctx, "eth_getCode", [math, ctx.block])) as string;
  if (!code || code === "0x") return math;
  return MATH_BY_CODE_SHA256[await sha256Hex(code)] ?? math;
}

const SIG = {
  version: "0x54fd4d50",
  MATH: "0xed6c1546",
  gamma: "0xb1373929",
  priceScale: "0xb9e8c9fd",
  priceScaleI: "0xa3f7cdd5",
  A: "0xf446c1d0",
  APrecise: "0x76a2f0f0",
  fee: "0xddca3f43",
  storedRates: "0xfd0684b1",
  offpeg: "0x8edfdd5f",
  basePool: "0x5d6362bb",
  redemptionPriceSnap: "0x85cab755",
  snappedRedemptionPrice: "0x6998c48d",
  POLICY: "0xdadbccee",
  factory: "0xc45a0155",
  token: "0xfc0c546a",
  lpToken: "0x82c63066",
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
  D: "0x0f529ba2",
  midFee: "0x92526c0c",
  outFee: "0xee8de675",
  feeGamma: "0x72d4f0e2",
  precisions: "0x3620604b",
  futureAGammaTime: "0xf9ed9597",
  lastTimestamp: "0x4d23bfa0",
  getVirtualPrice: "0xbb7b8b80",
  baseVirtualPrice: "0x95ccc02f",
  baseCacheUpdated: "0x8296f84f",
  coinsU: "0xc6610657",
  coinsI: "0x23746eb8",
  balancesU: "0x4903b0d1",
  balancesI: "0x065a80d8",
  underlyingCoinsU: "0xb9947eb0",
  underlyingCoinsI: "0xb739953e",
  cwoI: "0xcc2b27d7",
  cwoU: "0x4fb08c5e",
  exchangeRateStored: "0x182df0f5",
  supplyRatePerBlock: "0xae9d70b0",
  accrualBlockNumber: "0x6c540baf",
  getPricePerFullShare: "0x77c7b8fc",
  getExchangeRate: "0xe6aa216c",
  ratio: "0x71ca337d",
  donationShares: "0xa3bdf1b7",
  donationProtectionExpiryTs: "0xd046b4ca",
  donationProtectionPeriod: "0x1f88619c",
  donationSharesMaxRatio: "0x3d2699f2",
  minter: "0x07546172",
  BASE_POOL: "0x71511a5e",
  oracle: "0x7dc0d1d0",
  latestAnswer: "0x50d25bcd",
  getPoolFromLpToken: "0xbdf475c3",
  getDyUnderlyingI: "0x07211ef7",
} as const;

// ----------------------------------------------------------------------------
// JSON-RPC plumbing
// ----------------------------------------------------------------------------

interface Ctx {
  rpc: CurveRpc;
  /** What the caller passed, for the `rpc` helpers this module delegates to */
  source: RpcTarget;
  /** Hex block number every read is pinned to */
  block: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  timeout: number;
  batchSize: number;
  signal?: AbortSignal;
}

async function rpcRequestRaw(rpcUrl: string, body: unknown, timeout: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC request failed: HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Run `attempt` up to 4 times with backoff; an abort is thrown at once, never retried */
async function withRetries<T>(signal: AbortSignal | undefined, attempt: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let k = 0; k < 4; k++) {
    throwIfAborted(signal);
    if (k > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** k));
    throwIfAborted(signal);
    try {
      return await attempt();
    } catch (e) {
      throwIfAborted(signal);
      last = e;
    }
  }
  throw last;
}

const REVERT = /revert|invalid opcode|out of gas|stack underflow|bad instruction|vm exception/i;

/**
 * The RPC URL path as a {@link CurveRpc}: one JSON-RPC batch per `call`,
 * reverts (code 3 or a revert message) read as null, and every other error
 * retried, then thrown, so a failed read is never mistaken for a missing view.
 */
function urlRpc(rpcUrl: string, timeout: number): CurveRpc {
  return {
    request: (method, params, { signal }) =>
      withRetries(signal, async () => {
        const json = (await rpcRequestRaw(rpcUrl, { jsonrpc: "2.0", id: 1, method, params }, timeout, signal)) as {
          result?: unknown;
          error?: { message: string };
        };
        if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
        return json.result;
      }),
    call: (list, { blockTag, signal }) => {
      const body = list.map((c, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [c, blockTag] }));
      return withRetries(signal, async () => {
        const res = (await rpcRequestRaw(rpcUrl, body, timeout, signal)) as {
          id: number;
          result?: string;
          error?: { code?: number; message?: string };
        }[];
        if (!Array.isArray(res)) throw new Error("batch eth_call: non-array response");
        const byId = new Map(res.map((r) => [r.id, r]));
        return list.map((c, id) => {
          const r = byId.get(id);
          if (!r) throw new Error(`batch eth_call: no response for ${c.to}`);
          if (r.error) {
            if (r.error.code === 3 || REVERT.test(r.error.message ?? "")) return null;
            throw new Error(`eth_call to ${c.to} failed: ${r.error.message}`);
          }
          return r.result && r.result !== "0x" ? r.result : null;
        });
      });
    },
  };
}

function request(ctx: Ctx, method: string, params: unknown[]): Promise<unknown> {
  throwIfAborted(ctx.signal);
  return ctx.rpc.request(method, params, { signal: ctx.signal });
}

async function context(source: RpcTarget, options: PoolReadOptions): Promise<Ctx> {
  const timeout = options.timeout ?? 30000;
  const rpc = typeof source === "string" ? urlRpc(source, timeout) : source;
  let tag: string;
  const bt = options.blockTag;
  if (bt === undefined) tag = "latest";
  else if (typeof bt === "string") tag = bt;
  else tag = "0x" + BigInt(bt).toString(16);
  throwIfAborted(options.signal);
  const block = (await rpc.request("eth_getBlockByNumber", [tag, false], { signal: options.signal })) as {
    number: string;
    timestamp: string;
  } | null;
  if (!block) throw new Error(`block ${tag} not found`);
  return {
    rpc,
    source,
    block: block.number,
    blockNumber: BigInt(block.number),
    blockTimestamp: BigInt(block.timestamp),
    timeout,
    batchSize: options.batchSize ?? 100,
    signal: options.signal,
  };
}

/**
 * eth_call each [to, data] at the context block: null when the call reverts
 * or returns nothing. Any other error (rate limit, pruned state, transport)
 * rejects (after retries, for an RPC URL), so a failed read is never mistaken
 * for a missing view.
 */
async function calls(ctx: Ctx, list: RpcCall[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let k = 0; k < list.length; k += ctx.batchSize) out.push(...(await chunk(ctx, list.slice(k, k + ctx.batchSize))));
  return out;
}

async function chunk(ctx: Ctx, list: RpcCall[]): Promise<(string | null)[]> {
  throwIfAborted(ctx.signal);
  const res = await ctx.rpc.call(list, { blockTag: ctx.block, signal: ctx.signal });
  if (res.length !== list.length) {
    throw new Error(`eth_call: ${res.length} results for ${list.length} calls`);
  }
  return res.map((r) => (r && r !== "0x" ? r : null));
}

function word(raw: string | null, index = 0): bigint | null {
  if (raw === null) return null;
  const hex = raw.slice(2 + index * 64, 2 + (index + 1) * 64);
  return hex.length === 64 ? BigInt("0x" + hex) : null;
}

function need(raw: string | null, what: string, pool: string): bigint {
  const v = word(raw);
  if (v === null) throw new Error(`${what} failed on ${pool}`);
  return v;
}

function address(raw: string | null): string | null {
  const v = word(raw);
  return v === null ? null : "0x" + v.toString(16).padStart(40, "0");
}

function decodeString(raw: string | null): string | null {
  if (raw === null || raw.length < 2 + 128) return null;
  const offset = Number(word(raw, 0));
  const start = 2 + offset * 2;
  const len = Number(BigInt("0x" + raw.slice(start, start + 64)));
  const bytes = raw.slice(start + 64, start + 64 + len * 2);
  if (bytes.length !== len * 2 || len > 64) return null;
  let s = "";
  for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  return s;
}

/** `n` uint256 words of a static or dynamic array return */
function words(raw: string | null, n: number): bigint[] | null {
  if (raw === null) return null;
  const count = (raw.length - 2) / 64;
  if (count === n) return Array.from({ length: n }, (_, k) => word(raw, k)!);
  if (count === n + 2 && word(raw, 0) === 32n && word(raw, 1) === BigInt(n)) {
    return Array.from({ length: n }, (_, k) => word(raw, k + 2)!);
  }
  return null;
}

const arg = (selector: string, ...args: (bigint | number)[]) =>
  selector + args.map((a) => encodeUint256(BigInt(a))).join("");

async function implementationOf(ctx: Ctx, pool: string): Promise<string | undefined> {
  const code = ((await request(ctx, "eth_getCode", [pool, ctx.block])) as string) ?? "0x";
  // EIP-1167 (363d3d373d3d3d363d73 <impl> 5af4…) or Vyper's create_forwarder_to
  // (366000600037611000600036600073 <impl> 5af4…)
  const m =
    /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code) ??
    /^0x366000600037611000600036600073([0-9a-f]{40})5af4602c57600080fd5b6110006000f3$/i.exec(code);
  return m ? "0x" + m[1].toLowerCase() : undefined;
}

async function decimalsOf(ctx: Ctx, tokens: string[]): Promise<number[]> {
  const raw = await calls(
    ctx,
    tokens.map((t) => ({ to: t, data: SIG.decimals }))
  );
  return tokens.map((t, k) => {
    if (t.toLowerCase() === ETH_PLACEHOLDER) return 18;
    const d = word(raw[k]);
    if (d === null) throw new Error(`decimals() failed on ${t}`);
    return Number(d);
  });
}

// ----------------------------------------------------------------------------
// Detection
// ----------------------------------------------------------------------------

async function probeCoins(ctx: Ctx, pool: string): Promise<{ coins: string[]; int128Args: boolean }> {
  const list: RpcCall[] = [];
  for (let k = 0; k < MAX_COINS; k++) {
    list.push({ to: pool, data: arg(SIG.coinsU, k) }, { to: pool, data: arg(SIG.coinsI, k) });
  }
  const raw = await calls(ctx, list);
  const u: string[] = [];
  const i: string[] = [];
  for (let k = 0; k < MAX_COINS; k++) {
    const a = address(raw[2 * k]);
    const b = address(raw[2 * k + 1]);
    if (a && a !== ZERO_ADDRESS && u.length === k) u.push(a);
    if (b && b !== ZERO_ADDRESS && i.length === k) i.push(b);
  }
  return u.length >= i.length ? { coins: u, int128Args: false } : { coins: i, int128Args: true };
}

/**
 * Decide which exact module quotes `pool`, and with which flags, from its
 * views (`version()`, `MATH()`, `gamma()`, `price_scale`, `A_precise()`,
 * `stored_rates()`, `base_pool()`, `factory()`, the coins' rate views) and
 * its EIP-1167 implementation. Pools it cannot place return
 * `{ family: "unsupported", reason }` rather than a guess.
 */
export async function detectPool(
  rpc: RpcTarget,
  pool: string,
  options: PoolReadOptions = {}
): Promise<PoolDescriptor> {
  return detectWith(await context(rpc, options), pool, options.lpToken);
}

async function detectWith(ctx: Ctx, poolIn: string, lpTokenIn?: string): Promise<PoolDescriptor> {
  const pool = poolIn.toLowerCase();
  const [implementation, raw] = await Promise.all([
    implementationOf(ctx, pool),
    calls(
      ctx,
      [
        SIG.version,
        SIG.MATH,
        SIG.gamma,
        SIG.priceScale,
        arg(SIG.priceScaleI, 0),
        SIG.APrecise,
        SIG.storedRates,
        SIG.offpeg,
        SIG.basePool,
        SIG.redemptionPriceSnap,
        SIG.POLICY,
        SIG.factory,
        SIG.totalSupply,
        SIG.token,
        SIG.lpToken,
        SIG.A,
        SIG.BASE_POOL,
      ].map((data) => ({ to: pool, data }))
    ),
  ]);
  const [
    versionRaw,
    mathRaw,
    gammaRaw,
    priceScaleRaw,
    priceScaleIRaw,
    aPreciseRaw,
    storedRatesRaw,
    offpegRaw,
    basePoolRaw,
    snapRaw,
    policyRaw,
    factoryRaw,
    totalSupplyRaw,
    tokenRaw,
    lpTokenRaw,
    aRaw,
    basePoolNgRaw,
  ] = raw;
  const version = decodeString(versionRaw) ?? undefined;
  const base: DescriptorBase = { pool, implementation, version };
  const unsupported = (reason: string): UnsupportedDescriptor => ({ ...base, family: "unsupported", reason });

  if (aRaw === null) return unsupported("no A(): not a Curve pool");

  // CryptoSwap families
  if (gammaRaw !== null) {
    const twoCoin = priceScaleRaw !== null;
    if (!twoCoin && priceScaleIRaw === null) return unsupported("gamma() but no price_scale");
    if (version === undefined) {
      if (!twoCoin) return { ...base, family: "tricryptoLegacy" };
      const lpToken = address(tokenRaw);
      if (!lpToken) return unsupported("CurveCryptoSwap2 without token()");
      return {
        ...base,
        family: "cryptoswap",
        lpToken,
        ...(pool === EUROC_3CRV && { newtonYSingleDivMul2: true }),
      };
    }
    const mathRawAddress = address(mathRaw);
    if (!mathRawAddress) return unsupported(`crypto pool ${version} without MATH()`);
    const math = await canonicalMath(ctx, mathRawAddress);
    let family: CryptoNgDescriptor["family"];
    try {
      if (!twoCoin) {
        tricryptoNg.assertSupportedImplementation(version, math);
        family = "tricryptoNg";
      } else if ((twocryptoStableswap.SUPPORTED_POOL_VERSIONS as readonly string[]).includes(version)) {
        twocryptoStableswap.assertSupportedImplementation(version, math);
        family = "twocryptoStableswap";
      } else {
        twocryptoOptimized.assertSupportedImplementation(version, math);
        family = "twocryptoOptimized";
      }
    } catch (e) {
      return unsupported((e as Error).message);
    }
    const policy = address(policyRaw) ?? undefined;
    return { ...base, family, version, math: mathRawAddress, ...(policy && { policy }) };
  }

  // StableSwap families
  const { coins, int128Args } = await probeCoins(ctx, pool);
  if (coins.length < 2) return unsupported("fewer than 2 coins");
  const nCoins = coins.length;
  const basePool =
    address(basePoolRaw) ?? address(basePoolNgRaw) ?? (await impliedBasePool(ctx, pool, coins[nCoins - 1]));
  const lpToken =
    lpTokenIn?.toLowerCase() ?? (totalSupplyRaw !== null ? pool : (address(lpTokenRaw) ?? address(tokenRaw)));
  if (!lpToken) return unsupported("no totalSupply(), lp_token() or token(): pass lpToken");
  const ampPrecision = aPreciseRaw !== null ? 100n : 1n;
  const stable = {
    ...base,
    family: "stableswap" as const,
    nCoins,
    ampPrecision,
    lpToken,
    int128Args,
    ...(basePool && { basePool }),
  };
  const factory = address(factoryRaw);
  const snap = address(snapRaw);

  // StableSwap-NG (plain and meta): version v7+, stored_rates() and offpeg
  if (version && /^v7\./.test(version) && storedRatesRaw !== null) {
    return { ...stable, variant: "ng", rates: { kind: "stored_rates" }, hasCalcWithdrawOneCoin: true };
  }
  // crvUSD factory: "plain"; v5.0.0's calc_token_amount view has no fee
  if (factory === CRVUSD_FACTORY) {
    return {
      ...stable,
      variant: "plain",
      rates: storedRatesRaw !== null ? { kind: "stored_rates" } : { kind: "decimals" },
      hasCalcWithdrawOneCoin: true,
      ...(version === "v5.0.0" && { calcTokenAmountFee: false }),
    };
  }
  // Metapools (main and factory v1): legacy, rates [10^(36-d0), base vp]
  if (basePool) {
    return {
      ...stable,
      variant: "legacy",
      rates: snap ? { kind: "rai", snap } : { kind: "metapool" },
      hasCalcWithdrawOneCoin: true,
    };
  }
  // Factory v1 plain pools (EIP-1167 proxies): 2 coins unroll get_D like
  // "plain" with a fee-less calc_token_amount; 3-4 coins are "legacy"
  if (implementation) {
    const rates: StableRateSource = storedRatesRaw !== null ? { kind: "stored_rates" } : { kind: "decimals" };
    return nCoins === 2
      ? { ...stable, variant: "plain", rates, calcTokenAmountFee: false, hasCalcWithdrawOneCoin: true }
      : { ...stable, variant: "legacy", rates, hasCalcWithdrawOneCoin: true };
  }
  if (version && /^v7\./.test(version)) {
    // NG pools always have stored_rates(); it reverts when a coin's rate
    // oracle does (stale or broken), and then so do all the pool's views
    return unsupported(`StableSwap-NG ${version}: stored_rates() reverts (rate oracle failing; the pool's own views revert too)`);
  }

  // Main-registry pools (full contracts; the newer ones report v5/v6 versions)
  if (offpegRaw !== null) {
    return { ...stable, variant: "aave", rates: { kind: "decimals" }, hasCalcWithdrawOneCoin: true };
  }
  const rateProbe = await calls(
    ctx,
    coins.flatMap((c) =>
      [SIG.exchangeRateStored, SIG.getPricePerFullShare, SIG.getExchangeRate, SIG.ratio].map((data) => ({
        to: c,
        data,
      }))
    )
  );
  const tokens = coins.map((_, k): "plain" | "compound" | "yearn" =>
    rateProbe[4 * k] !== null ? "compound" : rateProbe[4 * k + 1] !== null ? "yearn" : "plain"
  );
  const cwo = await calls(ctx, [
    { to: pool, data: arg(int128Args ? SIG.cwoI : SIG.cwoU, 10n ** 12n, 0) },
    { to: pool, data: arg(int128Args ? SIG.cwoU : SIG.cwoI, 10n ** 12n, 0) },
  ]);
  const hasCalcWithdrawOneCoin = cwo[0] !== null || cwo[1] !== null;
  if (tokens.some((t) => t !== "plain")) {
    return {
      ...stable,
      variant: "legacy",
      rates: { kind: "lending", tokens },
      hasCalcWithdrawOneCoin,
      ...(NO_SUBTRACT_ONE.includes(pool) && { getDySubtractOne: false }),
    };
  }
  if (nCoins === 2) {
    const [oracleRaw] = await calls(ctx, [{ to: pool, data: SIG.oracle }]);
    const oracle = word(oracleRaw);
    if (oracle !== null && oracle > 0n && oracle < 1n << 160n) {
      return {
        ...stable,
        variant: "legacy",
        rates: { kind: "oracle", oracle: address(oracleRaw)! },
        getDySubtractOne: false,
        hasCalcWithdrawOneCoin,
      };
    }
  }
  if (nCoins === 2 && coins[0].toLowerCase() === ETH_PLACEHOLDER) {
    if (rateProbe[4 + 2] !== null) {
      return { ...stable, variant: "legacy", rates: { kind: "reth" }, getDySubtractOne: false, hasCalcWithdrawOneCoin };
    }
    if (rateProbe[4 + 3] !== null) {
      return { ...stable, variant: "legacy", rates: { kind: "aeth" }, getDySubtractOne: false, hasCalcWithdrawOneCoin };
    }
  }
  return {
    ...stable,
    variant: "legacy",
    rates: storedRatesRaw !== null ? { kind: "stored_rates" } : { kind: "decimals" },
    hasCalcWithdrawOneCoin,
  };
}

/**
 * Old factory metapools have no `base_pool()`: when `get_dy_underlying`
 * answers and the last coin is a Curve LP token (its `minter()`, the
 * Ethereum MetaRegistry's `get_pool_from_lp_token`, or the coin itself when
 * the base pool is its own LP token), that pool is the base.
 */
async function impliedBasePool(ctx: Ctx, pool: string, lastCoin: string): Promise<string | undefined> {
  const [minterRaw, registryRaw, underlyingRaw] = await calls(ctx, [
    { to: lastCoin, data: SIG.minter },
    { to: META_REGISTRY, data: SIG.getPoolFromLpToken + lastCoin.slice(2).padStart(64, "0") },
    { to: pool, data: arg(SIG.getDyUnderlyingI, 1, 0, 10n ** 6n) },
  ]);
  if (underlyingRaw === null) return undefined;
  // a base pool that is its own LP token (Arbitrum 2pool) is the last coin itself
  const found = [address(minterRaw), address(registryRaw), lastCoin.toLowerCase()].find(
    (a) => a && a !== ZERO_ADDRESS
  );
  const minter = found!;
  const [aRaw] = await calls(ctx, [{ to: minter, data: SIG.A }]);
  return aRaw === null ? undefined : minter;
}

// ----------------------------------------------------------------------------
// State readers
// ----------------------------------------------------------------------------

/**
 * Detect `pool` (unless `descriptor` is given) and read its state at one
 * block into a {@link PoolState} for the `pools` quote functions.
 *
 * @throws Error for unsupported pools (with the detector's reason) and failed reads
 */
export async function readPoolState(
  rpc: RpcTarget,
  pool: string,
  options: PoolReadOptions & { descriptor?: PoolDescriptor } = {}
): Promise<PoolState> {
  const ctx = await context(rpc, options);
  const d = options.descriptor ?? (await detectWith(ctx, pool, options.lpToken));
  return readWith(ctx, d);
}

async function readWith(ctx: Ctx, d: PoolDescriptor): Promise<PoolState> {
  switch (d.family) {
    case "unsupported":
      throw new Error(`readPoolState: ${d.pool} is not supported: ${d.reason}`);
    case "stableswap":
      return readStable(ctx, d);
    case "tricryptoLegacy": {
      const state = await getTricryptoLegacyState(ctx.source, d.pool, {
        blockTag: ctx.block,
        timeout: ctx.timeout,
        signal: ctx.signal,
      });
      return { family: "tricryptoLegacy", pool: d.pool, state };
    }
    case "cryptoswap":
      return readCryptoswap(ctx, d);
    default:
      return readCryptoNg(ctx, d);
  }
}

async function readStable(ctx: Ctx, d: StableswapDescriptor): Promise<StableswapPoolState> {
  const { pool, nCoins } = d;
  const head: RpcCall[] = [
    { to: pool, data: SIG.A },
    { to: pool, data: SIG.APrecise },
    { to: pool, data: SIG.fee },
    { to: pool, data: SIG.offpeg },
    { to: pool, data: SIG.storedRates },
    { to: d.lpToken, data: SIG.totalSupply },
    { to: pool, data: SIG.baseVirtualPrice },
    { to: pool, data: SIG.baseCacheUpdated },
  ];
  for (let k = 0; k < nCoins; k++) {
    head.push({ to: pool, data: arg(d.int128Args ? SIG.balancesI : SIG.balancesU, k) });
    head.push({ to: pool, data: arg(d.int128Args ? SIG.coinsI : SIG.coinsU, k) });
  }
  const raw = await calls(ctx, head);
  const A = need(raw[0], "A()", pool);
  const ampPrecise = d.ampPrecision === 1n ? A : need(raw[1], "A_precise()", pool);
  const balances: bigint[] = [];
  const coins: string[] = [];
  for (let k = 0; k < nCoins; k++) {
    balances.push(need(raw[8 + 2 * k], `balances(${k})`, pool));
    coins.push(address(raw[9 + 2 * k])!);
  }

  let rates: bigint[];
  let base: StableLiquidityParams | undefined;
  if (d.basePool) {
    // the metapool's last coin is the base pool's LP token
    const baseDescriptor = await detectWith(ctx, d.basePool, coins[nCoins - 1]);
    if (baseDescriptor.family !== "stableswap") {
      throw new Error(`base pool ${d.basePool} of ${pool}: ${"reason" in baseDescriptor ? baseDescriptor.reason : baseDescriptor.family}`);
    }
    base = (await readStable(ctx, baseDescriptor)).params;
  }
  const src = d.rates;
  if (src.kind === "stored_rates") {
    const r = words(raw[4], nCoins);
    if (!r) throw new Error(`stored_rates() failed on ${pool}`);
    rates = r;
  } else if (src.kind === "metapool" || src.kind === "rai") {
    if (!base) throw new Error(`metapool ${pool} without a base pool`);
    let baseVp = stableswapExact.getVirtualPriceExact(base);
    const cachedVp = word(raw[6]);
    const cachedAt = word(raw[7]);
    if (cachedVp !== null && cachedAt !== null && ctx.blockTimestamp <= cachedAt + 600n) baseVp = cachedVp;
    let rate0: bigint;
    if (src.kind === "rai") {
      rate0 = need((await calls(ctx, [{ to: src.snap, data: SIG.snappedRedemptionPrice }]))[0], "snappedRedemptionPrice()", src.snap) / 10n ** 9n;
    } else {
      rate0 = 10n ** BigInt(36 - (await decimalsOf(ctx, [coins[0]]))[0]);
    }
    rates = [rate0, baseVp];
  } else {
    rates = (await decimalsOf(ctx, coins)).map((dec) => 10n ** BigInt(36 - dec));
    if (src.kind === "lending") rates = await lendingRates(ctx, d, coins, src.tokens, rates);
    else if (src.kind === "reth") {
      rates[1] = need((await calls(ctx, [{ to: coins[1], data: SIG.getExchangeRate }]))[0], "getExchangeRate()", coins[1]);
    } else if (src.kind === "oracle") {
      rates[1] = need((await calls(ctx, [{ to: src.oracle, data: SIG.latestAnswer }]))[0], "latestAnswer()", src.oracle);
    } else if (src.kind === "aeth") {
      rates[1] = stableswapExact.ankrAethRate(need((await calls(ctx, [{ to: coins[1], data: SIG.ratio }]))[0], "ratio()", coins[1]));
    }
  }

  const params: StableLiquidityParams = {
    variant: d.variant,
    balances,
    rates,
    A,
    ampPrecise,
    ampPrecision: d.ampPrecision,
    fee: need(raw[2], "fee()", pool),
    offpegFeeMultiplier: word(raw[3]) ?? 0n,
    totalSupply: need(raw[5], "totalSupply()", d.lpToken),
    ...(d.calcTokenAmountFee === false && { calcTokenAmountFee: false }),
    ...(d.getDySubtractOne === false && { getDySubtractOne: false }),
  };
  return {
    family: "stableswap",
    pool,
    params,
    ...(base && { base }),
    hasCalcWithdrawOneCoin: d.hasCalcWithdrawOneCoin,
  };
}

/** Compound / yearn token rates as the lending pools' `_stored_rates` compute them */
async function lendingRates(
  ctx: Ctx,
  d: StableswapDescriptor,
  coins: string[],
  tokens: ("plain" | "compound" | "yearn")[],
  plainRates: bigint[]
): Promise<bigint[]> {
  const underlyingRaw = await calls(
    ctx,
    coins.map((_, k) => ({ to: d.pool, data: arg(d.int128Args ? SIG.underlyingCoinsI : SIG.underlyingCoinsU, k) }))
  );
  const underlying = coins.map((c, k) => address(underlyingRaw[k]) ?? c);
  const underlyingDecimals = await decimalsOf(ctx, underlying);
  const raw = await calls(
    ctx,
    coins.flatMap((c) =>
      [SIG.exchangeRateStored, SIG.supplyRatePerBlock, SIG.accrualBlockNumber, SIG.getPricePerFullShare].map(
        (data) => ({ to: c, data })
      )
    )
  );
  return coins.map((c, k) => {
    const precisionMul = 10n ** BigInt(18 - underlyingDecimals[k]);
    if (tokens[k] === "compound") {
      return stableswapExact.compoundRate(
        need(raw[4 * k], "exchangeRateStored()", c),
        need(raw[4 * k + 1], "supplyRatePerBlock()", c),
        need(raw[4 * k + 2], "accrualBlockNumber()", c),
        ctx.blockNumber,
        precisionMul
      );
    }
    if (tokens[k] === "yearn") {
      return stableswapExact.yearnRate(need(raw[4 * k + 3], "getPricePerFullShare()", c), precisionMul);
    }
    return plainRates[k];
  });
}

async function readCryptoswap(ctx: Ctx, d: CryptoswapDescriptor): Promise<PoolState> {
  const p = d.pool;
  const raw = await calls(
    ctx,
    [
      { to: p, data: SIG.A },
      { to: p, data: SIG.gamma },
      { to: p, data: SIG.D },
      { to: p, data: SIG.midFee },
      { to: p, data: SIG.outFee },
      { to: p, data: SIG.feeGamma },
      { to: p, data: SIG.priceScale },
      { to: p, data: SIG.futureAGammaTime },
      { to: p, data: arg(SIG.balancesU, 0) },
      { to: p, data: arg(SIG.balancesU, 1) },
      { to: p, data: arg(SIG.coinsU, 0) },
      { to: p, data: arg(SIG.coinsU, 1) },
      { to: d.lpToken, data: SIG.totalSupply },
    ]
  );
  const decimals = await decimalsOf(ctx, [address(raw[10])!, address(raw[11])!]);
  return {
    family: "cryptoswap",
    pool: p,
    params: {
      A: need(raw[0], "A()", p),
      gamma: need(raw[1], "gamma()", p),
      D: need(raw[2], "D()", p),
      midFee: need(raw[3], "mid_fee()", p),
      outFee: need(raw[4], "out_fee()", p),
      feeGamma: need(raw[5], "fee_gamma()", p),
      priceScale: need(raw[6], "price_scale()", p),
      futureAGammaTime: word(raw[7]) ?? 0n,
      balances: [need(raw[8], "balances(0)", p), need(raw[9], "balances(1)", p)],
      precisions: [10n ** BigInt(18 - decimals[0]), 10n ** BigInt(18 - decimals[1])],
      ...(d.newtonYSingleDivMul2 && { newtonYSingleDivMul2: true }),
    },
    totalSupply: need(raw[12], "totalSupply()", d.lpToken),
  };
}

async function readCryptoNg(ctx: Ctx, d: CryptoNgDescriptor): Promise<PoolState> {
  const p = d.pool;
  const n = d.family === "tricryptoNg" ? 3 : 2;
  const list: RpcCall[] = [
    SIG.A,
    SIG.gamma,
    SIG.D,
    SIG.midFee,
    SIG.outFee,
    SIG.feeGamma,
    SIG.precisions,
    SIG.totalSupply,
    SIG.futureAGammaTime,
    SIG.lastTimestamp,
    SIG.donationShares,
    SIG.donationProtectionExpiryTs,
    SIG.donationProtectionPeriod,
    SIG.donationSharesMaxRatio,
  ].map((data) => ({ to: p, data }));
  for (let k = 0; k < n; k++) list.push({ to: p, data: arg(SIG.balancesU, k) });
  if (n === 3) list.push({ to: p, data: arg(SIG.priceScaleI, 0) }, { to: p, data: arg(SIG.priceScaleI, 1) });
  else list.push({ to: p, data: SIG.priceScale });
  const raw = await calls(ctx, list);
  const precisions = words(raw[6], n);
  if (!precisions) throw new Error(`precisions() failed on ${p}`);
  const balances = Array.from({ length: n }, (_, k) => need(raw[14 + k], `balances(${k})`, p));
  const futureAGammaTime = word(raw[8]) ?? 0n;
  const common = {
    A: need(raw[0], "A()", p),
    gamma: need(raw[1], "gamma()", p),
    D: need(raw[2], "D()", p),
    midFee: need(raw[3], "mid_fee()", p),
    outFee: need(raw[4], "out_fee()", p),
    feeGamma: need(raw[5], "fee_gamma()", p),
    totalSupply: need(raw[7], "totalSupply()", p),
  };
  if (d.family === "tricryptoNg") {
    return {
      family: "tricryptoNg",
      pool: p,
      params: {
        ...common,
        priceScales: [need(raw[17], "price_scale(0)", p), need(raw[18], "price_scale(1)", p)],
        balances: balances as [bigint, bigint, bigint],
        precisions: precisions as [bigint, bigint, bigint],
        isRamping: futureAGammaTime > ctx.blockTimestamp,
      },
    };
  }
  const two = {
    ...common,
    priceScale: need(raw[16], "price_scale()", p),
    balances: balances as [bigint, bigint],
    precisions: precisions as [bigint, bigint],
  };
  if (d.family === "twocryptoOptimized") {
    return {
      family: "twocryptoOptimized",
      pool: p,
      params: { ...two, isRamping: futureAGammaTime > ctx.blockTimestamp, version: d.version },
    };
  }
  const shares = word(raw[10]);
  return {
    family: "twocryptoStableswap",
    pool: p,
    params: {
      ...two,
      version: d.version as twocryptoStableswap.TwocryptoStableswapVersion,
      isRamping: futureAGammaTime > need(raw[9], "last_timestamp()", p),
      ...(d.policy !== undefined && { policy: d.policy }),
      ...(shares !== null && {
        donation: {
          shares,
          protectionExpiryTs: word(raw[11]) ?? 0n,
          protectionPeriod: word(raw[12]) ?? 0n,
          sharesMaxRatio: word(raw[13]) ?? 0n,
          blockTimestamp: ctx.blockTimestamp,
        },
      }),
    },
  };
}
