/**
 * Curve CryptoSwap (v2) Math
 *
 * Off-chain implementation of Curve CryptoSwap formulas for gas-free calculations.
 * Supports both Twocrypto-NG (2 coins) and Tricrypto-NG (3 coins).
 *
 * Based on the CryptoSwap invariant with A and gamma parameters.
 * The dynamic peg mechanism uses price_scale to adjust for token price divergence.
 *
 * References:
 * - Curve v2 whitepaper: https://curve.fi/files/crypto-pools-paper.pdf
 * - Twocrypto-NG source: https://github.com/curvefi/twocrypto-ng
 * - Tricrypto-NG source: https://github.com/curvefi/tricrypto-ng
 */

// Re-export constants from shared module
export {
  PRECISION,
  A_MULTIPLIER,
  FEE_DENOMINATOR,
  MAX_ITERATIONS,
  CONVERGENCE_THRESHOLD,
  MIN_CONVERGENCE,
  DERIVATIVE_EPSILON,
  BPS_DENOMINATOR,
} from "./constants";

import {
  PRECISION,
  A_MULTIPLIER,
  FEE_DENOMINATOR,
  MAX_ITERATIONS,
  CONVERGENCE_THRESHOLD,
  MIN_CONVERGENCE,
  DERIVATIVE_EPSILON,
  BPS_DENOMINATOR,
} from "./constants";

// ============================================
// Unified Pool Parameters Interface
// ============================================

/**
 * Base parameters shared by all CryptoSwap pools
 */
interface CryptoPoolParamsBase {
  /** Amplification parameter (on-chain A) */
  A: bigint;
  /** Gamma parameter for curvature */
  gamma: bigint;
  /** Current invariant D */
  D: bigint;
  /** Mid fee (fee when pool is balanced) */
  midFee: bigint;
  /** Out fee (fee when pool is imbalanced) */
  outFee: bigint;
  /** Fee gamma parameter for fee interpolation */
  feeGamma: bigint;
  /**
   * The pool's `future_A_gamma_time()`. Zero (the default) for a pool that
   * has never ramped A/gamma. When it is non-zero the 2-coin contract
   * recomputes D from the balances (`newton_D`) instead of reading the stored
   * `D` in `get_dy`, `calc_token_amount`, `add_liquidity` and
   * `remove_liquidity_one_coin`; tricrypto2 does so in `add_liquidity` and
   * `remove_liquidity_one_coin`.
   */
  futureAGammaTime?: bigint;
}

/**
 * Pool parameters for 2-coin CryptoSwap (Twocrypto-NG)
 */
export interface TwocryptoParams extends CryptoPoolParamsBase {
  /** Price scale for token 1 relative to token 0 */
  priceScale: bigint;
  /** Pool balances (unscaled, in token decimals) */
  balances: [bigint, bigint];
  /** Token precisions (10^(18-decimals) for each token) */
  precisions?: [bigint, bigint];
}

/**
 * Pool parameters for 3-coin CryptoSwap (Tricrypto-NG)
 */
export interface TricryptoParams extends CryptoPoolParamsBase {
  /** Price scales for tokens 1 and 2 relative to token 0 */
  priceScales: [bigint, bigint];
  /** Pool balances (unscaled, in token decimals) */
  balances: [bigint, bigint, bigint];
  /** Token precisions (10^(18-decimals) for each token) */
  precisions?: [bigint, bigint, bigint];
}

/** Backward-compatible alias */
export type CryptoSwapParams = TwocryptoParams;

// ============================================
// Core Math Functions
// ============================================

/**
 * Newton's method to find y in 2-coin CryptoSwap invariant
 * Direct translation from Curve v2 Vyper source: newton_y()
 *
 * @param A - Raw A parameter from pool
 * @param gamma - gamma parameter
 * @param x - scaled balances [x0, x1]
 * @param D - invariant D
 * @param i - index of the output token (the one we're solving for)
 */
export function newtonY(
  A: bigint,
  gamma: bigint,
  x: [bigint, bigint],
  D: bigint,
  i: number
): bigint {
  const N_COINS = 2n;

  // Guard against invalid index
  if (i < 0 || i > 1) {
    throw new Error(`newtonY: index out of bounds (i=${i}, must be 0 or 1)`);
  }
  // Guard against wrong array length
  if (x.length !== 2) {
    throw new Error(`newtonY: x array must have exactly 2 elements (got ${x.length})`);
  }
  // Guard against zero parameters (would cause division by zero)
  if (A === 0n) {
    throw new Error("newtonY: A cannot be zero");
  }
  if (gamma === 0n) {
    throw new Error("newtonY: gamma cannot be zero");
  }

  // x_j is the other token's balance (not the one we're solving for)
  const x_j = x[1 - i];

  // Guard against zero balance (would cause division by zero)
  if (x_j === 0n) {
    throw new Error("newtonY: zero balance would cause division by zero");
  }
  if (D === 0n) {
    throw new Error("newtonY: D cannot be zero");
  }

  // Initial guess: y = D^2 / (x_j * N^2)
  let y = (D * D) / (x_j * N_COINS * N_COINS);

  // Guard against y = 0 (can occur when D^2 < x_j * 4, i.e., tiny D relative to balance)
  if (y === 0n) {
    throw new Error("newtonY: initial y estimate is zero (D too small relative to balance)");
  }

  // K0_i = (10^18 * N) * x_j / D
  const K0_i = (PRECISION * N_COINS * x_j) / D;

  // Convergence limit
  const convergence_limit = (() => {
    const a = x_j / CONVERGENCE_THRESHOLD;
    const b = D / CONVERGENCE_THRESHOLD;
    let max = a > b ? a : b;
    if (max < MIN_CONVERGENCE) max = MIN_CONVERGENCE;
    return max;
  })();

  for (let j = 0; j < MAX_ITERATIONS; j++) {
    const y_prev = y;

    // K0 = K0_i * y * N / D
    const K0 = (K0_i * y * N_COINS) / D;

    // S = x_j + y
    const S = x_j + y;

    // _g1k0 = |gamma + 10^18 - K0| + 1
    let _g1k0 = gamma + PRECISION;
    if (_g1k0 > K0) {
      _g1k0 = _g1k0 - K0 + 1n;
    } else {
      _g1k0 = K0 - _g1k0 + 1n;
    }

    // mul1 = 10^18 * D / gamma * _g1k0 / gamma * _g1k0 * A_MULTIPLIER / A
    const mul1 =
      (((((PRECISION * D) / gamma) * _g1k0) / gamma) * _g1k0 * A_MULTIPLIER) / A;

    // mul2 = 10^18 + (2 * 10^18) * K0 / _g1k0
    const mul2 = PRECISION + (2n * PRECISION * K0) / _g1k0;

    // yfprime = 10^18 * y + S * mul2 + mul1
    const yfprime_base = PRECISION * y + S * mul2 + mul1;

    // _dyfprime = D * mul2
    const _dyfprime = D * mul2;

    let yfprime: bigint;
    if (yfprime_base < _dyfprime) {
      y = y_prev / 2n;
      if (y === 0n) y = 1n; // Prevent division by zero in next iteration
      continue;
    } else {
      yfprime = yfprime_base - _dyfprime;
    }

    // Guard against y = 0 (would cause division by zero)
    if (y === 0n) {
      throw new Error("newtonY: y became zero during iteration, cannot converge");
    }
    // Guard against fprime = 0 (would cause division by zero)
    const fprime = yfprime / y;
    if (fprime === 0n) {
      throw new Error("newtonY: fprime is zero, cannot divide");
    }
    // Guard against K0 = 0 (would cause division by zero)
    if (K0 === 0n) {
      throw new Error("newtonY: K0 is zero, cannot divide");
    }
    const y_minus_base = mul1 / fprime;
    const y_plus =
      (yfprime + PRECISION * D) / fprime + (y_minus_base * PRECISION) / K0;
    const y_minus = y_minus_base + (PRECISION * S) / fprime;

    if (y_plus < y_minus) {
      y = y_prev / 2n;
      if (y === 0n) y = 1n; // Prevent division by zero in next iteration
    } else {
      y = y_plus - y_minus;
      if (y === 0n) y = 1n; // Prevent division by zero in next iteration
    }

    const diff = y > y_prev ? y - y_prev : y_prev - y;
    const threshold = y / CONVERGENCE_THRESHOLD;
    if (diff < (convergence_limit > threshold ? convergence_limit : threshold)) {
      return y;
    }
  }

  throw new Error("newtonY did not converge");
}

/**
 * Newton's method to find y in 3-coin CryptoSwap invariant
 * Direct translation of the tricrypto2 math contract's newton_y()
 *
 * @param A - Raw A parameter from pool
 * @param gamma - gamma parameter
 * @param x - scaled balances [x0, x1, x2]
 * @param D - invariant D
 * @param i - index of the output token (the one we're solving for)
 */
export function newtonY3(
  A: bigint,
  gamma: bigint,
  x: [bigint, bigint, bigint],
  D: bigint,
  i: number
): bigint {
  const N_COINS = 3n;

  // Guard against invalid index
  if (i < 0 || i > 2) {
    throw new Error(`newtonY3: index out of bounds (i=${i}, must be 0, 1, or 2)`);
  }
  // Guard against wrong array length
  if (x.length !== 3) {
    throw new Error(`newtonY3: x array must have exactly 3 elements (got ${x.length})`);
  }
  // Guard against zero parameters (would cause division by zero)
  if (A === 0n) {
    throw new Error("newtonY3: A cannot be zero");
  }
  if (gamma === 0n) {
    throw new Error("newtonY3: gamma cannot be zero");
  }
  if (D === 0n) {
    throw new Error("newtonY3: D cannot be zero");
  }

  // Guard against zero balances among the other coins
  for (let k = 0; k < 3; k++) {
    if (k !== i && x[k] === 0n) {
      throw new Error(`newtonY3: zero balance at index ${k} would cause division by zero`);
    }
  }

  // x_sorted: x with x[i] zeroed, sorted from high to low
  const x_sorted = sortDesc(x.map((v, k) => (k === i ? 0n : v)));

  const convergence_limit = (() => {
    const a = x_sorted[0] / CONVERGENCE_THRESHOLD;
    const b = D / CONVERGENCE_THRESHOLD;
    let max = a > b ? a : b;
    if (max < MIN_CONVERGENCE) max = MIN_CONVERGENCE;
    return max;
  })();

  // Initial guess y = D^N / (N^N * prod(x_k, k != i)), small x first;
  // K0_i = 10^18 * prod(x_k * N / D, k != i), large x first
  let y = D / N_COINS;
  let K0_i = PRECISION;
  let S = 0n;
  for (let j = 2; j <= 3; j++) {
    const _x = x_sorted[3 - j];
    y = (y * D) / (_x * N_COINS);
    S += _x;
  }
  for (let j = 0; j < 2; j++) {
    K0_i = (K0_i * x_sorted[j] * N_COINS) / D;
  }

  // Guard against y = 0 (tiny D relative to the balances)
  if (y === 0n) {
    throw new Error("newtonY3: initial y estimate is zero (D too small relative to balances)");
  }

  for (let j = 0; j < MAX_ITERATIONS; j++) {
    const y_prev = y;

    // K0 = K0_i * y * N / D
    const K0 = (K0_i * y * N_COINS) / D;

    // S_total = S + y
    const S_total = S + y;

    // _g1k0 = |gamma + 10^18 - K0| + 1
    let _g1k0 = gamma + PRECISION;
    if (_g1k0 > K0) {
      _g1k0 = _g1k0 - K0 + 1n;
    } else {
      _g1k0 = K0 - _g1k0 + 1n;
    }

    // mul1 = 10^18 * D / gamma * _g1k0 / gamma * _g1k0 * A_MULTIPLIER / A
    const mul1 =
      (((((PRECISION * D) / gamma) * _g1k0) / gamma) * _g1k0 * A_MULTIPLIER) / A;

    // mul2 = 10^18 + (2 * 10^18) * K0 / _g1k0
    const mul2 = PRECISION + (2n * PRECISION * K0) / _g1k0;

    const yfprime_base = PRECISION * y + S_total * mul2 + mul1;
    const _dyfprime = D * mul2;

    let yfprime: bigint;
    if (yfprime_base < _dyfprime) {
      y = y_prev / 2n;
      if (y === 0n) y = 1n; // Prevent division by zero in next iteration
      continue;
    } else {
      yfprime = yfprime_base - _dyfprime;
    }

    // Guard against y = 0 (would cause division by zero)
    if (y === 0n) {
      throw new Error("newtonY3: y became zero during iteration, cannot converge");
    }
    // Guard against fprime = 0 (would cause division by zero)
    const fprime = yfprime / y;
    if (fprime === 0n) {
      throw new Error("newtonY3: fprime is zero, cannot divide");
    }
    // Guard against K0 = 0 (would cause division by zero)
    if (K0 === 0n) {
      throw new Error("newtonY3: K0 is zero, cannot divide");
    }
    const y_minus_base = mul1 / fprime;
    const y_plus =
      (yfprime + PRECISION * D) / fprime + (y_minus_base * PRECISION) / K0;
    const y_minus = y_minus_base + (PRECISION * S_total) / fprime;

    if (y_plus < y_minus) {
      y = y_prev / 2n;
      if (y === 0n) y = 1n; // Prevent division by zero in next iteration
    } else {
      y = y_plus - y_minus;
      if (y === 0n) y = 1n; // Prevent division by zero in next iteration
    }

    const diff = y > y_prev ? y - y_prev : y_prev - y;
    const threshold = y / CONVERGENCE_THRESHOLD;
    if (diff < (convergence_limit > threshold ? convergence_limit : threshold)) {
      return y;
    }
  }

  throw new Error("newtonY3 did not converge");
}

/** Sort from high to low (Vyper `sort`). */
function sortDesc(x: readonly bigint[]): bigint[] {
  return [...x].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

/**
 * Geometric mean (x[0] * x[1] * ...) ** (1/N).
 * Direct translation of Vyper `geometric_mean(unsorted_x, sort)`: the 2-coin
 * pools use the collapsed iteration `D = (D + x0 * x1 / D) / 2`, the 3-coin
 * math contract the generic one.
 *
 * @param unsortedX - Values (2 or 3)
 * @param sort - Sort from high to low first (the Vyper default)
 */
export function geometricMean(unsortedX: bigint[], sort: boolean = true): bigint {
  const x = sort ? sortDesc(unsortedX) : unsortedX;
  const N = BigInt(x.length);
  let D = x[0];
  if (D === 0n) {
    throw new Error("geometricMean: zero value would cause division by zero");
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const D_prev = D;
    if (x.length === 2) {
      D = (D + (x[0] * x[1]) / D) / N;
    } else {
      let tmp = PRECISION;
      for (const _x of x) {
        tmp = (tmp * _x) / D;
      }
      D = (D * ((N - 1n) * PRECISION + tmp)) / (N * PRECISION);
    }
    if (D === 0n) {
      throw new Error("geometricMean: zero value would cause division by zero");
    }
    const diff = D > D_prev ? D - D_prev : D_prev - D;
    if (diff <= 1n || diff * PRECISION < D) {
      return D;
    }
  }

  throw new Error("geometricMean did not converge");
}

/**
 * CryptoSwap invariant D by Newton's method.
 * Direct translation of Vyper `newton_D(ANN, gamma, x_unsorted)` from
 * CurveCryptoSwap2 (2 coins) and the tricrypto2 math contract (3 coins):
 * it starts from `N * geometric_mean(x)`, iterates on the sorted balances and
 * stops when `diff * 10**14 < max(10**16, D)`.
 *
 * The contract's safety asserts on the balances are mirrored as errors
 * ("unsafe values"). Its A/gamma range asserts are not: their constants
 * differ between deployments.
 *
 * @param A - On-chain `A()` (already A * N**N * A_MULTIPLIER)
 * @param gamma - On-chain `gamma()`
 * @param xUnsorted - Scaled balances (2 or 3 coins)
 * @returns D invariant
 */
export function newtonD(A: bigint, gamma: bigint, xUnsorted: bigint[]): bigint {
  if (A === 0n) {
    throw new Error("newtonD: A parameter cannot be zero");
  }
  if (gamma === 0n) {
    throw new Error("newtonD: gamma parameter cannot be zero");
  }
  if (xUnsorted.length !== 2 && xUnsorted.length !== 3) {
    throw new Error(`newtonD: pool must have 2 or 3 coins (got ${xUnsorted.length})`);
  }

  const N = BigInt(xUnsorted.length);
  const x = sortDesc(xUnsorted);

  if (x[0] < 10n ** 9n || x[0] > 10n ** 33n) {
    throw new Error("newtonD: unsafe values x[0]");
  }
  // x[i] / x[0] >= 1e-4 (2 coins) or 1e-7 (3 coins)
  const minFrac = x.length === 2 ? 10n ** 14n : 10n ** 11n;
  for (let i = 1; i < x.length; i++) {
    if ((x[i] * PRECISION) / x[0] < minFrac) {
      throw new Error("newtonD: unsafe values x[i] (input)");
    }
  }

  // Initial value of invariant D is that for constant-product invariant
  let D = N * geometricMean(x, false);
  let S = 0n;
  for (const x_i of x) {
    S += x_i;
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const D_prev = D;

    let K0: bigint;
    if (x.length === 2) {
      // collapsed for 2 coins
      K0 = (((PRECISION * N * N * x[0]) / D) * x[1]) / D;
    } else {
      K0 = PRECISION;
      for (const _x of x) {
        K0 = (K0 * _x * N) / D;
      }
    }
    if (K0 === 0n) {
      throw new Error("newtonD: unsafe values (K0 is zero)");
    }

    // _g1k0 = |gamma + 10^18 - K0| + 1
    let _g1k0 = gamma + PRECISION;
    if (_g1k0 > K0) {
      _g1k0 = _g1k0 - K0 + 1n;
    } else {
      _g1k0 = K0 - _g1k0 + 1n;
    }

    // D / (A * N**N) * _g1k0**2 / gamma**2
    const mul1 = (((((PRECISION * D) / gamma) * _g1k0) / gamma) * _g1k0 * A_MULTIPLIER) / A;

    // 2*N*K0 / _g1k0
    const mul2 = (2n * PRECISION * N * K0) / _g1k0;

    const neg_fprime = S + (S * mul2) / PRECISION + (mul1 * N) / K0 - (mul2 * D) / PRECISION;
    if (neg_fprime <= 0n) {
      throw new Error("newtonD: unsafe values (neg_fprime is not positive)");
    }

    // D -= f / fprime
    const D_plus = (D * (neg_fprime + S)) / neg_fprime;
    let D_minus = (D * D) / neg_fprime;
    if (PRECISION > K0) {
      D_minus += (((D * (mul1 / neg_fprime)) / PRECISION) * (PRECISION - K0)) / K0;
    } else {
      D_minus -= (((D * (mul1 / neg_fprime)) / PRECISION) * (K0 - PRECISION)) / K0;
      if (D_minus < 0n) {
        throw new Error("newtonD: unsafe values (D_minus underflow)");
      }
    }

    if (D_plus > D_minus) {
      D = D_plus - D_minus;
    } else {
      D = (D_minus - D_plus) / 2n;
    }
    if (D === 0n) {
      throw new Error("newtonD: unsafe values (D is zero)");
    }

    const diff = D > D_prev ? D - D_prev : D_prev - D;
    if (diff * CONVERGENCE_THRESHOLD < (D > 10n ** 16n ? D : 10n ** 16n)) {
      // Test that we are safe with the next newton_y
      for (const _x of x) {
        const frac = (_x * PRECISION) / D;
        if (frac < 10n ** 16n || frac > 10n ** 20n) {
          throw new Error("newtonD: unsafe values x[i]");
        }
      }
      return D;
    }
  }

  throw new Error("newtonD did not converge");
}

/**
 * Calculate D invariant for a 2- or 3-coin CryptoSwap pool.
 *
 * Validated wrapper around {@link newtonD}: an empty pool (all balances
 * zero) returns 0n.
 *
 * @param A - On-chain `A()`
 * @param gamma - Gamma parameter
 * @param xp - Scaled balances
 * @returns D invariant
 */
export function calcD(A: bigint, gamma: bigint, xp: bigint[]): bigint {
  // Input validation
  if (A === 0n) {
    throw new Error("calcD: A parameter cannot be zero");
  }
  if (gamma === 0n) {
    throw new Error("calcD: gamma parameter cannot be zero");
  }
  if (xp.length < 2) {
    throw new Error("calcD: pool must have at least 2 coins");
  }

  let S = 0n;
  for (const x of xp) {
    S += x;
  }
  // Empty pool (all zeros) - return 0n
  if (S === 0n) return 0n;

  // Check for partial zero balances (would propagate 0 through K0 calculation)
  // Only check after S > 0 since an empty pool is valid
  for (let idx = 0; idx < xp.length; idx++) {
    if (xp[idx] === 0n) {
      throw new Error(`calcD: zero balance at index ${idx} would cause invalid K0 calculation`);
    }
  }

  return newtonD(A, gamma, xp);
}

/**
 * Calculate dynamic fee for N-coin CryptoSwap pool
 *
 * @param xp - Scaled balances
 * @param feeGamma - Fee gamma parameter
 * @param midFee - Mid fee (balanced pool)
 * @param outFee - Out fee (imbalanced pool)
 * @returns Dynamic fee
 */
export function dynamicFee(
  xp: bigint[],
  feeGamma: bigint,
  midFee: bigint,
  outFee: bigint
): bigint {
  const N = BigInt(xp.length);

  let sum = 0n;
  for (const x of xp) {
    sum += x;
  }
  if (sum === 0n) return midFee;

  // K = 10^18 * N^N * prod(xp) / sum^N, in the contract's order of operations:
  // 2 coins (_fee): (10^18 * N^N) * x0 / S * x1 / S
  // 3 coins (reduction_coefficient): K = K * N * x_i / S for each coin
  let K: bigint;
  if (xp.length === 2) {
    K = PRECISION * N ** N;
    for (const x of xp) {
      K = (K * x) / sum;
    }
  } else {
    K = PRECISION;
    for (const x of xp) {
      K = (K * N * x) / sum;
    }
  }

  // Guard against zero/negative denominator
  const denominator = feeGamma + PRECISION - K;
  if (denominator <= 0n) return outFee; // Max fee for extreme imbalance

  const f = (feeGamma * PRECISION) / denominator;
  return (midFee * f + outFee * (PRECISION - f)) / PRECISION;
}

// ============================================
// Balance Scaling Functions
// ============================================

/**
 * Scale 2-coin balances to internal units
 */
export function scaleBalances(
  balances: [bigint, bigint],
  precisions: [bigint, bigint],
  priceScale: bigint
): [bigint, bigint] {
  return [
    balances[0] * precisions[0],
    (balances[1] * precisions[1] * priceScale) / PRECISION,
  ];
}

/**
 * Scale 3-coin balances to internal units
 */
export function scaleBalances3(
  balances: [bigint, bigint, bigint],
  precisions: [bigint, bigint, bigint],
  priceScales: [bigint, bigint]
): [bigint, bigint, bigint] {
  return [
    balances[0] * precisions[0],
    (balances[1] * precisions[1] * priceScales[0]) / PRECISION,
    (balances[2] * precisions[2] * priceScales[1]) / PRECISION,
  ];
}

/**
 * Unscale output amount based on token index (2-coin)
 */
function unscaleOutput2(
  dy: bigint,
  j: number,
  precisions: [bigint, bigint],
  priceScale: bigint
): bigint {
  // Guard against zero precision/priceScale
  if (precisions[j] === 0n) return 0n;
  if (j === 0) {
    return dy / precisions[0];
  }
  if (priceScale === 0n) return 0n;
  return (dy * PRECISION) / (precisions[1] * priceScale);
}

/**
 * Unscale output amount based on token index (3-coin)
 */
function unscaleOutput3(
  dy: bigint,
  j: number,
  precisions: [bigint, bigint, bigint],
  priceScales: [bigint, bigint]
): bigint {
  // Guard against zero precision/priceScale
  if (precisions[j] === 0n) return 0n;
  if (j === 0) {
    return dy / precisions[0];
  } else if (j === 1) {
    if (priceScales[0] === 0n) return 0n;
    return (dy * PRECISION) / (precisions[1] * priceScales[0]);
  }
  if (priceScales[1] === 0n) return 0n;
  return (dy * PRECISION) / (precisions[2] * priceScales[1]);
}

// ============================================
// Swap Functions (getDy, getDx)
// ============================================

/**
 * Off-chain implementation of CurveCryptoSwap2 `get_dy` (exact: same order
 * of operations and rounding as the contract)
 * @returns Output amount (0n for invalid inputs)
 */
export function getDy(
  params: TwocryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  // Input validation
  if (i === j) return 0n;
  if (i < 0 || i > 1 || j < 0 || j > 1) return 0n;
  if (dx === 0n) return 0n;

  const { A, gamma, midFee, outFee, feeGamma, priceScale, balances } = params;
  const precisions = params.precisions ?? [1n, 1n];

  // Stored D, or D recomputed from the current balances once A/gamma has ramped
  let D = params.D;
  if ((params.futureAGammaTime ?? 0n) > 0n) {
    D = newtonD(A, gamma, scaleBalances(balances, precisions, priceScale));
  }

  // Add dx to input token BEFORE scaling
  const newBalances: [bigint, bigint] = [balances[0], balances[1]];
  newBalances[i] = newBalances[i] + dx;

  // Scale to internal units
  const xp = scaleBalances(newBalances, precisions, priceScale);

  // Newton's method to find new y
  const y = newtonY(A, gamma, xp, D, j);

  // dy = xp[j] - y - 1
  let dy = xp[j] - y - 1n;
  if (dy < 0n) return 0n;

  // Update xp[j] for fee calculation
  const xp_after: [bigint, bigint] = [xp[0], xp[1]];
  xp_after[j] = y;

  // Convert dy back to external units, THEN charge the fee (Vyper order)
  dy = unscaleOutput2(dy, j, precisions, priceScale);
  const fee = dynamicFee(xp_after, feeGamma, midFee, outFee);
  dy = dy - (fee * dy) / FEE_DENOMINATOR;

  return dy > 0n ? dy : 0n;
}

/**
 * Off-chain implementation of tricrypto2 `get_dy` (the views contract;
 * exact: same order of operations and rounding)
 * @returns Output amount (0n for invalid inputs)
 */
export function getDy3(
  params: TricryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  // Input validation
  if (i === j) return 0n;
  if (i < 0 || i > 2 || j < 0 || j > 2) return 0n;
  if (dx === 0n) return 0n;

  const { A, gamma, D, midFee, outFee, feeGamma, priceScales, balances } = params;
  const precisions = params.precisions ?? [1n, 1n, 1n];

  // Add dx to input token BEFORE scaling
  const newBalances: [bigint, bigint, bigint] = [...balances];
  newBalances[i] = newBalances[i] + dx;

  // Scale to internal units
  const xp = scaleBalances3(newBalances, precisions, priceScales);

  // Newton's method to find new y
  const y = newtonY3(A, gamma, xp, D, j);

  // dy = xp[j] - y - 1
  let dy = xp[j] - y - 1n;
  if (dy < 0n) return 0n;

  // Update xp[j] for fee calculation
  const xp_after: [bigint, bigint, bigint] = [...xp];
  xp_after[j] = y;

  // Convert dy back to external units, THEN charge the fee (Vyper order)
  dy = unscaleOutput3(dy, j, precisions, priceScales);
  const fee = dynamicFee(xp_after, feeGamma, midFee, outFee);
  dy = dy - (fee * dy) / FEE_DENOMINATOR;

  return dy > 0n ? dy : 0n;
}

/**
 * Calculate get_dx for 2-coin CryptoSwap (input needed for desired output)
 * Uses binary search for accuracy with dynamic fees
 * @returns Required input amount (0n for invalid inputs)
 */
export function getDx(
  params: TwocryptoParams,
  i: number,
  j: number,
  dy: bigint
): bigint {
  // Input validation
  if (i === j) return 0n;
  if (i < 0 || i > 1 || j < 0 || j > 1) return 0n;
  if (dy === 0n) return 0n;
  if (dy >= params.balances[j]) return 0n;

  // 1. Initial estimate using spot price (more accurate than balance heuristic)
  const spotPrice = getSpotPrice(params, i, j);
  let high: bigint;

  if (spotPrice > 0n) {
    // dx ~= dy / price, with 2x safety margin for slippage
    high = (dy * PRECISION * 2n) / spotPrice;
  } else {
    // Fallback if price is 0 (empty pool edge case)
    high = params.balances[i] * 10n;
  }

  // Ensure high is at least non-zero
  if (high === 0n) high = PRECISION;

  // 2. Expand upper bound if insufficient (exponential search)
  // Double up to 10 times (1024x) to handle high slippage or imbalanced pools
  for (let k = 0; k < 10; k++) {
    const dyAtHigh = getDy(params, i, j, high);
    if (dyAtHigh >= dy) break;
    high = high * 2n;
  }

  // Guard: after expansion, if we still can't reach dy, return 0n
  const dyAtFinalHigh = getDy(params, i, j, high);
  if (dyAtFinalHigh < dy) return 0n;

  // 3. Binary search for precise dx
  let low = 0n;
  // Fix: ensure tolerance is at least 1n to avoid zero tolerance for small dy
  const tolerance = dy / 10000n > 0n ? dy / 10000n : 1n;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const mid = (low + high) / 2n;
    const dyCalc = getDy(params, i, j, mid);

    if (dyCalc >= dy) {
      const diff = dyCalc - dy;
      if (diff <= tolerance) {
        high = mid;
        if (high - low <= 1n) return mid;
      } else {
        high = mid;
      }
    } else {
      low = mid;
    }

    if (high - low <= 1n) break;
  }

  return high;
}

/**
 * Calculate get_dx for 3-coin CryptoSwap (input needed for desired output)
 * @returns Required input amount (0n for invalid inputs)
 */
export function getDx3(
  params: TricryptoParams,
  i: number,
  j: number,
  dy: bigint
): bigint {
  // Input validation
  if (i === j) return 0n;
  if (i < 0 || i > 2 || j < 0 || j > 2) return 0n;
  if (dy === 0n) return 0n;
  if (dy >= params.balances[j]) return 0n;

  // 1. Initial estimate using spot price (more accurate than balance heuristic)
  const spotPrice = getSpotPrice3(params, i, j);
  let high: bigint;

  if (spotPrice > 0n) {
    // dx ~= dy / price, with 2x safety margin for slippage
    high = (dy * PRECISION * 2n) / spotPrice;
  } else {
    // Fallback if price is 0 (empty pool edge case)
    high = params.balances[i] * 10n;
  }

  // Ensure high is at least non-zero
  if (high === 0n) high = PRECISION;

  // 2. Expand upper bound if insufficient (exponential search)
  // Double up to 10 times (1024x) to handle high slippage or imbalanced pools
  for (let k = 0; k < 10; k++) {
    const dyAtHigh = getDy3(params, i, j, high);
    if (dyAtHigh >= dy) break;
    high = high * 2n;
  }

  // Guard: after expansion, if we still can't reach dy, return 0n
  const dyAtFinalHigh = getDy3(params, i, j, high);
  if (dyAtFinalHigh < dy) return 0n;

  // 3. Binary search for precise dx
  let low = 0n;
  // Fix: ensure tolerance is at least 1n to avoid zero tolerance for small dy
  const tolerance = dy / 10000n > 0n ? dy / 10000n : 1n;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const mid = (low + high) / 2n;
    const dyCalc = getDy3(params, i, j, mid);

    if (dyCalc >= dy) {
      const diff = dyCalc - dy;
      if (diff <= tolerance) {
        high = mid;
        if (high - low <= 1n) return mid;
      } else {
        high = mid;
      }
    } else {
      low = mid;
    }

    if (high - low <= 1n) break;
  }

  return high;
}

// ============================================
// Peg Point Functions
// ============================================

/**
 * Find peg point for 2-coin pool
 */
export function findPegPoint(
  params: TwocryptoParams,
  i: number,
  j: number,
  precision: bigint = 10n * PRECISION
): bigint {
  const minAmount = PRECISION;
  const dyForMin = getDy(params, i, j, minAmount);
  if (dyForMin < minAmount) return 0n;

  const maxSwap = params.balances[0] + params.balances[1];
  let low = minAmount;
  let high = maxSwap;

  while (high - low > precision) {
    const mid = (low + high) / 2n;
    const dy = getDy(params, i, j, mid);
    if (dy >= mid) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Find peg point for 3-coin pool
 */
export function findPegPoint3(
  params: TricryptoParams,
  i: number,
  j: number,
  precision: bigint = 10n * PRECISION
): bigint {
  const minAmount = PRECISION;
  const dyForMin = getDy3(params, i, j, minAmount);
  if (dyForMin < minAmount) return 0n;

  let maxSwap = 0n;
  for (const bal of params.balances) {
    maxSwap += bal;
  }

  let low = minAmount;
  let high = maxSwap;

  while (high - low > precision) {
    const mid = (low + high) / 2n;
    const dy = getDy3(params, i, j, mid);
    if (dy >= mid) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

// ============================================
// Liquidity Functions
// ============================================

/** Flat fee added to every imbalanced-deposit fee (Vyper `NOISE_FEE`, 0.1 bps) */
export const NOISE_FEE = 10n ** 5n;

/**
 * Fee charged on a deposit / imbalanced withdrawal, as a fraction of the LP
 * amount (1e10 precision). Direct translation of Vyper `_calc_token_fee`:
 * `fee(xp) * N / (4 * (N - 1)) * sum(|amounts_i - avg|) / sum(amounts) + NOISE_FEE`.
 *
 * @param amounts - Scaled deposit amounts (same units as xp)
 * @param xp - Scaled balances AFTER the deposit
 */
export function calcTokenFee(
  amounts: bigint[],
  xp: bigint[],
  feeGamma: bigint,
  midFee: bigint,
  outFee: bigint
): bigint {
  const N = BigInt(amounts.length);
  const fee = (dynamicFee(xp, feeGamma, midFee, outFee) * N) / (4n * (N - 1n));
  let S = 0n;
  for (const _x of amounts) {
    S += _x;
  }
  if (S === 0n) {
    throw new Error("calcTokenFee: amounts sum to zero");
  }
  const avg = S / N;
  let Sdiff = 0n;
  for (const _x of amounts) {
    Sdiff += _x > avg ? _x - avg : avg - _x;
  }
  return (fee * Sdiff) / S + NOISE_FEE;
}

/**
 * Extended constant-product invariant xCP for a 2-coin pool (Vyper `get_xcp`):
 * geometric mean of `[D / N, D * 10^18 / (N * price_scale)]`.
 */
export function getXcp(D: bigint, priceScale: bigint): bigint {
  return geometricMean([D / 2n, (D * PRECISION) / (priceScale * 2n)], true);
}

/**
 * Extended constant-product invariant xCP for a 3-coin pool (Vyper `get_xcp`).
 */
export function getXcp3(D: bigint, priceScales: [bigint, bigint]): bigint {
  return geometricMean(
    [
      D / 3n,
      (D * PRECISION) / (3n * priceScales[0]),
      (D * PRECISION) / (3n * priceScales[1]),
    ],
    true
  );
}

/** Result of an `add_liquidity` call */
export interface AddLiquidityResult {
  /** LP tokens minted to the depositor (the contract's return value) */
  lpMinted: bigint;
  /** LP tokens withheld as fee (`d_token_fee`; 0n for the first deposit) */
  lpFee: bigint;
  /** Invariant D after the deposit, before any price_scale adjustment */
  D: bigint;
  /** Scaled balances after the deposit */
  xp: bigint[];
  /** LP total supply after the mint */
  totalSupply: bigint;
}

/** Result of a `remove_liquidity_one_coin` call */
export interface RemoveLiquidityOneCoinResult {
  /** Amount of coin i sent to the withdrawer (the contract's return value) */
  dy: bigint;
  /** Invariant D after the withdrawal, before any price_scale adjustment */
  D: bigint;
  /** Scaled balances after the withdrawal */
  xp: bigint[];
  /** Invariant D the withdrawal started from (stored or recomputed) */
  D0: bigint;
  /** LP-proportional share of D burned (`dD`) */
  dD: bigint;
}

/** Shared add_liquidity math: `xpOld`/`xp` are the scaled balances before/after. */
function addLiquidityFromXp(
  params: CryptoPoolParamsBase,
  amountsp: bigint[],
  xpOld: bigint[],
  xp: bigint[],
  totalSupply: bigint,
  xcp: (D: bigint) => bigint
): AddLiquidityResult {
  let hasAmount = false;
  for (const a of amountsp) {
    if (a > 0n) hasAmount = true;
  }
  if (!hasAmount) {
    throw new Error("calcAddLiquidity: no coins to add");
  }

  const old_D =
    (params.futureAGammaTime ?? 0n) > 0n ? calcD(params.A, params.gamma, xpOld) : params.D;
  const D = newtonD(params.A, params.gamma, xp);

  if (old_D === 0n) {
    // First deposit: initial virtual price is 1
    const lpMinted = xcp(D);
    return { lpMinted, lpFee: 0n, D, xp, totalSupply: totalSupply + lpMinted };
  }

  let d_token = (totalSupply * D) / old_D - totalSupply;
  if (d_token <= 0n) {
    throw new Error("calcAddLiquidity: nothing minted");
  }
  const lpFee =
    (calcTokenFee(amountsp, xp, params.feeGamma, params.midFee, params.outFee) * d_token) /
      FEE_DENOMINATOR +
    1n;
  d_token -= lpFee;
  if (d_token < 0n) {
    throw new Error("calcAddLiquidity: fee exceeds minted amount");
  }
  return { lpMinted: d_token, lpFee, D, xp, totalSupply: totalSupply + d_token };
}

/**
 * LP tokens minted by CurveCryptoSwap2 `add_liquidity` (2-coin), fee
 * included. Exact translation of the state-changing function: the old D is
 * the stored `params.D` (recomputed from balances when
 * `futureAGammaTime > 0`), and the fee is `_calc_token_fee`.
 *
 * The contract may then adjust `price_scale` and claim admin fees
 * (`tweak_price`); neither changes the amount minted by this call.
 */
export function calcAddLiquidity(
  params: TwocryptoParams,
  amounts: [bigint, bigint],
  totalSupply: bigint
): AddLiquidityResult {
  const precisions = params.precisions ?? [1n, 1n];
  const xpOld = scaleBalances(params.balances, precisions, params.priceScale);
  const xp = scaleBalances(
    [params.balances[0] + amounts[0], params.balances[1] + amounts[1]],
    precisions,
    params.priceScale
  );
  const amountsp = amounts.map((a, k) => (a > 0n ? xp[k] - xpOld[k] : 0n));
  return addLiquidityFromXp(params, amountsp, xpOld, xp, totalSupply, (D) =>
    getXcp(D, params.priceScale)
  );
}

/**
 * LP tokens minted by tricrypto2 `add_liquidity` (3-coin), fee included.
 * Exact translation of the state-changing function (see {@link calcAddLiquidity}).
 */
export function calcAddLiquidity3(
  params: TricryptoParams,
  amounts: [bigint, bigint, bigint],
  totalSupply: bigint
): AddLiquidityResult {
  const precisions = params.precisions ?? [1n, 1n, 1n];
  const xpOld = scaleBalances3(params.balances, precisions, params.priceScales);
  const xp = scaleBalances3(
    [
      params.balances[0] + amounts[0],
      params.balances[1] + amounts[1],
      params.balances[2] + amounts[2],
    ],
    precisions,
    params.priceScales
  );
  const amountsp = amounts.map((a, k) => (a > 0n ? xp[k] - xpOld[k] : 0n));
  return addLiquidityFromXp(params, amountsp, xpOld, xp, totalSupply, (D) =>
    getXcp3(D, params.priceScales)
  );
}

/**
 * LP tokens received for depositing amounts (2-coin).
 * Exact translation of the CurveCryptoSwap2 view `calc_token_amount(amounts)`,
 * deposit fee included. D0 is the stored `params.D` (recomputed from the
 * balances when `futureAGammaTime > 0`), as in the contract.
 *
 * For an empty pool (totalSupply = 0) the on-chain view reverts; this returns
 * what the first `add_liquidity` mints (xCP of the new D).
 */
export function calcTokenAmount(
  params: TwocryptoParams,
  amounts: [bigint, bigint],
  totalSupply: bigint
): bigint {
  const precisions = params.precisions ?? [1n, 1n];

  const xp = scaleBalances(params.balances, precisions, params.priceScale);
  const amountsp = scaleBalances(amounts, precisions, params.priceScale);

  let D0 = params.D;
  if ((params.futureAGammaTime ?? 0n) > 0n) {
    D0 = calcD(params.A, params.gamma, xp);
  }

  xp[0] += amountsp[0];
  xp[1] += amountsp[1];
  const D = calcD(params.A, params.gamma, xp);

  if (totalSupply === 0n) {
    return getXcp(D, params.priceScale);
  }

  // Guard against D0 === 0n (invalid pool state with non-zero supply)
  if (D0 === 0n) {
    throw new Error("calcTokenAmount: pool invariant D is zero");
  }

  let d_token = (totalSupply * D) / D0 - totalSupply;
  d_token -=
    (calcTokenFee(amountsp, xp, params.feeGamma, params.midFee, params.outFee) * d_token) /
      FEE_DENOMINATOR +
    1n;
  return d_token > 0n ? d_token : 0n;
}

/**
 * LP tokens received for depositing amounts, or burned for withdrawing
 * them (3-coin). Exact translation of the tricrypto2 views contract's
 * `calc_token_amount(amounts, deposit)`, fee included; D0 is the stored
 * `params.D`.
 *
 * For an empty pool (totalSupply = 0) the on-chain view reverts; this returns
 * what the first `add_liquidity` mints (xCP of the new D).
 *
 * @param deposit - true for a deposit (default), false for a withdrawal
 */
export function calcTokenAmount3(
  params: TricryptoParams,
  amounts: [bigint, bigint, bigint],
  totalSupply: bigint,
  deposit: boolean = true
): bigint {
  const precisions = params.precisions ?? [1n, 1n, 1n];

  const newBalances: [bigint, bigint, bigint] = [...params.balances];
  for (let k = 0; k < 3; k++) {
    if (deposit) {
      newBalances[k] += amounts[k];
    } else {
      if (amounts[k] > newBalances[k]) {
        throw new Error("calcTokenAmount3: withdrawal exceeds pool balance");
      }
      newBalances[k] -= amounts[k];
    }
  }
  const xp = scaleBalances3(newBalances, precisions, params.priceScales);
  const amountsp = scaleBalances3(amounts, precisions, params.priceScales);
  const D = calcD(params.A, params.gamma, xp);

  if (totalSupply === 0n) {
    return getXcp3(D, params.priceScales);
  }

  // Guard against D0 === 0n (invalid pool state with non-zero supply)
  if (params.D === 0n) {
    throw new Error("calcTokenAmount3: pool invariant D is zero");
  }

  let d_token = (totalSupply * D) / params.D;
  d_token = deposit ? d_token - totalSupply : totalSupply - d_token;
  d_token -=
    (calcTokenFee(amountsp, xp, params.feeGamma, params.midFee, params.outFee) * d_token) /
      FEE_DENOMINATOR +
    1n;
  return d_token > 0n ? d_token : 0n;
}

/**
 * Shared `_calc_withdraw_one_coin` math. The fee is charged on D, not on y:
 * `D -= dD - (fee * dD / (2 * 10^10) + 1)`.
 */
function withdrawOneCoinFromXp(
  params: CryptoPoolParamsBase,
  xp: bigint[],
  D0: bigint,
  tokenAmount: bigint,
  totalSupply: bigint,
  i: number,
  priceScaleI: bigint,
  solveY: (D: bigint) => bigint
): RemoveLiquidityOneCoinResult {
  const fee = dynamicFee(xp, params.feeGamma, params.midFee, params.outFee);
  const dD = (tokenAmount * D0) / totalSupply;
  const D = D0 - (dD - ((fee * dD) / (2n * FEE_DENOMINATOR) + 1n));
  const y = solveY(D);
  if (y > xp[i]) {
    throw new Error("calcWithdrawOneCoin: unsafe values (y exceeds balance)");
  }
  const dy = ((xp[i] - y) * PRECISION) / priceScaleI;
  const xpAfter = [...xp];
  xpAfter[i] = y;
  return { dy, D, xp: xpAfter, D0, dD };
}

function validateWithdrawOneCoin(
  name: string,
  tokenAmount: bigint,
  totalSupply: bigint
): void {
  if (totalSupply === 0n) {
    throw new Error(`${name}: totalSupply cannot be zero`);
  }
  if (tokenAmount > totalSupply) {
    throw new Error(`${name}: tokenAmount exceeds totalSupply`);
  }
}

function withdrawOneCoin2(
  name: string,
  params: TwocryptoParams,
  tokenAmount: bigint,
  i: number,
  totalSupply: bigint,
  updateD: boolean
): RemoveLiquidityOneCoinResult {
  validateWithdrawOneCoin(name, tokenAmount, totalSupply);
  const precisions = params.precisions ?? [1n, 1n];
  const xp = scaleBalances(params.balances, precisions, params.priceScale);
  const D0 = updateD ? calcD(params.A, params.gamma, xp) : params.D;
  const priceScaleI =
    i === 0 ? PRECISION * precisions[0] : params.priceScale * precisions[1];
  return withdrawOneCoinFromXp(params, xp, D0, tokenAmount, totalSupply, i, priceScaleI, (D) =>
    newtonY(params.A, params.gamma, xp, D, i)
  );
}

function withdrawOneCoin3(
  name: string,
  params: TricryptoParams,
  tokenAmount: bigint,
  i: number,
  totalSupply: bigint,
  updateD: boolean
): RemoveLiquidityOneCoinResult {
  validateWithdrawOneCoin(name, tokenAmount, totalSupply);
  const precisions = params.precisions ?? [1n, 1n, 1n];
  const xp = scaleBalances3(params.balances, precisions, params.priceScales);
  const D0 = updateD ? calcD(params.A, params.gamma, xp) : params.D;
  const priceScaleI =
    i === 0 ? PRECISION * precisions[0] : params.priceScales[i - 1] * precisions[i];
  return withdrawOneCoinFromXp(params, xp, D0, tokenAmount, totalSupply, i, priceScaleI, (D) =>
    newtonY3(params.A, params.gamma, xp, D, i)
  );
}

/**
 * Tokens received for single-sided LP withdrawal (2-coin).
 * Exact translation of the CurveCryptoSwap2 view
 * `calc_withdraw_one_coin(token_amount, i)`: D is recomputed from the
 * balances (`newton_D`), half the dynamic fee is charged on the burned share
 * of D, and the output is `(xp[i] - newton_y) * 10^18 / price_scale_i`.
 */
export function calcWithdrawOneCoin(
  params: TwocryptoParams,
  tokenAmount: bigint,
  i: number,
  totalSupply: bigint
): bigint {
  // Input validation
  if (i < 0 || i > 1) return 0n;
  if (totalSupply === 0n) {
    throw new Error("calcWithdrawOneCoin: totalSupply cannot be zero");
  }
  if (tokenAmount === 0n) return 0n;

  return withdrawOneCoin2("calcWithdrawOneCoin", params, tokenAmount, i, totalSupply, true).dy;
}

/**
 * Tokens received for single-sided LP withdrawal (3-coin).
 * Exact translation of the tricrypto2 view
 * `calc_withdraw_one_coin(token_amount, i)` (see {@link calcWithdrawOneCoin}).
 */
export function calcWithdrawOneCoin3(
  params: TricryptoParams,
  tokenAmount: bigint,
  i: number,
  totalSupply: bigint
): bigint {
  // Input validation
  if (i < 0 || i > 2) return 0n;
  if (totalSupply === 0n) {
    throw new Error("calcWithdrawOneCoin3: totalSupply cannot be zero");
  }
  if (tokenAmount === 0n) return 0n;

  return withdrawOneCoin3("calcWithdrawOneCoin3", params, tokenAmount, i, totalSupply, true).dy;
}

/**
 * CurveCryptoSwap2 `remove_liquidity_one_coin` (2-coin): the state-changing
 * call. Unlike the `calc_withdraw_one_coin` view it starts from the stored
 * `params.D` unless `futureAGammaTime > 0`.
 */
export function calcRemoveLiquidityOneCoin(
  params: TwocryptoParams,
  tokenAmount: bigint,
  i: number,
  totalSupply: bigint
): RemoveLiquidityOneCoinResult {
  if (i < 0 || i > 1) {
    throw new Error(`calcRemoveLiquidityOneCoin: index out of bounds (i=${i})`);
  }
  if (tokenAmount === 0n) {
    throw new Error("calcRemoveLiquidityOneCoin: tokenAmount cannot be zero");
  }
  return withdrawOneCoin2(
    "calcRemoveLiquidityOneCoin",
    params,
    tokenAmount,
    i,
    totalSupply,
    (params.futureAGammaTime ?? 0n) > 0n
  );
}

/**
 * tricrypto2 `remove_liquidity_one_coin` (3-coin): the state-changing call
 * (see {@link calcRemoveLiquidityOneCoin}).
 */
export function calcRemoveLiquidityOneCoin3(
  params: TricryptoParams,
  tokenAmount: bigint,
  i: number,
  totalSupply: bigint
): RemoveLiquidityOneCoinResult {
  if (i < 0 || i > 2) {
    throw new Error(`calcRemoveLiquidityOneCoin3: index out of bounds (i=${i})`);
  }
  if (tokenAmount === 0n) {
    throw new Error("calcRemoveLiquidityOneCoin3: tokenAmount cannot be zero");
  }
  return withdrawOneCoin3(
    "calcRemoveLiquidityOneCoin3",
    params,
    tokenAmount,
    i,
    totalSupply,
    (params.futureAGammaTime ?? 0n) > 0n
  );
}

/**
 * Calculate balanced removal of liquidity (2-coin).
 * Exact translation of `remove_liquidity`: the contract pays out on
 * `_amount - 1` ("rounding errors favoring other LPs a tiny bit").
 */
export function calcRemoveLiquidity(
  params: TwocryptoParams,
  tokenAmount: bigint,
  totalSupply: bigint
): [bigint, bigint] {
  if (totalSupply === 0n) return [0n, 0n];
  if (tokenAmount > totalSupply) {
    throw new Error(
      `calcRemoveLiquidity: tokenAmount (${tokenAmount}) exceeds totalSupply (${totalSupply})`
    );
  }
  if (tokenAmount === 0n) return [0n, 0n];
  const amount = tokenAmount - 1n;
  return [
    (params.balances[0] * amount) / totalSupply,
    (params.balances[1] * amount) / totalSupply,
  ];
}

/**
 * Calculate balanced removal of liquidity (3-coin).
 * Exact translation of `remove_liquidity` (pays out on `_amount - 1`).
 */
export function calcRemoveLiquidity3(
  params: TricryptoParams,
  tokenAmount: bigint,
  totalSupply: bigint
): [bigint, bigint, bigint] {
  if (totalSupply === 0n) return [0n, 0n, 0n];
  if (tokenAmount > totalSupply) {
    throw new Error(
      `calcRemoveLiquidity3: tokenAmount (${tokenAmount}) exceeds totalSupply (${totalSupply})`
    );
  }
  if (tokenAmount === 0n) return [0n, 0n, 0n];
  const amount = tokenAmount - 1n;
  return [
    (params.balances[0] * amount) / totalSupply,
    (params.balances[1] * amount) / totalSupply,
    (params.balances[2] * amount) / totalSupply,
  ];
}

// ============================================
// Price Functions
// ============================================

/**
 * Virtual price of the LP token (2-coin).
 * Exact translation of `get_virtual_price()`:
 * `10^18 * get_xcp(D) / totalSupply` with the pool's stored `params.D`.
 */
export function getVirtualPrice(
  params: TwocryptoParams,
  totalSupply: bigint
): bigint {
  if (totalSupply === 0n) return PRECISION;
  return (PRECISION * getXcp(params.D, params.priceScale)) / totalSupply;
}

/**
 * Virtual price of the LP token (3-coin).
 * Exact translation of tricrypto2 `get_virtual_price()` (stored `params.D`).
 */
export function getVirtualPrice3(
  params: TricryptoParams,
  totalSupply: bigint
): bigint {
  if (totalSupply === 0n) return PRECISION;
  return (PRECISION * getXcp3(params.D, params.priceScales)) / totalSupply;
}

/**
 * Integer square root of a 1e18 fixed-point number (Vyper `sqrt_int`).
 */
export function sqrtInt(x: bigint): bigint {
  if (x === 0n) return 0n;

  let z = (x + PRECISION) / 2n;
  let y = x;

  for (let i = 0; i < 256; i++) {
    if (z === y) return y;
    y = z;
    z = ((x * PRECISION) / z + z) / 2n;
  }

  throw new Error("sqrtInt did not converge");
}

/**
 * LP token price in coin 0 as the 2-coin contract's `lp_price()` reports it:
 * `2 * virtual_price * sqrt_int(price_oracle) / 10^18`.
 *
 * @param virtualPrice - The pool's cached `virtual_price()` (not `get_virtual_price()`)
 * @param priceOracle - The pool's `price_oracle()`
 */
export function lpPriceFromOracle(virtualPrice: bigint, priceOracle: bigint): bigint {
  return (2n * virtualPrice * sqrtInt(priceOracle)) / PRECISION;
}

/**
 * Pro-rata pool value per LP token in terms of token[0] at price_scale (2-coin).
 * This is NOT the contract's `lp_price()`; see {@link lpPriceFromOracle}.
 */
export function lpPrice(
  params: TwocryptoParams,
  totalSupply: bigint
): bigint {
  if (totalSupply === 0n) return PRECISION;
  const precisions = params.precisions ?? [1n, 1n];

  const value0 = params.balances[0] * precisions[0];
  const value1 = (params.balances[1] * precisions[1] * params.priceScale) / PRECISION;
  const totalValue = value0 + value1;

  return (totalValue * PRECISION) / totalSupply;
}

/**
 * Pro-rata pool value per LP token in terms of token[0] at price_scale (3-coin).
 */
export function lpPrice3(
  params: TricryptoParams,
  totalSupply: bigint
): bigint {
  if (totalSupply === 0n) return PRECISION;
  const precisions = params.precisions ?? [1n, 1n, 1n];

  const value0 = params.balances[0] * precisions[0];
  const value1 = (params.balances[1] * precisions[1] * params.priceScales[0]) / PRECISION;
  const value2 = (params.balances[2] * precisions[2] * params.priceScales[1]) / PRECISION;
  const totalValue = value0 + value1 + value2;

  return (totalValue * PRECISION) / totalSupply;
}

/**
 * Get spot price (2-coin)
 * Uses precision-scaled epsilon for accurate derivative calculation
 * @returns Spot price (0n for invalid inputs)
 */
export function getSpotPrice(
  params: TwocryptoParams,
  i: number,
  j: number
): bigint {
  // Input validation
  if (i === j) return 0n;
  if (i < 0 || i > 1 || j < 0 || j > 1) return 0n;

  // Scale epsilon by input token precision to handle non-18-decimal tokens
  // For 18-decimal: precision=1, dx=10^12 (small amount)
  // For 6-decimal: precision=10^12, dx=10^12/10^12=1 (1 unit)
  const precisions = params.precisions ?? [1n, 1n];
  // Guard against zero precision
  if (precisions[i] === 0n) return 0n;
  const dx = DERIVATIVE_EPSILON / precisions[i];

  // Ensure dx is at least 1
  const safeDx = dx > 0n ? dx : 1n;
  const dy = getDy(params, i, j, safeDx);
  if (safeDx === 0n) return 0n;

  return (dy * PRECISION) / safeDx;
}

/**
 * Get spot price (3-coin)
 * Uses precision-scaled epsilon for accurate derivative calculation
 * @returns Spot price (0n for invalid inputs)
 */
export function getSpotPrice3(
  params: TricryptoParams,
  i: number,
  j: number
): bigint {
  // Input validation
  if (i === j) return 0n;
  if (i < 0 || i > 2 || j < 0 || j > 2) return 0n;

  // Scale epsilon by input token precision to handle non-18-decimal tokens
  const precisions = params.precisions ?? [1n, 1n, 1n];
  // Guard against zero precision
  if (precisions[i] === 0n) return 0n;
  const dx = DERIVATIVE_EPSILON / precisions[i];

  // Ensure dx is at least 1
  const safeDx = dx > 0n ? dx : 1n;
  const dy = getDy3(params, i, j, safeDx);
  if (safeDx === 0n) return 0n;

  return (dy * PRECISION) / safeDx;
}

/**
 * Get effective price for a swap (2-coin)
 */
export function getEffectivePrice(
  params: TwocryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  if (dx === 0n) return getSpotPrice(params, i, j);
  const dy = getDy(params, i, j, dx);
  return (dy * PRECISION) / dx;
}

/**
 * Get effective price for a swap (3-coin)
 */
export function getEffectivePrice3(
  params: TricryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  if (dx === 0n) return getSpotPrice3(params, i, j);
  const dy = getDy3(params, i, j, dx);
  return (dy * PRECISION) / dx;
}

/**
 * Calculate price impact for a swap (2-coin)
 */
export function getPriceImpact(
  params: TwocryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  const spotPrice = getSpotPrice(params, i, j);
  const effectivePrice = getEffectivePrice(params, i, j, dx);

  if (spotPrice === 0n) return 0n;
  const impact = ((spotPrice - effectivePrice) * BPS_DENOMINATOR) / spotPrice;
  return impact > 0n ? impact : 0n;
}

/**
 * Calculate price impact for a swap (3-coin)
 */
export function getPriceImpact3(
  params: TricryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  const spotPrice = getSpotPrice3(params, i, j);
  const effectivePrice = getEffectivePrice3(params, i, j, dx);

  if (spotPrice === 0n) return 0n;
  const impact = ((spotPrice - effectivePrice) * BPS_DENOMINATOR) / spotPrice;
  return impact > 0n ? impact : 0n;
}

// ============================================
// Ramping Functions
// ============================================

/**
 * Calculate A and gamma during ramping
 */
export function getAGammaAtTime(
  initialA: bigint,
  futureA: bigint,
  initialGamma: bigint,
  futureGamma: bigint,
  initialTime: bigint,
  futureTime: bigint,
  currentTime: bigint
): [bigint, bigint] {
  // Validate futureTime > initialTime to prevent division by zero
  if (futureTime <= initialTime) {
    throw new Error("getAGammaAtTime: futureTime must be greater than initialTime");
  }
  if (currentTime >= futureTime) {
    return [futureA, futureGamma];
  }
  if (currentTime <= initialTime) {
    return [initialA, initialGamma];
  }

  const elapsed = currentTime - initialTime;
  const duration = futureTime - initialTime;

  const currentA = initialA > futureA
    ? initialA - ((initialA - futureA) * elapsed) / duration
    : initialA + ((futureA - initialA) * elapsed) / duration;

  const currentGamma = initialGamma > futureGamma
    ? initialGamma - ((initialGamma - futureGamma) * elapsed) / duration
    : initialGamma + ((futureGamma - initialGamma) * elapsed) / duration;

  return [currentA, currentGamma];
}

// ============================================
// Utility Wrappers
// ============================================

/**
 * Full swap quote
 */
export interface CryptoSwapQuote {
  amountOut: bigint;
  fee: bigint;
  priceImpact: bigint;
  effectivePrice: bigint;
  spotPrice: bigint;
}

/**
 * Get complete swap quote (2-coin)
 */
export function quoteSwap(
  params: TwocryptoParams,
  i: number,
  j: number,
  dx: bigint
): CryptoSwapQuote {
  const spotPrice = getSpotPrice(params, i, j);
  const amountOut = getDy(params, i, j, dx);
  const effectivePrice = dx > 0n ? (amountOut * PRECISION) / dx : 0n;
  const priceImpact = spotPrice > 0n
    ? ((spotPrice - effectivePrice) * BPS_DENOMINATOR) / spotPrice
    : 0n;

  const precisions = params.precisions ?? [1n, 1n];
  const xp = scaleBalances(params.balances, precisions, params.priceScale);
  const fee = dynamicFee(xp, params.feeGamma, params.midFee, params.outFee);

  // Guard against fee >= FEE_DENOMINATOR (would cause division by zero or negative)
  const feeAmount = fee >= FEE_DENOMINATOR ? 0n : (amountOut * fee) / (FEE_DENOMINATOR - fee);

  return {
    amountOut,
    fee: feeAmount,
    priceImpact: priceImpact > 0n ? priceImpact : 0n,
    effectivePrice,
    spotPrice,
  };
}

/**
 * Get complete swap quote (3-coin)
 */
export function quoteSwap3(
  params: TricryptoParams,
  i: number,
  j: number,
  dx: bigint
): CryptoSwapQuote {
  const spotPrice = getSpotPrice3(params, i, j);
  const amountOut = getDy3(params, i, j, dx);
  const effectivePrice = dx > 0n ? (amountOut * PRECISION) / dx : 0n;
  const priceImpact = spotPrice > 0n
    ? ((spotPrice - effectivePrice) * BPS_DENOMINATOR) / spotPrice
    : 0n;

  const precisions = params.precisions ?? [1n, 1n, 1n];
  const xp = scaleBalances3(params.balances, precisions, params.priceScales);
  const fee = dynamicFee(xp, params.feeGamma, params.midFee, params.outFee);

  // Guard against fee >= FEE_DENOMINATOR (would cause division by zero or negative)
  const feeAmount = fee >= FEE_DENOMINATOR ? 0n : (amountOut * fee) / (FEE_DENOMINATOR - fee);

  return {
    amountOut,
    fee: feeAmount,
    priceImpact: priceImpact > 0n ? priceImpact : 0n,
    effectivePrice,
    spotPrice,
  };
}

/**
 * Validate slippage bounds
 * @param slippageBps - Slippage in basis points
 * @throws Error if slippage is negative or > 10000 (100%)
 */
function validateSlippageBps(slippageBps: number): void {
  if (slippageBps < 0 || slippageBps > 10000) {
    throw new Error(
      `Invalid slippageBps: ${slippageBps}. Must be between 0 and 10000 (0-100%)`
    );
  }
}

/**
 * Get output amount with slippage (2-coin)
 */
export function getAmountOut(
  params: TwocryptoParams,
  i: number,
  j: number,
  dx: bigint,
  slippageBps: number
): [bigint, bigint] {
  validateSlippageBps(slippageBps);
  const amountOut = getDy(params, i, j, dx);
  const minAmountOut = (amountOut * BigInt(10000 - slippageBps)) / BPS_DENOMINATOR;
  return [amountOut, minAmountOut];
}

/**
 * Get output amount with slippage (3-coin)
 */
export function getAmountOut3(
  params: TricryptoParams,
  i: number,
  j: number,
  dx: bigint,
  slippageBps: number
): [bigint, bigint] {
  validateSlippageBps(slippageBps);
  const amountOut = getDy3(params, i, j, dx);
  const minAmountOut = (amountOut * BigInt(10000 - slippageBps)) / BPS_DENOMINATOR;
  return [amountOut, minAmountOut];
}

/**
 * Get input amount with slippage (2-coin)
 */
export function getAmountIn(
  params: TwocryptoParams,
  i: number,
  j: number,
  dy: bigint,
  slippageBps: number
): [bigint, bigint] {
  validateSlippageBps(slippageBps);
  const amountIn = getDx(params, i, j, dy);
  const maxAmountIn = (amountIn * BigInt(10000 + slippageBps)) / BPS_DENOMINATOR;
  return [amountIn, maxAmountIn];
}

/**
 * Get input amount with slippage (3-coin)
 */
export function getAmountIn3(
  params: TricryptoParams,
  i: number,
  j: number,
  dy: bigint,
  slippageBps: number
): [bigint, bigint] {
  validateSlippageBps(slippageBps);
  const amountIn = getDx3(params, i, j, dy);
  const maxAmountIn = (amountIn * BigInt(10000 + slippageBps)) / BPS_DENOMINATOR;
  return [amountIn, maxAmountIn];
}

/**
 * Calculate min output with slippage tolerance
 */
export function calculateMinDy(expectedOutput: bigint, slippageBps: number): string {
  validateSlippageBps(slippageBps);
  const minDy = (expectedOutput * BigInt(10000 - slippageBps)) / BPS_DENOMINATOR;
  return minDy.toString();
}

/**
 * Calculate max input with slippage tolerance
 */
export function calculateMaxDx(expectedInput: bigint, slippageBps: number): string {
  validateSlippageBps(slippageBps);
  const maxDx = (expectedInput * BigInt(10000 + slippageBps)) / BPS_DENOMINATOR;
  return maxDx.toString();
}

/**
 * Create default precisions for 18-decimal tokens (2-coin)
 */
export function defaultPrecisions(): [bigint, bigint] {
  return [1n, 1n];
}

/**
 * Create default precisions for 18-decimal tokens (3-coin)
 */
export function defaultPrecisions3(): [bigint, bigint, bigint] {
  return [1n, 1n, 1n];
}

// ============================================
// Legacy Aliases (for compatibility)
// ============================================

/** @deprecated Use calcD instead - calcD now handles any number of coins */
export const calcD3 = calcD;

/** @deprecated Use dynamicFee instead - dynamicFee now handles any number of coins */
export const dynamicFee3 = dynamicFee;
