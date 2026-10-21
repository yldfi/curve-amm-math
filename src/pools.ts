/**
 * One quoting interface over every exact module: a {@link PoolState} names
 * the module a pool belongs to and carries that module's own params, and the
 * functions here dispatch to it. `rpc.detectPool` / `rpc.readPoolState` build
 * a PoolState from chain state; the modules stay usable on their own.
 */

import * as cryptoswap from "./cryptoswap";
import type { TwocryptoParams } from "./cryptoswap";
import * as metapool from "./metapool";
import * as stableswapExact from "./stableswap-exact";
import type { StableLiquidityParams } from "./stableswap-exact";
import * as tricryptoLegacy from "./tricrypto-legacy";
import type { TricryptoLegacyState } from "./tricrypto-legacy";
import * as tricryptoNg from "./tricrypto-ng";
import type { TricryptoNgParams } from "./tricrypto-ng";
import * as twocryptoOptimized from "./twocrypto-optimized";
import type { TwocryptoOptimizedParams } from "./twocrypto-optimized";
import * as twocryptoStableswap from "./twocrypto-stableswap";
import type { TwocryptoStableswapParams } from "./twocrypto-stableswap";

/** StableSwap pool (`stableswapExact`); `base` makes it a metapool. */
export interface StableswapPoolState {
  family: "stableswap";
  pool: string;
  params: StableLiquidityParams;
  /** Base pool at the same block (metapools only) */
  base?: StableLiquidityParams;
  /** False for pools without `calc_withdraw_one_coin` (compound, usdt, y, busd, PAX) */
  hasCalcWithdrawOneCoin: boolean;
}

/** Classic 2-coin CurveCryptoSwap2 pool (`cryptoswap`) */
export interface CryptoswapPoolState {
  family: "cryptoswap";
  pool: string;
  params: TwocryptoParams;
  totalSupply: bigint;
}

/** tricrypto2 / tricrypto v1 (`tricryptoLegacy`) */
export interface TricryptoLegacyPoolState {
  family: "tricryptoLegacy";
  pool: string;
  state: TricryptoLegacyState;
}

/** Tricrypto-NG (`tricryptoNg`) */
export interface TricryptoNgPoolState {
  family: "tricryptoNg";
  pool: string;
  params: TricryptoNgParams;
}

/** Twocrypto-NG with the standard math (`twocryptoOptimized`) */
export interface TwocryptoOptimizedPoolState {
  family: "twocryptoOptimized";
  pool: string;
  params: TwocryptoOptimizedParams;
}

/** Twocrypto on StableswapMath (`twocryptoStableswap`) */
export interface TwocryptoStableswapPoolState {
  family: "twocryptoStableswap";
  pool: string;
  params: TwocryptoStableswapParams;
}

export type PoolState =
  | StableswapPoolState
  | CryptoswapPoolState
  | TricryptoLegacyPoolState
  | TricryptoNgPoolState
  | TwocryptoOptimizedPoolState
  | TwocryptoStableswapPoolState;

/** Pool family names, as in {@link PoolState} `family` */
export type PoolFamily = PoolState["family"];

/** Number of coins in the pool (base pool coins excluded) */
export function nCoins(s: PoolState): number {
  switch (s.family) {
    case "stableswap":
      return s.params.balances.length;
    case "tricryptoLegacy":
      return 3;
    case "tricryptoNg":
      return 3;
    default:
      return 2;
  }
}

function pair<T>(xs: readonly T[], name: string): [T, T] {
  if (xs.length !== 2) throw new Error(`pools.${name}: expected 2 amounts (got ${xs.length})`);
  return [xs[0], xs[1]];
}

function triple<T>(xs: readonly T[], name: string): [T, T, T] {
  if (xs.length !== 3) throw new Error(`pools.${name}: expected 3 amounts (got ${xs.length})`);
  return [xs[0], xs[1], xs[2]];
}

/** The pool's `get_dy(i, j, dx)` */
export function getDy(s: PoolState, i: number, j: number, dx: bigint): bigint {
  switch (s.family) {
    case "stableswap":
      return stableswapExact.getDyVariant(s.params, i, j, dx);
    case "cryptoswap":
      return cryptoswap.getDy(s.params, i, j, dx);
    case "tricryptoLegacy":
      return tricryptoLegacy.getDy(s.state, i, j, dx);
    case "tricryptoNg":
      return tricryptoNg.getDy(s.params, i, j, dx);
    case "twocryptoOptimized":
      return twocryptoOptimized.getDy(s.params, i, j, dx);
    case "twocryptoStableswap":
      return twocryptoStableswap.getDy(s.params, i, j, dx);
  }
}

/** The metapool's `get_dy_underlying(i, j, dx)` (0 = meta coin, 1..N = base coins) */
export function getDyUnderlying(s: PoolState, i: number, j: number, dx: bigint): bigint {
  if (s.family !== "stableswap" || !s.base) {
    throw new Error("pools.getDyUnderlying: not a stableswap metapool");
  }
  return metapool.getDyUnderlying(metapoolParams(s), i, j, dx);
}

/**
 * `{ meta, base }` for the `metapool` module. An NG metapool quotes its base
 * pool's `calc_token_amount` with static fees, so a legacy base is passed as
 * `"plain"` (see `metapool.getDyUnderlying`).
 */
export function metapoolParams(s: StableswapPoolState): metapool.MetapoolParams {
  if (!s.base) throw new Error("pools.metapoolParams: not a metapool");
  const base =
    s.params.variant === "ng" && s.base.variant === "legacy" ? { ...s.base, variant: "plain" as const } : s.base;
  return { meta: s.params, base };
}

/** The pool's `calc_withdraw_one_coin(tokenAmount, i)` (coin i out) */
export function calcWithdrawOneCoin(s: PoolState, tokenAmount: bigint, i: number): bigint {
  switch (s.family) {
    case "stableswap":
      if (!s.hasCalcWithdrawOneCoin) {
        throw new Error("pools.calcWithdrawOneCoin: the pool has no calc_withdraw_one_coin (use lendingZap)");
      }
      return stableswapExact.calcWithdrawOneCoinExact(s.params, tokenAmount, i)[0];
    case "cryptoswap":
      return cryptoswap.calcWithdrawOneCoin(s.params, tokenAmount, i, s.totalSupply);
    case "tricryptoLegacy":
      return tricryptoLegacy.calcWithdrawOneCoin(s.state, tokenAmount, i);
    case "tricryptoNg":
      return tricryptoNg.calcWithdrawOneCoin(s.params, tokenAmount, i);
    case "twocryptoOptimized":
      return twocryptoOptimized.calcWithdrawOneCoin(s.params, tokenAmount, i);
    case "twocryptoStableswap":
      return twocryptoStableswap.calcWithdrawOneCoin(s.params, tokenAmount, i);
  }
}

/**
 * The pool's `calc_token_amount(amounts, isDeposit)`. Classic 2-coin
 * CurveCryptoSwap2 pools have a deposit-only view; `isDeposit: false` throws
 * for them.
 */
export function calcTokenAmount(s: PoolState, amounts: readonly bigint[], isDeposit: boolean): bigint {
  switch (s.family) {
    case "stableswap":
      return stableswapExact.calcTokenAmountExact(s.params, [...amounts], isDeposit);
    case "cryptoswap":
      if (!isDeposit) throw new Error("pools.calcTokenAmount: CurveCryptoSwap2 quotes deposits only");
      return cryptoswap.calcTokenAmount(s.params, pair(amounts, "calcTokenAmount"), s.totalSupply);
    case "tricryptoLegacy":
      return tricryptoLegacy.calcTokenAmount(s.state, triple(amounts, "calcTokenAmount"), isDeposit);
    case "tricryptoNg":
      return tricryptoNg.calcTokenAmount(s.params, amounts, isDeposit);
    case "twocryptoOptimized":
      return twocryptoOptimized.calcTokenAmount(s.params, pair(amounts, "calcTokenAmount"), isDeposit);
    case "twocryptoStableswap":
      return twocryptoStableswap.calcTokenAmount(s.params, pair(amounts, "calcTokenAmount"), isDeposit);
  }
}

/** The pool's `get_virtual_price()` */
export function getVirtualPrice(s: PoolState): bigint {
  switch (s.family) {
    case "stableswap":
      return stableswapExact.getVirtualPriceExact(s.params);
    case "cryptoswap":
      return cryptoswap.getVirtualPrice(s.params, s.totalSupply);
    case "tricryptoLegacy":
      return tricryptoLegacy.getVirtualPrice(s.state);
    case "tricryptoNg":
      return tricryptoNg.getVirtualPrice(s.params);
    case "twocryptoOptimized":
      return twocryptoOptimized.getVirtualPrice(s.params);
    case "twocryptoStableswap":
      return twocryptoStableswap.getVirtualPrice(s.params);
  }
}
