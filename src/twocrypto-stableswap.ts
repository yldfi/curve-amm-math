/**
 * Curve Twocrypto pools whose MATH is Curve's `StableswapMath` (the
 * YieldBasis-style crvUSD/BTC/ETH pools): exact liquidity math.
 *
 * Line-by-line port of the verified mainnet sources:
 *
 * - Pool:  `Twocrypto` v3.0.0 (e.g. crvUSD/WBTC 0x313698667d7FDD6789a9BC70821309ff891E729A,
 *          views 0x1D788b7AB488bAF5E6c3609cF7f9C9b940C4C867) and
 *          `Twocrypto` v2.1.0d (e.g. crvUSD/cbBTC 0x83f24023d15d835a213df24fd309c47dAb5BEb32,
 *          views 0x35048188c02cbc9239e1e5ecb3761eF9dfDcD31f)
 * - Math:  `StableswapMath` v0.1.1 (0xBfDdF58C… for v3.0.0, 0x79839c2D… for v2.1.0d)
 *
 * Swap quotes for the same pools are in the `twocryptoNg` module; this module
 * adds the fee clamp of v3.0.0 and the liquidity functions.
 *
 * State semantics:
 * - `D` is the STORED `D()`; set `isRamping` when
 *   `future_A_gamma_time() > last_timestamp()` (the pools' `_is_ramping`).
 * - v3.0.0 pools may route `_fee` through a POLICY contract: when
 *   `POLICY()` is set and its `get_fee(xp)` returns non-zero, that fee
 *   (clamped) replaces the dynamic fee. Pass `policy` (the `POLICY()`
 *   address). Known policies whose `get_fee` is a pure `return 0`
 *   ({@link ZERO_FEE_POLICIES}) quote with the pool's own fee; any other
 *   non-zero policy throws unless `policyFee` models it, so a policy swap
 *   fails loudly instead of mis-quoting.
 * - Deposits pay an extra "LP spam" fee while donation protection is active
 *   (`donation_protection_expiry_ts() > block.timestamp`); pass `donation`
 *   for exact deposit quotes then.
 * - The state-changing calls first claim admin fees (`_claim_admin_fees`),
 *   which can move balances, supply and D; pass the post-claim state for an
 *   exact match when a claim is due.
 */

import { getDVariant } from "./stableswap-exact";
import { getY } from "./twocrypto-ng";
import { isqrt, wadExp } from "./tricrypto-ng";

const N_COINS = 2n;
const E18 = 10n ** 18n;
const FEE_PRECISION = 10n ** 10n;
const A_MULTIPLIER = 10000n;
const NOISE_FEE = 10n ** 5n;
const MINIMUM_LIQUIDITY = 10n ** 4n;

/** `pool.version()` values this module is exact for. */
export const SUPPORTED_POOL_VERSIONS = ["v3.0.0", "v2.1.0d"] as const;
export type TwocryptoStableswapVersion = (typeof SUPPORTED_POOL_VERSIONS)[number];

/** `pool.MATH()` per version. */
export const SUPPORTED_MATH_ADDRESSES: Record<TwocryptoStableswapVersion, string> = {
  "v3.0.0": "0xbfddf58cb6ef84e115ff47c10e49a80b2653ea13",
  "v2.1.0d": "0x79839c2d74531a8222c0f555865aac1834e82e51",
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * POLICY contracts (`YBTwocryptoPolicy`) whose `get_fee(xp)` is
 * `@pure ... return 0`: the pool's own fee curve applies.
 */
export const ZERO_FEE_POLICIES: readonly string[] = [
  "0x0436c0648afd66de23f86f23cb42884304743efa", // crvUSD/WBTC
  "0xe99ee179f1cc62d4a1d3e67dd5541ecb63aca396", // crvUSD/tBTC
];

/**
 * Throws unless the pool is an implementation this module is exact for.
 *
 * @param version - `pool.version()`
 * @param mathAddress - `pool.MATH()` (optional)
 */
export function assertSupportedImplementation(
  version: string,
  mathAddress?: string
): asserts version is TwocryptoStableswapVersion {
  if (!(SUPPORTED_POOL_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(
      `twocryptoStableswap: unsupported pool version "${version}" (exact only for ${SUPPORTED_POOL_VERSIONS.join(", ")})`
    );
  }
  const v = version as TwocryptoStableswapVersion;
  if (mathAddress !== undefined && mathAddress.toLowerCase() !== SUPPORTED_MATH_ADDRESSES[v]) {
    throw new Error(`twocryptoStableswap: unsupported MATH ${mathAddress} for ${v}`);
  }
}

/** Donation-protection state (`donation_*` getters) and the block time. */
export interface TwocryptoDonationState {
  /** `pool.donation_shares()` */
  shares: bigint;
  /** `pool.donation_protection_expiry_ts()` */
  protectionExpiryTs: bigint;
  /** `pool.donation_protection_period()` */
  protectionPeriod: bigint;
  /** `pool.donation_shares_max_ratio()` */
  sharesMaxRatio: bigint;
  /** Timestamp of the block the quote is for */
  blockTimestamp: bigint;
}

/**
 * Pool state (getter values at one block).
 */
export interface TwocryptoStableswapParams {
  /** `pool.version()`: "v3.0.0" or "v2.1.0d" */
  version: TwocryptoStableswapVersion;
  /** `pool.A()` */
  A: bigint;
  /** `pool.gamma()` (unused by StableswapMath; kept for symmetry) */
  gamma: bigint;
  /** STORED `pool.D()` */
  D: bigint;
  /** `pool.mid_fee()` */
  midFee: bigint;
  /** `pool.out_fee()` */
  outFee: bigint;
  /** `pool.fee_gamma()` */
  feeGamma: bigint;
  /** `pool.price_scale()` */
  priceScale: bigint;
  /** `pool.balances(k)` */
  balances: [bigint, bigint];
  /** `pool.precisions()` */
  precisions: [bigint, bigint];
  /** `pool.totalSupply()` */
  totalSupply: bigint;
  /** True when `future_A_gamma_time() > last_timestamp()` */
  isRamping?: boolean;
  /**
   * Donation protection state. Needed for exact deposit quotes while
   * protection is active; without it the LP spam fee is taken as zero.
   */
  donation?: TwocryptoDonationState;
  /**
   * v3.0.0: `pool.POLICY()`. Required for v3.0.0 pools; the zero address or
   * a {@link ZERO_FEE_POLICIES} entry quotes with the pool's own fee, any
   * other policy needs `policyFee`.
   */
  policy?: string;
  /**
   * v3.0.0: the POLICY contract's `get_fee(xp)` (1e10) for the given scaled
   * balances (0 = use the pool's fee). Needed for policies outside
   * {@link ZERO_FEE_POLICIES}.
   */
  policyFee?: (xp: readonly [bigint, bigint]) => bigint;
}

function fail(message: string): never {
  throw new Error(`twocryptoStableswap: ${message}`);
}

/** Pool `_xp(balances, price_scale)`. */
function scale(
  balances: readonly bigint[],
  precisions: readonly bigint[],
  priceScale: bigint
): [bigint, bigint] {
  return [balances[0] * precisions[0], (balances[1] * precisions[1] * priceScale) / E18];
}

/** Scaled balances `xp` at `price_scale`. */
export function xp(params: TwocryptoStableswapParams): [bigint, bigint] {
  return scale(params.balances, params.precisions, params.priceScale);
}

/**
 * Mirrors `StableswapMath.newton_D` v0.1.1: the StableSwap-NG invariant with
 * A_MULTIPLIER as its precision, after the `!balance` check (ratio < 10 000).
 */
export function newtonD(A: bigint, xpIn: readonly [bigint, bigint]): bigint {
  const [x0, x1] = xpIn;
  if (x0 <= 0n || x1 <= 0n) fail("!balance");
  const max = x0 > x1 ? x0 : x1;
  const min = x0 > x1 ? x1 : x0;
  if (max / min >= 10000n) fail("!balance");
  return getDVariant([x0, x1], A, "ng", A_MULTIPLIER);
}

/**
 * Mirrors the pool's `_fee(xp)`: the dynamic fee (1e10); v3.0.0 clamps it to
 * [MIN_FEE, MAX_FEE].
 */
export function feeCalc(params: TwocryptoStableswapParams, xpIn: readonly [bigint, bigint]): bigint {
  const MIN_FEE = FEE_PRECISION / 10n / 10000n;
  const MAX_FEE = FEE_PRECISION;
  const clamp = (f: bigint) => (f < MIN_FEE ? MIN_FEE : f > MAX_FEE ? MAX_FEE : f);
  if (params.version === "v3.0.0") {
    if (params.policyFee) {
      const policy = params.policyFee(xpIn);
      if (policy !== 0n) return clamp(policy);
    } else {
      const policy = params.policy?.toLowerCase();
      if (policy === undefined) {
        fail("v3.0.0 pools need `policy` (pool.POLICY()); pass the zero address if none");
      }
      if (policy !== ZERO_ADDRESS && !ZERO_FEE_POLICIES.includes(policy)) {
        fail(`unknown fee POLICY ${policy}: pass policyFee to model its get_fee`);
      }
    }
  }
  let B = xpIn[0] + xpIn[1];
  if (B === 0n) fail("zero balances");
  B = (((E18 * N_COINS ** N_COINS * xpIn[0]) / B) * xpIn[1]) / B;
  B = (params.feeGamma * B) / ((params.feeGamma * B) / E18 + E18 - B);
  const fee = (params.midFee * B + params.outFee * (E18 - B)) / E18;
  return params.version === "v3.0.0" ? clamp(fee) : fee;
}

/** Mirrors `pool.fee()`. */
export function fee(params: TwocryptoStableswapParams): bigint {
  return feeCalc(params, xp(params));
}

/** Pool `_get_D` (views `_calc_D_ramp`): stored D, or newton_D while ramping. */
function currentD(params: TwocryptoStableswapParams): bigint {
  return params.isRamping ? newtonD(params.A, xp(params)) : params.D;
}

/**
 * Mirrors the pool's `_calc_token_fee(amounts, xp, donation=False, deposit,
 * from_view)` (1e10). `amounts` are RAW token amounts.
 */
export function calcTokenFee(
  params: TwocryptoStableswapParams,
  amounts: readonly [bigint, bigint],
  xpAfter: readonly [bigint, bigint],
  deposit: boolean,
  fromView: boolean
): bigint {
  const surplusZero = params.version === "v3.0.0" ? fromView && deposit : fromView;
  const surplus = surplusZero ? [0n, 0n] : amounts;
  const { balances, precisions } = params;
  const d0 = balances[0] - surplus[0];
  const d1 = balances[1] - surplus[1];
  if (d0 < 0n || d1 <= 0n) fail("amounts exceed pool balances");
  const balancesRatio = (d0 * precisions[0] * E18) / (d1 * precisions[1]);
  const amountsXp = scale(amounts, precisions, balancesRatio);

  const f = (feeCalc(params, xpAfter) * N_COINS) / (4n * (N_COINS - 1n));
  const S = amountsXp[0] + amountsXp[1];
  if (S === 0n) fail("amounts sum to zero");
  const avg = S / N_COINS;
  let Sdiff = 0n;
  for (const _x of amountsXp) {
    Sdiff += _x > avg ? _x - avg : avg - _x;
  }

  let lpSpamPenaltyFee = 0n;
  const d = params.donation;
  if (deposit && d && d.protectionExpiryTs > d.blockTimestamp) {
    let protectionFactor = ((d.protectionExpiryTs - d.blockTimestamp) * E18) / d.protectionPeriod;
    if (protectionFactor > E18) protectionFactor = E18;
    const penalty = (protectionFactor * f * d.shares) / params.totalSupply / d.sharesMaxRatio;
    lpSpamPenaltyFee = penalty < f ? penalty : f;
  }

  return (f * Sdiff) / S + NOISE_FEE + lpSpamPenaltyFee;
}

/** Mirrors the views' `get_dy(i, j, dx)`. */
export function getDy(params: TwocryptoStableswapParams, i: number, j: number, dx: bigint): bigint {
  if (i === j || i < 0 || i > 1 || j < 0 || j > 1) fail("coin index out of range");
  if (dx <= 0n) fail("do not exchange 0 coins");
  const D = currentD(params);
  const balances: [bigint, bigint] = [params.balances[0], params.balances[1]];
  balances[i] += dx;
  const xpNew = scale(balances, params.precisions, params.priceScale);
  const { y } = getY(params.A, params.gamma, xpNew, D, j);
  if (y >= xpNew[j]) fail("unsafe value for y");
  let dy = xpNew[j] - y - 1n;
  xpNew[j] = y;
  if (j > 0) dy = (dy * E18) / params.priceScale;
  dy = dy / params.precisions[j];
  return dy - (feeCalc(params, xpNew) * dy) / FEE_PRECISION;
}

/**
 * Mirrors the views' `calc_token_amount(amounts, deposit)` (donation=False):
 * LP minted for a deposit, or the LP quote for a withdrawal of `amounts`.
 *
 * v3.0.0 adds the fee to the withdrawal quote; v2.1.0d's views subtract it
 * for both directions (as the contract does).
 */
export function calcTokenAmount(
  params: TwocryptoStableswapParams,
  amounts: readonly [bigint, bigint],
  deposit: boolean = true
): bigint {
  const D0 = currentD(params);
  const balances: [bigint, bigint] = [params.balances[0], params.balances[1]];
  for (let k = 0; k < 2; k++) {
    if (deposit) {
      balances[k] += amounts[k];
    } else {
      if (amounts[k] > balances[k]) fail("withdrawal exceeds pool balance");
      balances[k] -= amounts[k];
    }
  }
  const xpNew = scale(balances, params.precisions, params.priceScale);
  const D = newtonD(params.A, xpNew);

  let d_token: bigint;
  if (D0 === 0n) {
    if (!deposit) fail("withdrawal from an empty pool");
    d_token = getXcp(D, params.priceScale);
    if (params.version === "v3.0.0") {
      return d_token <= MINIMUM_LIQUIDITY ? 0n : d_token - MINIMUM_LIQUIDITY;
    }
  } else {
    d_token = (params.totalSupply * D) / D0;
    d_token = deposit ? d_token - params.totalSupply : params.totalSupply - d_token;
  }

  const f = calcTokenFee(params, amounts, xpNew, deposit, true);
  const feeAmount = (f * d_token) / FEE_PRECISION + 1n;
  if (params.version === "v3.0.0" && !deposit) {
    return d_token + feeAmount;
  }
  if (feeAmount > d_token) fail("fee exceeds token amount");
  return d_token - feeAmount;
}

/** Result of {@link calcWithdrawFixedOutWithState}. */
export interface TwocryptoWithdrawFixedOut {
  /** Amount of coin j (= 1 − i) paid out */
  dy: bigint;
  /** Invariant after the withdrawal, fee included */
  D: bigint;
  /** Scaled balances after the withdrawal */
  xp: [bigint, bigint];
  /** `_calc_token_fee` rate applied to the burned share of D (1e10) */
  approxFee: bigint;
}

/**
 * Mirrors the pool's `_calc_withdraw_fixed_out(token_amount, i, amount_i)`:
 * burn `tokenAmount` LP, take exactly `amountI` of coin i and the rest in
 * coin j = 1 − i.
 */
export function calcWithdrawFixedOutWithState(
  params: TwocryptoStableswapParams,
  tokenAmount: bigint,
  i: number,
  amountI: bigint
): TwocryptoWithdrawFixedOut {
  if (i !== 0 && i !== 1) fail(`coin out of range (i=${i})`);
  if (tokenAmount > params.totalSupply) fail("!amount");
  const v3 = params.version === "v3.0.0";
  const j = 1 - i;
  const xpNow = xp(params);
  const D = currentD(params);
  let dD = (tokenAmount * D) / params.totalSupply;
  const xpNew: [bigint, bigint] = [xpNow[0], xpNow[1]];
  const priceScales: [bigint, bigint] = [E18 * params.precisions[0], params.priceScale * params.precisions[1]];
  const amountsp: [bigint, bigint] = [0n, 0n];
  amountsp[i] = v3 ? (amountI * priceScales[i] + E18 - 1n) / E18 : (amountI * priceScales[i]) / E18;
  if (amountsp[i] > xpNew[i]) fail("amount_i exceeds balance");
  xpNew[i] -= amountsp[i];
  const bump = v3 ? 1n : 0n;
  let y = getY(params.A, params.gamma, xpNew, D - dD, j).y + bump;
  if (y > xpNow[j]) fail("y exceeds balance");
  amountsp[j] = xpNow[j] - y;
  xpNew[j] = y;

  const amounts: [bigint, bigint] = [0n, 0n];
  amounts[i] = amountI;
  if (i === 0) {
    amounts[1] = (amountsp[1] * E18) / params.precisions[1] / params.priceScale;
  } else {
    amounts[0] = amountsp[0] / params.precisions[0];
  }
  if (amounts[0] + amounts[1] === 0n) fail("!tokens");

  const approxFee = calcTokenFee(params, amounts, xpNew, false, false);
  dD -= (dD * approxFee) / FEE_PRECISION + 1n;
  y = getY(params.A, params.gamma, xpNew, D - dD, j).y + bump;
  if (y > xpNow[j]) fail("y exceeds balance");
  const dy = ((xpNow[j] - y) * E18) / priceScales[j];
  xpNew[j] = y;
  return { dy, D: D - dD, xp: xpNew, approxFee };
}

/** Mirrors `pool.calc_withdraw_fixed_out(token_amount, i, amount_i)`. */
export function calcWithdrawFixedOut(
  params: TwocryptoStableswapParams,
  tokenAmount: bigint,
  i: number,
  amountI: bigint
): bigint {
  return calcWithdrawFixedOutWithState(params, tokenAmount, i, amountI).dy;
}

/**
 * Mirrors `pool.calc_withdraw_one_coin(token_amount, i)` (what
 * `remove_liquidity_one_coin` pays, before its admin-fee claim).
 */
export function calcWithdrawOneCoin(params: TwocryptoStableswapParams, tokenAmount: bigint, i: number): bigint {
  if (i !== 0 && i !== 1) fail(`coin out of range (i=${i})`);
  return calcWithdrawFixedOutWithState(params, tokenAmount, 1 - i, 0n).dy;
}

/** Balanced `remove_liquidity(amount)`: `balances[i] * amount / totalSupply`. */
export function calcRemoveLiquidity(params: TwocryptoStableswapParams, amount: bigint): [bigint, bigint] {
  if (params.totalSupply === 0n) fail("totalSupply cannot be zero");
  if (amount > params.totalSupply) fail("amount exceeds totalSupply");
  return [
    (params.balances[0] * amount) / params.totalSupply,
    (params.balances[1] * amount) / params.totalSupply,
  ];
}

/** Pool `_xcp(D, price_scale)`: `D * 1e18 / 2 / isqrt(1e18 * price_scale)`. */
export function getXcp(D: bigint, priceScale: bigint): bigint {
  return (D * E18) / N_COINS / isqrt(E18 * priceScale);
}

/** Mirrors `get_virtual_price()`: `1e18 * xcp(D) / totalSupply`. */
export function getVirtualPrice(params: TwocryptoStableswapParams): bigint {
  if (params.totalSupply === 0n) fail("totalSupply cannot be zero");
  return (E18 * getXcp(params.D, params.priceScale)) / params.totalSupply;
}

/** Inputs of the views' `_price_oracle` (EMA with time decay). */
export interface TwocryptoStableswapOracleState {
  /** Cached (stored) price oracle */
  cachedPriceOracle: bigint;
  /** `pool.price_scale()` */
  priceScale: bigint;
  /** `pool.last_prices()` */
  lastPrices: bigint;
  /** `pool.last_timestamp()` */
  lastTimestamp: bigint;
  /** `pool.ma_time()` */
  maTime: bigint;
  /** Timestamp of the block */
  blockTimestamp: bigint;
}

/**
 * Mirrors the views' `_price_oracle` (= `pool.price_oracle()`): the stored
 * oracle decayed towards `last_prices` clamped to [price_scale / 2,
 * 2 · price_scale].
 */
export function priceOracle(state: TwocryptoStableswapOracleState): bigint {
  if (state.lastTimestamp >= state.blockTimestamp) return state.cachedPriceOracle;
  const alpha = wadExp(-(((state.blockTimestamp - state.lastTimestamp) * E18) / state.maTime));
  let last = state.lastPrices;
  const half = state.priceScale / 2n;
  if (last < half) last = half;
  if (last > state.priceScale * 2n) last = state.priceScale * 2n;
  return (last * (E18 - alpha) + state.cachedPriceOracle * alpha) / E18;
}

/**
 * Mirrors `pool.lp_price()`: `2 * virtual_price * isqrt(price_oracle * 1e18) / 1e18`
 * with `virtual_price = 1e18 * xcp(D) / totalSupply`.
 *
 * @param priceOracleValue - `pool.price_oracle()` at the same block
 */
export function lpPrice(params: TwocryptoStableswapParams, priceOracleValue: bigint): bigint {
  return (2n * getVirtualPrice(params) * isqrt(priceOracleValue * E18)) / E18;
}
