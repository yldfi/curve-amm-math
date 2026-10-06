/**
 * Curve Twocrypto-NG exact math for pools using CurveTwocryptoMathOptimized.
 *
 * Line-by-line port of the verified mainnet sources:
 *
 * - Pool:  `CurveTwocryptoOptimized` v2.1.0 / v2.1.1
 *          (e.g. OGN/OETH 0x56A344F1aA03943f536b94436dE6A6e10116Cf86)
 * - Math:  `CurveTwocryptoMathOptimized` v2.1.0
 *          (0x1Fd8Af16DC4BEBd950521308D55d0543b6cDF4A1)
 * - Views: `CurveCryptoViews2Optimized`
 *
 * Exact for that implementation set ONLY: check `pool.version()` and
 * `pool.MATH()` with {@link assertSupportedImplementation}. Also verified
 * exact for v2.0.0 pools (MATH 0x2005…64Df), whose math and views give the
 * same results. Twocrypto pools whose MATH is Curve's StableswapMath
 * (v2.1.0d, v3.0.0 — the YieldBasis-style pools) are covered by the
 * `twocryptoStableswap` module instead.
 *
 * State semantics:
 * - `D` must be the pool's STORED `D()`. The views re-solve D from balances
 *   only while A/gamma ramps (`future_A_gamma_time > block.timestamp`): set
 *   `isRamping: true` for that.
 * - `A` and `gamma` are the current `A()` / `gamma()` getter values.
 * - `precisions` must be `pool.precisions()`.
 */

import { cbrt, isqrt } from "./tricrypto-ng";

const N_COINS = 2n;
const A_MULTIPLIER = 10000n;
const E18 = 10n ** 18n;
const FEE_DENOMINATOR = 10n ** 10n;
const NOISE_FEE = 10n ** 5n;

const MIN_GAMMA = 10n ** 10n;
const MAX_GAMMA_SMALL = 2n * 10n ** 16n;
const MAX_GAMMA = 199n * 10n ** 15n;
const MIN_A = (N_COINS ** N_COINS * A_MULTIPLIER) / 10n;
const MAX_A = N_COINS ** N_COINS * A_MULTIPLIER * 1000n;

/** `pool.version()` values this module is exact for. */
export const SUPPORTED_POOL_VERSIONS = ["v2.0.0", "v2.1.0", "v2.1.1"] as const;

/** `pool.MATH()` this module is exact for (CurveTwocryptoMathOptimized v2.1.0). */
export const SUPPORTED_MATH_ADDRESS = "0x1fd8af16dc4bebd950521308d55d0543b6cdf4a1";

/** `pool.MATH()` per supported version. */
export const SUPPORTED_MATH_ADDRESSES: Record<(typeof SUPPORTED_POOL_VERSIONS)[number], string> = {
  "v2.0.0": "0x2005995a71243be9fb995dab4742327dc76564df",
  "v2.1.0": SUPPORTED_MATH_ADDRESS,
  "v2.1.1": SUPPORTED_MATH_ADDRESS,
};

/**
 * Throws unless the given on-chain identity matches the implementation this
 * module ports.
 *
 * @param version - `pool.version()`
 * @param mathAddress - `pool.MATH()` (optional; checked when provided)
 */
export function assertSupportedImplementation(version: string, mathAddress?: string): void {
  if (!(SUPPORTED_POOL_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(
      `twocryptoOptimized: unsupported pool version "${version}" (exact only for ${SUPPORTED_POOL_VERSIONS.join(", ")})`
    );
  }
  const expected = SUPPORTED_MATH_ADDRESSES[version as (typeof SUPPORTED_POOL_VERSIONS)[number]];
  if (mathAddress !== undefined && mathAddress.toLowerCase() !== expected) {
    throw new Error(`twocryptoOptimized: unsupported MATH ${mathAddress} for ${version} (expected ${expected})`);
  }
}

/**
 * Twocrypto-NG pool state (getter values at one block).
 */
export interface TwocryptoOptimizedParams {
  /** `pool.A()` (A * N**N * A_MULTIPLIER, ramp-interpolated) */
  A: bigint;
  /** `pool.gamma()` */
  gamma: bigint;
  /** STORED invariant `pool.D()` */
  D: bigint;
  /** `pool.mid_fee()` */
  midFee: bigint;
  /** `pool.out_fee()` */
  outFee: bigint;
  /** `pool.fee_gamma()` */
  feeGamma: bigint;
  /** `pool.price_scale()` */
  priceScale: bigint;
  /** `pool.balances(k)` (token decimals) */
  balances: [bigint, bigint];
  /** `pool.precisions()` */
  precisions: [bigint, bigint];
  /** `pool.totalSupply()`; required by the LP-token functions */
  totalSupply?: bigint;
  /** True when `pool.future_A_gamma_time() > block.timestamp` */
  isRamping?: boolean;
}

function fail(message: string): never {
  throw new Error(`twocryptoOptimized: ${message}`);
}

function absInt(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function minInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function limMul(gamma: bigint): bigint {
  let lim = 100n * E18;
  if (gamma > MAX_GAMMA_SMALL) {
    lim = (lim * MAX_GAMMA_SMALL) / gamma;
  }
  return lim;
}

function checkAGamma(ANN: bigint, gamma: bigint): void {
  if (ANN < MIN_A || ANN > MAX_A) fail("unsafe values A");
  if (gamma < MIN_GAMMA || gamma > MAX_GAMMA) fail("unsafe values gamma");
}

function checkD(D: bigint): void {
  if (D < 10n ** 17n || D > 10n ** 33n) fail("unsafe values D");
}

// ============================================
// Math (CurveTwocryptoMathOptimized v2.1.0)
// ============================================

function newtonYInner(
  ANN: bigint,
  gamma: bigint,
  x: readonly bigint[],
  D: bigint,
  i: number,
  lim: bigint
): bigint {
  const x_j = x[1 - i];
  let y = D ** 2n / (x_j * N_COINS ** 2n);
  const K0_i = (E18 * N_COINS * x_j) / D;

  if (K0_i < 10n ** 36n / lim || K0_i > lim) fail("unsafe values x[i]");

  const convergence_limit = maxInt(maxInt(x_j / 10n ** 14n, D / 10n ** 14n), 100n);

  for (let j = 0; j < 255; j++) {
    const y_prev = y;

    const K0 = (K0_i * y * N_COINS) / D;
    const S = x_j + y;

    let _g1k0 = gamma + E18;
    if (_g1k0 > K0) {
      _g1k0 = _g1k0 - K0 + 1n;
    } else {
      _g1k0 = K0 - _g1k0 + 1n;
    }

    const mul1 = (((((E18 * D) / gamma) * _g1k0) / gamma) * _g1k0 * A_MULTIPLIER) / ANN;
    const mul2 = E18 + (2n * E18 * K0) / _g1k0;

    let yfprime = E18 * y + S * mul2 + mul1;
    const _dyfprime = D * mul2;
    if (yfprime < _dyfprime) {
      y = y_prev / 2n;
      continue;
    } else {
      yfprime -= _dyfprime;
    }
    const fprime = yfprime / y;

    let y_minus = mul1 / fprime;
    const y_plus = (yfprime + E18 * D) / fprime + (y_minus * E18) / K0;
    y_minus += (E18 * S) / fprime;

    if (y_plus < y_minus) {
      y = y_prev / 2n;
    } else {
      y = y_plus - y_minus;
    }

    const diff = y > y_prev ? y - y_prev : y_prev - y;
    if (diff < maxInt(convergence_limit, y / 10n ** 14n)) {
      return y;
    }
  }

  fail("newton_y did not converge");
}

function checkYFrac(y: bigint, D: bigint, lim: bigint): void {
  const frac = (y * E18) / D;
  if (frac < 10n ** 36n / N_COINS / lim || frac > lim / N_COINS) fail("unsafe value for y");
}

/**
 * Mirrors `CurveTwocryptoMathOptimized.newton_y` v2.1.0.
 */
export function newtonY(
  ANN: bigint,
  gamma: bigint,
  x: readonly [bigint, bigint],
  D: bigint,
  i: number
): bigint {
  checkAGamma(ANN, gamma);
  checkD(D);
  const lim = limMul(gamma);
  const y = newtonYInner(ANN, gamma, x, D, i, lim);
  checkYFrac(y, D, lim);
  return y;
}

/**
 * Mirrors `CurveTwocryptoMathOptimized.get_y` v2.1.0: the closed-form cubic
 * solution, falling back to `_newton_y` when the discriminant is not
 * positive. Returns `[y, K0_prev]` (K0_prev is 0 on the fallback path).
 * int256 division truncates toward zero, as Vyper's does.
 */
export function getY(
  _ANN: bigint,
  _gamma: bigint,
  _x: readonly [bigint, bigint],
  _D: bigint,
  i: number
): [bigint, bigint] {
  if (i !== 0 && i !== 1) fail(`index out of bounds (i=${i})`);
  checkAGamma(_ANN, _gamma);
  checkD(_D);
  const lim = limMul(_gamma);

  const ANN = _ANN;
  const gamma = _gamma;
  const D = _D;
  const x_j = _x[1 - i];
  if (x_j === 0n) fail("zero balance");
  const gamma2 = gamma * gamma;

  const K0_i = (E18 * N_COINS * x_j) / D;
  if (K0_i < 10n ** 36n / lim || K0_i > lim) fail("unsafe values x[i]");

  const ann_gamma2 = ANN * gamma2;

  let a = 10n ** 32n;
  let b = (D * ann_gamma2) / 400000000n / x_j - 10n ** 32n * 3n - 2n * gamma * 10n ** 14n;
  let c =
    10n ** 32n * 3n +
    4n * gamma * 10n ** 14n +
    gamma2 / 10n ** 4n +
    (((4n * ann_gamma2) / 400000000n) * x_j) / D -
    (4n * ann_gamma2) / 400000000n;
  let d = -((E18 + gamma) ** 2n / 10n ** 4n);

  if (b === 0n) fail("division by zero (b)");
  let delta0 = (3n * a * c) / b - b;
  let delta1 = 3n * delta0 + b - (((27n * a ** 2n) / b) * d) / b;

  let divider = 1n;
  const threshold = minInt(minInt(absInt(delta0), absInt(delta1)), a);
  if (threshold > 10n ** 48n) divider = 10n ** 30n;
  else if (threshold > 10n ** 46n) divider = 10n ** 28n;
  else if (threshold > 10n ** 44n) divider = 10n ** 26n;
  else if (threshold > 10n ** 42n) divider = 10n ** 24n;
  else if (threshold > 10n ** 40n) divider = 10n ** 22n;
  else if (threshold > 10n ** 38n) divider = 10n ** 20n;
  else if (threshold > 10n ** 36n) divider = 10n ** 18n;
  else if (threshold > 10n ** 34n) divider = 10n ** 16n;
  else if (threshold > 10n ** 32n) divider = 10n ** 14n;
  else if (threshold > 10n ** 30n) divider = 10n ** 12n;
  else if (threshold > 10n ** 28n) divider = 10n ** 10n;
  else if (threshold > 10n ** 26n) divider = 10n ** 8n;
  else if (threshold > 10n ** 24n) divider = 10n ** 6n;
  else if (threshold > 10n ** 20n) divider = 10n ** 2n;

  a = a / divider;
  b = b / divider;
  c = c / divider;
  d = d / divider;
  if (b === 0n) fail("division by zero (b)");

  delta0 = (3n * a * c) / b - b;
  delta1 = 3n * delta0 + b - (((27n * a ** 2n) / b) * d) / b;

  const sqrt_arg = delta1 ** 2n + ((4n * delta0 ** 2n) / b) * delta0;
  if (sqrt_arg <= 0n) {
    const y = newtonYInner(_ANN, _gamma, _x, _D, i, lim);
    checkYFrac(y, _D, lim);
    return [y, 0n];
  }
  const sqrt_val = isqrt(sqrt_arg);

  const b_cbrt = b > 0n ? cbrt(b) : -cbrt(-b);

  let second_cbrt: bigint;
  if (delta1 > 0n) {
    second_cbrt = cbrt((delta1 + sqrt_val) / 2n);
  } else {
    second_cbrt = -cbrt((sqrt_val - delta1) / 2n);
  }

  const C1 = (((b_cbrt ** 2n) / E18) * second_cbrt) / E18;
  if (C1 === 0n) fail("division by zero (C1)");

  const root = (E18 * C1 - E18 * b - ((E18 * b) / C1) * delta0) / (3n * a);

  const y = ((((D ** 2n) / x_j) * root) / 4n) / E18;
  if (y < 0n || root < 0n) fail("negative root");
  checkYFrac(y, _D, lim);
  return [y, root];
}

/**
 * Mirrors `CurveTwocryptoMathOptimized.newton_D` v2.1.0. With `K0_prev = 0`
 * (what the views pass) the start is `N * isqrt(x0 * x1)`.
 */
export function newtonD(
  ANN: bigint,
  gamma: bigint,
  x_unsorted: readonly [bigint, bigint],
  K0_prev: bigint = 0n
): bigint {
  checkAGamma(ANN, gamma);

  const x = x_unsorted[0] < x_unsorted[1] ? [x_unsorted[1], x_unsorted[0]] : [...x_unsorted];

  if (x[0] < 10n ** 9n || x[0] > 10n ** 33n) fail("unsafe values x[0]");
  if ((x[1] * E18) / x[0] < 10n ** 14n) fail("unsafe values x[i] (input)");

  const S = x[0] + x[1];

  let D: bigint;
  if (K0_prev === 0n) {
    D = N_COINS * isqrt(x[0] * x[1]);
  } else {
    D = isqrt(((4n * x[0] * x[1]) / K0_prev) * E18);
    if (S < D) D = S;
  }

  const __g1k0 = gamma + E18;

  for (let iter = 0; iter < 255; iter++) {
    const D_prev = D;
    if (D <= 0n) fail("D is zero");

    const K0 = ((((E18 * N_COINS ** 2n) * x[0]) / D) * x[1]) / D;

    let _g1k0 = __g1k0;
    if (_g1k0 > K0) {
      _g1k0 = _g1k0 - K0 + 1n;
    } else {
      _g1k0 = K0 - _g1k0 + 1n;
    }

    const mul1 = (((((E18 * D) / gamma) * _g1k0) / gamma) * _g1k0 * A_MULTIPLIER) / ANN;
    const mul2 = (2n * E18 * N_COINS * K0) / _g1k0;

    if (K0 === 0n) fail("K0 is zero");
    const neg_fprime = S + (S * mul2) / E18 + (mul1 * N_COINS) / K0 - (mul2 * D) / E18;
    if (neg_fprime <= 0n) fail("neg_fprime is not positive");

    const D_plus = (D * (neg_fprime + S)) / neg_fprime;
    let D_minus = (D * D) / neg_fprime;
    if (E18 > K0) {
      D_minus += (((D * (mul1 / neg_fprime)) / E18) * (E18 - K0)) / K0;
    } else {
      D_minus -= (((D * (mul1 / neg_fprime)) / E18) * (K0 - E18)) / K0;
      if (D_minus < 0n) fail("D_minus underflow");
    }

    if (D_plus > D_minus) {
      D = D_plus - D_minus;
    } else {
      D = (D_minus - D_plus) / 2n;
    }

    const diff = D > D_prev ? D - D_prev : D_prev - D;
    if (diff * 10n ** 14n < maxInt(10n ** 16n, D)) {
      for (const _x of x) {
        const frac = (_x * E18) / D;
        if (frac < 10n ** 16n / N_COINS || frac > 10n ** 20n / N_COINS) {
          fail("unsafe values x[i]");
        }
      }
      return D;
    }
  }

  fail("newton_D did not converge");
}

// ============================================
// Pool / views (CurveTwocryptoOptimized v2.1.x, CurveCryptoViews2Optimized)
// ============================================

/** Scaled balances `[b0 * p0, b1 * price_scale * p1 / 1e18]` (views order). */
function scale(balances: readonly bigint[], params: TwocryptoOptimizedParams): [bigint, bigint] {
  return [
    balances[0] * params.precisions[0],
    (balances[1] * params.priceScale * params.precisions[1]) / E18,
  ];
}

/** Mirrors the pool's `_fee(xp)`: the dynamic fee (1e10) at scaled balances. */
export function feeCalc(
  xp: readonly [bigint, bigint],
  midFee: bigint,
  outFee: bigint,
  feeGamma: bigint
): bigint {
  let f = xp[0] + xp[1];
  if (f === 0n) fail("zero balances");
  f = (feeGamma * E18) / (feeGamma + E18 - (((E18 * N_COINS ** N_COINS) * xp[0]) / f) * xp[1] / f);
  return (midFee * f + outFee * (E18 - f)) / E18;
}

/** Scaled balances as the pool's `xp` (`pool.fee()` input). */
export function xp(params: TwocryptoOptimizedParams): [bigint, bigint] {
  return scale(params.balances, params);
}

/** Mirrors `pool.fee()`. */
export function fee(params: TwocryptoOptimizedParams): bigint {
  return feeCalc(xp(params), params.midFee, params.outFee, params.feeGamma);
}

/** Mirrors the pool's `_calc_token_fee(amounts, xp)` (1e10). */
export function calcTokenFee(
  amounts: readonly [bigint, bigint],
  xpAfter: readonly [bigint, bigint],
  params: TwocryptoOptimizedParams
): bigint {
  const f = (feeCalc(xpAfter, params.midFee, params.outFee, params.feeGamma) * N_COINS) / 4n;
  const S = amounts[0] + amounts[1];
  if (S === 0n) fail("amounts sum to zero");
  const avg = S / N_COINS;
  let Sdiff = 0n;
  for (const _x of amounts) {
    Sdiff += _x > avg ? _x - avg : avg - _x;
  }
  return (f * Sdiff) / S + NOISE_FEE;
}

/** The views' `_calc_D_ramp`: stored D, or newton_D while ramping. */
function calcDRamp(params: TwocryptoOptimizedParams): bigint {
  if (params.isRamping) {
    return newtonD(params.A, params.gamma, xp(params), 0n);
  }
  return params.D;
}

function requireSupply(params: TwocryptoOptimizedParams): bigint {
  if (params.totalSupply === undefined || params.totalSupply === 0n) {
    fail("totalSupply is required and cannot be zero");
  }
  return params.totalSupply;
}

/** Views `_get_dy_nofee`: `[dy before fee, xp after the trade]`. */
function getDyNoFee(
  params: TwocryptoOptimizedParams,
  i: number,
  j: number,
  dx: bigint
): [bigint, [bigint, bigint]] {
  if (i === j || i < 0 || i > 1 || j < 0 || j > 1) fail("coin index out of range");
  if (dx <= 0n) fail("do not exchange 0 coins");
  const D = calcDRamp(params);
  const balances: [bigint, bigint] = [params.balances[0], params.balances[1]];
  balances[i] += dx;
  const xpNew = scale(balances, params);
  const [y] = getY(params.A, params.gamma, xpNew, D, j);
  let dy = xpNew[j] - y - 1n;
  if (dy < 0n) fail("dy underflow");
  xpNew[j] = y;
  if (j > 0) {
    dy = (dy * E18) / params.priceScale;
  }
  dy = dy / params.precisions[j];
  return [dy, xpNew];
}

/** Mirrors the views' `get_dy(i, j, dx)`. */
export function getDy(params: TwocryptoOptimizedParams, i: number, j: number, dx: bigint): bigint {
  const [dy, xpNew] = getDyNoFee(params, i, j, dx);
  return dy - (feeCalc(xpNew, params.midFee, params.outFee, params.feeGamma) * dy) / FEE_DENOMINATOR;
}

/** Mirrors the views' `calc_fee_get_dy(i, j, dx)`. */
export function calcFeeGetDy(params: TwocryptoOptimizedParams, i: number, j: number, dx: bigint): bigint {
  const [dy, xpNew] = getDyNoFee(params, i, j, dx);
  return (feeCalc(xpNew, params.midFee, params.outFee, params.feeGamma) * dy) / FEE_DENOMINATOR;
}

/** Views `_calc_dtoken_nofee`: `[d_token, amountsp, xp]`. */
function calcDTokenNoFee(
  params: TwocryptoOptimizedParams,
  amounts: readonly [bigint, bigint],
  deposit: boolean
): [bigint, [bigint, bigint], [bigint, bigint]] {
  const supply = requireSupply(params);
  const D0 = calcDRamp(params);
  const balances: [bigint, bigint] = [params.balances[0], params.balances[1]];
  for (let k = 0; k < 2; k++) {
    if (deposit) {
      balances[k] += amounts[k];
    } else {
      if (amounts[k] > balances[k]) fail("withdrawal exceeds pool balance");
      balances[k] -= amounts[k];
    }
  }
  const xpNew = scale(balances, params);
  const amountsp = scale(amounts, params);
  const D = newtonD(params.A, params.gamma, xpNew, 0n);
  let d_token = (supply * D) / D0;
  if (deposit) {
    d_token -= supply;
  } else {
    d_token = supply - d_token;
  }
  if (d_token < 0n) fail("d_token underflow");
  return [d_token, amountsp, xpNew];
}

/**
 * Mirrors the views' `calc_token_amount(amounts, deposit)`: LP minted for a
 * deposit (what `add_liquidity` mints when no ramp is active) or burned for
 * an imbalanced withdrawal, fee on the imbalance included.
 */
export function calcTokenAmount(
  params: TwocryptoOptimizedParams,
  amounts: readonly [bigint, bigint],
  deposit: boolean = true
): bigint {
  const [d_token, amountsp, xpNew] = calcDTokenNoFee(params, amounts, deposit);
  const result = d_token - ((calcTokenFee(amountsp, xpNew, params) * d_token) / FEE_DENOMINATOR + 1n);
  if (result < 0n) fail("fee exceeds token amount");
  return result;
}

/** Mirrors the views' `calc_fee_token_amount(amounts, deposit)`. */
export function calcFeeTokenAmount(
  params: TwocryptoOptimizedParams,
  amounts: readonly [bigint, bigint],
  deposit: boolean = true
): bigint {
  const [d_token, amountsp, xpNew] = calcDTokenNoFee(params, amounts, deposit);
  return (calcTokenFee(amountsp, xpNew, params) * d_token) / FEE_DENOMINATOR + 1n;
}

/**
 * Single-coin withdrawal: `[dy, approx_fee]`.
 *
 * - `"pool"` (default) mirrors the pool's `_calc_withdraw_one_coin`, which
 *   backs both `pool.calc_withdraw_one_coin` and `remove_liquidity_one_coin`:
 *   the fee is `_fee` at xp with xp[i] reduced by `xp[i] * N * amount /
 *   supply`, or `out_fee` when that reduction would underflow.
 * - `"views"` mirrors `CurveCryptoViews2Optimized._calc_withdraw_one_coin`,
 *   which charges `_fee` at the pre-withdrawal xp.
 *
 * Half the fee is charged on the burned share of D; the coin is solved with
 * `get_y`.
 */
export function calcWithdrawOneCoinWithFee(
  params: TwocryptoOptimizedParams,
  tokenAmount: bigint,
  i: number,
  source: "pool" | "views" = "pool"
): [bigint, bigint] {
  const supply = requireSupply(params);
  if (tokenAmount > supply) fail("token amount more than supply");
  if (i !== 0 && i !== 1) fail(`coin out of range (i=${i})`);

  const xx = params.balances;
  let price_scale_i = params.priceScale * params.precisions[1];
  const xpNow: [bigint, bigint] = [xx[0] * params.precisions[0], (xx[1] * price_scale_i) / E18];
  if (i === 0) {
    price_scale_i = E18 * params.precisions[0];
  }

  const D0 = params.isRamping ? newtonD(params.A, params.gamma, xpNow, 0n) : params.D;
  let D = D0;

  let f: bigint;
  if (source === "views") {
    f = feeCalc(xpNow, params.midFee, params.outFee, params.feeGamma);
  } else {
    const xpImprecise: [bigint, bigint] = [xpNow[0], xpNow[1]];
    const xpCorrection = (xpNow[i] * N_COINS * tokenAmount) / supply;
    f = params.outFee;
    if (xpCorrection < xpImprecise[i]) {
      xpImprecise[i] -= xpCorrection;
      f = feeCalc(xpImprecise, params.midFee, params.outFee, params.feeGamma);
    }
  }

  const dD = (tokenAmount * D) / supply;
  const D_fee = (f * dD) / (2n * FEE_DENOMINATOR) + 1n;
  const approx_fee = (N_COINS * D_fee * xx[i]) / D;
  D -= dD - D_fee;
  const [y] = getY(params.A, params.gamma, xpNow, D, i);
  if (y > xpNow[i]) fail("y exceeds balance");
  const dy = ((xpNow[i] - y) * E18) / price_scale_i;
  return [dy, approx_fee];
}

/**
 * Mirrors `pool.calc_withdraw_one_coin(token_amount, i)`: what
 * `remove_liquidity_one_coin` pays.
 */
export function calcWithdrawOneCoin(params: TwocryptoOptimizedParams, tokenAmount: bigint, i: number): bigint {
  return calcWithdrawOneCoinWithFee(params, tokenAmount, i, "pool")[0];
}

/** Mirrors `CurveCryptoViews2Optimized.calc_withdraw_one_coin` (fee at pre-withdrawal xp). */
export function calcWithdrawOneCoinViews(
  params: TwocryptoOptimizedParams,
  tokenAmount: bigint,
  i: number
): bigint {
  return calcWithdrawOneCoinWithFee(params, tokenAmount, i, "views")[0];
}

/**
 * Mirrors balanced `remove_liquidity(amount)` v2.1.x: pays on `amount - 1`
 * unless the whole supply is burned (then the full balances).
 */
export function calcRemoveLiquidity(params: TwocryptoOptimizedParams, amount: bigint): [bigint, bigint] {
  const supply = requireSupply(params);
  if (amount > supply) fail("amount exceeds totalSupply");
  if (amount === supply) return [params.balances[0], params.balances[1]];
  if (amount === 0n) return [0n, 0n];
  const a = amount - 1n;
  return [(params.balances[0] * a) / supply, (params.balances[1] * a) / supply];
}

/** Pool `get_xcp(D, price_scale)`: `isqrt(D / 2 * D * 1e18 / (price_scale * 2))`. */
export function getXcp(D: bigint, priceScale: bigint): bigint {
  return isqrt((D / N_COINS) * ((D * E18) / (priceScale * N_COINS)));
}

/** Mirrors `get_virtual_price()`: `1e18 * get_xcp(D, price_scale) / totalSupply`. */
export function getVirtualPrice(params: TwocryptoOptimizedParams): bigint {
  const supply = requireSupply(params);
  return (E18 * getXcp(params.D, params.priceScale)) / supply;
}

/**
 * Mirrors `lp_price()`: `2 * virtual_price * isqrt(price_oracle * 1e18) / 1e18`.
 *
 * @param cachedVirtualPrice - `pool.virtual_price()` (cached, not `get_virtual_price()`)
 * @param priceOracle - `pool.price_oracle()` at the same block
 */
export function lpPrice(cachedVirtualPrice: bigint, priceOracle: bigint): bigint {
  return (2n * cachedVirtualPrice * isqrt(priceOracle * E18)) / E18;
}
