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

// Precision constants matching Vyper source
export const PRECISION = 10n ** 18n;
export const A_MULTIPLIER = 10000n;
export const FEE_DENOMINATOR = 10n ** 10n;
export const MAX_ITERATIONS = 255;

/**
 * Pool parameters for 2-coin CryptoSwap (Twocrypto-NG)
 */
export interface TwocryptoParams {
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
export interface TricryptoParams {
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
// Twocrypto (2-coin) Implementation
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

  // x_j is the other token's balance (not the one we're solving for)
  const x_j = x[1 - i];

  // Initial guess: y = D^2 / (x_j * N^2)
  let y = (D * D) / (x_j * N_COINS * N_COINS);

  // K0_i = (10^18 * N) * x_j / D
  const K0_i = (PRECISION * N_COINS * x_j) / D;

  // Convergence limit
  const convergence_limit = (() => {
    const a = x_j / (10n ** 14n);
    const b = D / (10n ** 14n);
    let max = a > b ? a : b;
    if (max < 100n) max = 100n;
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
      continue;
    } else {
      yfprime = yfprime_base - _dyfprime;
    }

    const fprime = yfprime / y;
    const y_minus_base = mul1 / fprime;
    const y_plus =
      (yfprime + PRECISION * D) / fprime + (y_minus_base * PRECISION) / K0;
    const y_minus = y_minus_base + (PRECISION * S) / fprime;

    if (y_plus < y_minus) {
      y = y_prev / 2n;
    } else {
      y = y_plus - y_minus;
    }

    const diff = y > y_prev ? y - y_prev : y_prev - y;
    const threshold = y / (10n ** 14n);
    if (diff < (convergence_limit > threshold ? convergence_limit : threshold)) {
      return y;
    }
  }

  return y;
}

/**
 * Calculate dynamic fee for 2-coin CryptoSwap pool
 */
export function dynamicFee(
  xp: [bigint, bigint],
  feeGamma: bigint,
  midFee: bigint,
  outFee: bigint
): bigint {
  const N_COINS = 2n;
  const sum = xp[0] + xp[1];
  if (sum === 0n) return midFee;

  // K = (10^18 * N^N) * prod(xp) / sum^N
  const K = ((PRECISION * N_COINS * N_COINS * xp[0]) / sum) * xp[1] / sum;

  const f = (feeGamma * PRECISION) / (feeGamma + PRECISION - K);
  return (midFee * f + outFee * (PRECISION - f)) / PRECISION;
}

/**
 * Off-chain implementation of Twocrypto get_dy
 */
export function getDy(
  params: TwocryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  if (dx === 0n) return 0n;

  const { A, gamma, D, midFee, outFee, feeGamma, priceScale, balances } = params;
  const precisions = params.precisions ?? [1n, 1n];

  const price_scale_internal = priceScale * precisions[1];
  const xp_unscaled: [bigint, bigint] = [balances[0], balances[1]];
  xp_unscaled[i] = xp_unscaled[i] + dx;

  const xp: [bigint, bigint] = [
    xp_unscaled[0] * precisions[0],
    (xp_unscaled[1] * price_scale_internal) / PRECISION,
  ];

  const y = newtonY(A, gamma, xp, D, j);
  let dy = xp[j] - y - 1n;
  if (dy < 0n) return 0n;

  const xp_after: [bigint, bigint] = [xp[0], xp[1]];
  xp_after[j] = y;

  if (j > 0) {
    dy = (dy * PRECISION) / price_scale_internal;
  } else {
    dy = dy / precisions[0];
  }

  const fee = dynamicFee(xp_after, feeGamma, midFee, outFee);
  dy = dy - (dy * fee) / FEE_DENOMINATOR;

  return dy;
}

/**
 * Find peg point for 2-coin pool
 */
export function findPegPoint(
  params: TwocryptoParams,
  i: number,
  j: number,
  precision: bigint = 10n * 10n ** 18n
): bigint {
  const minAmount = 10n ** 18n;
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

// ============================================
// Tricrypto (3-coin) Implementation
// ============================================

/**
 * Newton's method to find y in 3-coin CryptoSwap invariant
 * Based on Tricrypto-NG Vyper source
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
  const N_COINS_POW = 27n; // 3^3

  // Sum and product of other balances (excluding i)
  let S = 0n;
  let prod = PRECISION;
  for (let k = 0; k < 3; k++) {
    if (k !== i) {
      S += x[k];
      prod = (prod * x[k]) / PRECISION;
    }
  }

  // Initial guess: y = D^3 / (N^N * prod(x_k for k != i))
  let y = (((D * D) / prod) * D) / (N_COINS_POW * PRECISION);

  // K0_i = (10^18 * N^(N-1)) * prod(x_k for k != i) / D^(N-1)
  // For N=3: K0_i = 9 * 10^18 * prod / D^2
  const K0_i = (PRECISION * 9n * prod) / ((D * D) / PRECISION);

  // Convergence limit
  const convergence_limit = (() => {
    let max_val = D / (10n ** 14n);
    for (let k = 0; k < 3; k++) {
      if (k !== i) {
        const val = x[k] / (10n ** 14n);
        if (val > max_val) max_val = val;
      }
    }
    if (max_val < 100n) max_val = 100n;
    return max_val;
  })();

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
      continue;
    } else {
      yfprime = yfprime_base - _dyfprime;
    }

    const fprime = yfprime / y;
    const y_minus_base = mul1 / fprime;
    const y_plus =
      (yfprime + PRECISION * D) / fprime + (y_minus_base * PRECISION) / K0;
    const y_minus = y_minus_base + (PRECISION * S_total) / fprime;

    if (y_plus < y_minus) {
      y = y_prev / 2n;
    } else {
      y = y_plus - y_minus;
    }

    const diff = y > y_prev ? y - y_prev : y_prev - y;
    const threshold = y / (10n ** 14n);
    if (diff < (convergence_limit > threshold ? convergence_limit : threshold)) {
      return y;
    }
  }

  return y;
}

/**
 * Calculate dynamic fee for 3-coin CryptoSwap pool
 */
export function dynamicFee3(
  xp: [bigint, bigint, bigint],
  feeGamma: bigint,
  midFee: bigint,
  outFee: bigint
): bigint {
  const N_COINS = 3n;
  const N_COINS_POW = 27n;

  const sum = xp[0] + xp[1] + xp[2];
  if (sum === 0n) return midFee;

  // K = (10^18 * N^N) * prod(xp) / sum^N
  let K = PRECISION * N_COINS_POW;
  for (const x of xp) {
    K = (K * x) / sum;
  }

  const f = (feeGamma * PRECISION) / (feeGamma + PRECISION - K);
  return (midFee * f + outFee * (PRECISION - f)) / PRECISION;
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
 * Off-chain implementation of Tricrypto get_dy
 */
export function getDy3(
  params: TricryptoParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  if (dx === 0n) return 0n;

  const { A, gamma, D, midFee, outFee, feeGamma, priceScales, balances } = params;
  const precisions = params.precisions ?? [1n, 1n, 1n];

  // Add dx to input token BEFORE scaling
  const xp_unscaled: [bigint, bigint, bigint] = [...balances];
  xp_unscaled[i] = xp_unscaled[i] + dx;

  // Scale to internal units
  const xp = scaleBalances3(xp_unscaled, precisions, priceScales);

  // Newton's method to find new y
  const y = newtonY3(A, gamma, xp, D, j);

  // dy = xp[j] - y - 1
  let dy = xp[j] - y - 1n;
  if (dy < 0n) return 0n;

  // Update xp[j] for fee calculation
  const xp_after: [bigint, bigint, bigint] = [...xp];
  xp_after[j] = y;

  // Convert dy back to external units
  if (j === 0) {
    dy = dy / precisions[0];
  } else if (j === 1) {
    dy = (dy * PRECISION) / (precisions[1] * priceScales[0]);
  } else {
    dy = (dy * PRECISION) / (precisions[2] * priceScales[1]);
  }

  // Apply dynamic fee
  const fee = dynamicFee3(xp_after, feeGamma, midFee, outFee);
  dy = dy - (dy * fee) / FEE_DENOMINATOR;

  return dy;
}

/**
 * Find peg point for 3-coin pool
 */
export function findPegPoint3(
  params: TricryptoParams,
  i: number,
  j: number,
  precision: bigint = 10n * 10n ** 18n
): bigint {
  const minAmount = 10n ** 18n;
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
// Reverse Swap (getDx) Functions
// ============================================

/**
 * Calculate get_dx for 2-coin CryptoSwap (input needed for desired output)
 * Uses binary search for accuracy with dynamic fees
 *
 * @param params - Pool parameters
 * @param i - Input token index
 * @param j - Output token index
 * @param dy - Desired output amount
 * @returns Required input amount to receive dy output
 */
export function getDx(
  params: TwocryptoParams,
  i: number,
  j: number,
  dy: bigint
): bigint {
  if (dy === 0n) return 0n;
  if (dy >= params.balances[j]) return 0n; // Can't withdraw more than pool has

  // Binary search for dx that gives us dy
  let low = 0n;
  let high = params.balances[i] * 10n; // Upper bound: 10x current balance

  const tolerance = dy / 10000n; // 0.01% tolerance

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const mid = (low + high) / 2n;
    const dyCalc = getDy(params, i, j, mid);

    if (dyCalc >= dy) {
      // Found enough or more, try lower
      const diff = dyCalc - dy;
      if (diff <= tolerance) {
        // Close enough, refine to find minimum dx
        high = mid;
        if (high - low <= 1n) return mid;
      } else {
        high = mid;
      }
    } else {
      // Not enough, need more input
      low = mid;
    }

    if (high - low <= 1n) break;
  }

  // Return the higher bound to ensure we get at least dy
  return high;
}

/**
 * Calculate get_dx for 3-coin CryptoSwap (input needed for desired output)
 * Uses binary search for accuracy with dynamic fees
 *
 * @param params - Pool parameters
 * @param i - Input token index
 * @param j - Output token index
 * @param dy - Desired output amount
 * @returns Required input amount to receive dy output
 */
export function getDx3(
  params: TricryptoParams,
  i: number,
  j: number,
  dy: bigint
): bigint {
  if (dy === 0n) return 0n;
  if (dy >= params.balances[j]) return 0n;

  let low = 0n;
  let high = params.balances[i] * 10n;

  const tolerance = dy / 10000n;

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
// D Calculation Functions
// ============================================

/**
 * Calculate D invariant for 2-coin CryptoSwap using Newton's method
 * Based on Curve v2 get_D implementation
 *
 * @param A - Amplification parameter
 * @param gamma - Gamma parameter
 * @param xp - Scaled balances
 * @returns D invariant
 */
export function calcD(A: bigint, gamma: bigint, xp: [bigint, bigint]): bigint {
  const N_COINS = 2n;

  const S = xp[0] + xp[1];
  if (S === 0n) return 0n;

  let D = S;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const D_prev = D;

    // K0 = 4 * prod(x) * 10^18 / D^2
    const K0 = (((4n * xp[0] * xp[1]) / D) * PRECISION) / D;

    // _g1k0 = |gamma + 10^18 - K0| + 1
    let _g1k0 = gamma + PRECISION;
    if (_g1k0 > K0) {
      _g1k0 = _g1k0 - K0 + 1n;
    } else {
      _g1k0 = K0 - _g1k0 + 1n;
    }

    // mul1 = 10^18 * D / gamma * _g1k0 / gamma * _g1k0 * A_MULTIPLIER / A
    const mul1 = (((((PRECISION * D) / gamma) * _g1k0) / gamma) * _g1k0 * A_MULTIPLIER) / A;

    // mul2 = 2 * 10^18 * K0 / _g1k0
    const mul2 = (2n * PRECISION * K0) / _g1k0;

    // neg_fprime = (S + S * mul2 / 10^18) + mul1 / D * 2 - (10^18 + mul2) * 2
    const neg_fprime =
      S + (S * mul2) / PRECISION + (mul1 * N_COINS) / D - (PRECISION + mul2) * N_COINS;

    // D_plus = D * (neg_fprime + S) / neg_fprime
    const D_plus = (D * (neg_fprime + S)) / neg_fprime;

    // D_minus = D * D / neg_fprime / D
    const D_minus = (D * D) / neg_fprime;

    if (D_plus > D_minus) {
      D = D_plus - D_minus;
    } else {
      D = (D_minus - D_plus) / 2n;
    }

    const diff = D > D_prev ? D - D_prev : D_prev - D;
    if (diff * 10n ** 14n < D) {
      return D;
    }
  }

  return D;
}

/**
 * Calculate D invariant for 3-coin CryptoSwap using Newton's method
 *
 * @param A - Amplification parameter
 * @param gamma - Gamma parameter
 * @param xp - Scaled balances
 * @returns D invariant
 */
export function calcD3(A: bigint, gamma: bigint, xp: [bigint, bigint, bigint]): bigint {
  const N_COINS = 3n;
  const N_COINS_POW = 27n;

  const S = xp[0] + xp[1] + xp[2];
  if (S === 0n) return 0n;

  let D = S;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const D_prev = D;

    // K0 = 27 * prod(x) * 10^18 / D^3
    let K0 = (N_COINS_POW * PRECISION * xp[0]) / D;
    K0 = (K0 * xp[1]) / D;
    K0 = (K0 * xp[2]) / D;

    // _g1k0 = |gamma + 10^18 - K0| + 1
    let _g1k0 = gamma + PRECISION;
    if (_g1k0 > K0) {
      _g1k0 = _g1k0 - K0 + 1n;
    } else {
      _g1k0 = K0 - _g1k0 + 1n;
    }

    const mul1 = (((((PRECISION * D) / gamma) * _g1k0) / gamma) * _g1k0 * A_MULTIPLIER) / A;
    const mul2 = (2n * PRECISION * K0) / _g1k0;

    const neg_fprime =
      S + (S * mul2) / PRECISION + (mul1 * N_COINS) / D - (PRECISION + mul2) * N_COINS;

    const D_plus = (D * (neg_fprime + S)) / neg_fprime;
    const D_minus = (D * D) / neg_fprime;

    if (D_plus > D_minus) {
      D = D_plus - D_minus;
    } else {
      D = (D_minus - D_plus) / 2n;
    }

    const diff = D > D_prev ? D - D_prev : D_prev - D;
    if (diff * 10n ** 14n < D) {
      return D;
    }
  }

  return D;
}

// ============================================
// Liquidity Functions
// ============================================

/**
 * Calculate LP tokens received for depositing amounts (2-coin CryptoSwap)
 *
 * @param params - Pool parameters
 * @param amounts - Amount of each token to deposit
 * @param totalSupply - Current LP token total supply
 * @returns LP tokens to mint
 */
export function calcTokenAmount(
  params: TwocryptoParams,
  amounts: [bigint, bigint],
  totalSupply: bigint
): bigint {
  const precisions = params.precisions ?? [1n, 1n];

  // Calculate current scaled balances
  const xp: [bigint, bigint] = scaleBalances(
    params.balances,
    precisions,
    params.priceScale
  );

  const D0 = calcD(params.A, params.gamma, xp);

  // Calculate new scaled balances after deposit
  const newBalances: [bigint, bigint] = [
    params.balances[0] + amounts[0],
    params.balances[1] + amounts[1],
  ];
  const newXp: [bigint, bigint] = scaleBalances(newBalances, precisions, params.priceScale);

  const D1 = calcD(params.A, params.gamma, newXp);

  if (totalSupply === 0n) {
    return D1;
  }

  // Proportional mint based on D change
  const diff = D1 - D0;
  return (totalSupply * diff) / D0;
}

/**
 * Calculate LP tokens received for depositing amounts (3-coin CryptoSwap)
 *
 * @param params - Pool parameters
 * @param amounts - Amount of each token to deposit
 * @param totalSupply - Current LP token total supply
 * @returns LP tokens to mint
 */
export function calcTokenAmount3(
  params: TricryptoParams,
  amounts: [bigint, bigint, bigint],
  totalSupply: bigint
): bigint {
  const precisions = params.precisions ?? [1n, 1n, 1n];

  const xp = scaleBalances3(params.balances, precisions, params.priceScales);
  const D0 = calcD3(params.A, params.gamma, xp);

  const newBalances: [bigint, bigint, bigint] = [
    params.balances[0] + amounts[0],
    params.balances[1] + amounts[1],
    params.balances[2] + amounts[2],
  ];
  const newXp = scaleBalances3(newBalances, precisions, params.priceScales);

  const D1 = calcD3(params.A, params.gamma, newXp);

  if (totalSupply === 0n) {
    return D1;
  }

  const diff = D1 - D0;
  return (totalSupply * diff) / D0;
}

/**
 * Calculate tokens received for single-sided LP withdrawal (2-coin CryptoSwap)
 *
 * @param params - Pool parameters
 * @param tokenAmount - LP tokens to burn
 * @param i - Index of token to withdraw
 * @param totalSupply - Current LP token total supply
 * @returns Tokens received after fees
 */
export function calcWithdrawOneCoin(
  params: TwocryptoParams,
  tokenAmount: bigint,
  i: number,
  totalSupply: bigint
): bigint {
  const precisions = params.precisions ?? [1n, 1n];

  const xp = scaleBalances(params.balances, precisions, params.priceScale);
  const D0 = calcD(params.A, params.gamma, xp);

  // D1 = D0 * (1 - tokenAmount/totalSupply)
  const D1 = D0 - (tokenAmount * D0) / totalSupply;

  // Find new y[i] that satisfies invariant with D1
  const newY = newtonY(params.A, params.gamma, xp, D1, i);

  // dy in internal units
  let dy = xp[i] - newY;
  if (dy < 0n) return 0n;

  // Convert back to external units
  if (i === 0) {
    dy = dy / precisions[0];
  } else {
    dy = (dy * PRECISION) / (precisions[1] * params.priceScale);
  }

  // Apply fee
  const fee = dynamicFee(xp, params.feeGamma, params.midFee, params.outFee);
  dy = dy - (dy * fee) / FEE_DENOMINATOR;

  return dy;
}

/**
 * Calculate tokens received for single-sided LP withdrawal (3-coin CryptoSwap)
 *
 * @param params - Pool parameters
 * @param tokenAmount - LP tokens to burn
 * @param i - Index of token to withdraw
 * @param totalSupply - Current LP token total supply
 * @returns Tokens received after fees
 */
export function calcWithdrawOneCoin3(
  params: TricryptoParams,
  tokenAmount: bigint,
  i: number,
  totalSupply: bigint
): bigint {
  const precisions = params.precisions ?? [1n, 1n, 1n];

  const xp = scaleBalances3(params.balances, precisions, params.priceScales);
  const D0 = calcD3(params.A, params.gamma, xp);

  const D1 = D0 - (tokenAmount * D0) / totalSupply;

  const newY = newtonY3(params.A, params.gamma, xp, D1, i);

  let dy = xp[i] - newY;
  if (dy < 0n) return 0n;

  // Convert back to external units
  if (i === 0) {
    dy = dy / precisions[0];
  } else if (i === 1) {
    dy = (dy * PRECISION) / (precisions[1] * params.priceScales[0]);
  } else {
    dy = (dy * PRECISION) / (precisions[2] * params.priceScales[1]);
  }

  // Apply fee
  const fee = dynamicFee3(xp, params.feeGamma, params.midFee, params.outFee);
  dy = dy - (dy * fee) / FEE_DENOMINATOR;

  return dy;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Calculate min output with slippage tolerance
 */
export function calculateMinDy(expectedOutput: bigint, slippageBps: number): string {
  const minDy = (expectedOutput * BigInt(10000 - slippageBps)) / BigInt(10000);
  return minDy.toString();
}

/**
 * Calculate max input with slippage tolerance (for getDx)
 */
export function calculateMaxDx(expectedInput: bigint, slippageBps: number): string {
  const maxDx = (expectedInput * BigInt(10000 + slippageBps)) / BigInt(10000);
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
