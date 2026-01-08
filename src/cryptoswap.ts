/**
 * Curve CryptoSwap (v2) Math
 *
 * Off-chain implementation of Curve CryptoSwap formulas for gas-free calculations.
 * Currently supports 2-coin pools (Twocrypto-NG).
 *
 * Based on the CryptoSwap invariant with A and gamma parameters.
 * The dynamic peg mechanism uses price_scale to adjust for token price divergence.
 *
 * References:
 * - Curve v2 whitepaper: https://curve.fi/files/crypto-pools-paper.pdf
 * - Twocrypto-NG source: https://github.com/curvefi/twocrypto-ng
 */

// Precision constants matching Vyper source
export const PRECISION = 10n ** 18n;
export const A_MULTIPLIER = 10000n;
export const FEE_DENOMINATOR = 10n ** 10n;
export const MAX_ITERATIONS = 255;

/**
 * Pool parameters for CryptoSwap calculations (2-coin pools)
 */
export interface CryptoSwapParams {
  /** Amplification parameter (on-chain A, already scaled by A_MULTIPLIER) */
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
  /** Token precisions (10^(18-decimals) for each token) - default [1n, 1n] for 18-decimal */
  precisions?: [bigint, bigint];
}

const N_COINS = 2n;

/**
 * Newton's method to find y in CryptoSwap invariant
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

    // _g1k0 = gamma + 10^18
    // if _g1k0 > K0: _g1k0 = _g1k0 - K0 + 1
    // else: _g1k0 = K0 - _g1k0 + 1
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
      // If yfprime < _dyfprime, halve y and continue
      y = y_prev / 2n;
      continue;
    } else {
      yfprime = yfprime_base - _dyfprime;
    }

    // fprime = yfprime / y
    const fprime = yfprime / y;

    // y_minus = mul1 / fprime
    const y_minus_base = mul1 / fprime;

    // y_plus = (yfprime + 10^18 * D) / fprime + y_minus * 10^18 / K0
    const y_plus =
      (yfprime + PRECISION * D) / fprime + (y_minus_base * PRECISION) / K0;

    // y_minus += 10^18 * S / fprime
    const y_minus = y_minus_base + (PRECISION * S) / fprime;

    if (y_plus < y_minus) {
      y = y_prev / 2n;
    } else {
      y = y_plus - y_minus;
    }

    // Check convergence
    const diff = y > y_prev ? y - y_prev : y_prev - y;
    const threshold = y / (10n ** 14n);
    if (diff < (convergence_limit > threshold ? convergence_limit : threshold)) {
      return y;
    }
  }

  // Did not converge - return best guess
  return y;
}

/**
 * Calculate dynamic fee for CryptoSwap pool
 * Direct translation from Curve v2 Vyper source: _fee()
 *
 * f = fee_gamma / (fee_gamma + (1 - K))
 * where K = prod(x) / (sum(x) / N)^N
 *
 * When K is high (balanced pool), fee is closer to mid_fee
 * When K is low (imbalanced pool), fee is closer to out_fee
 */
export function dynamicFee(
  xp: [bigint, bigint],
  feeGamma: bigint,
  midFee: bigint,
  outFee: bigint
): bigint {
  // f = xp[0] + xp[1] (sum)
  const sum = xp[0] + xp[1];
  if (sum === 0n) return midFee;

  // K = (10^18 * N^N) * xp[0] / f * xp[1] / f
  // For N=2: K = 4 * 10^18 * xp[0] * xp[1] / sum^2
  // Note: must use same order of operations as Vyper to match exactly
  const K =
    ((PRECISION * N_COINS * N_COINS * xp[0]) / sum) * xp[1] / sum;

  // f = fee_gamma * 10^18 / (fee_gamma + 10^18 - K)
  const f = (feeGamma * PRECISION) / (feeGamma + PRECISION - K);

  // return (mid_fee * f + out_fee * (10^18 - f)) / 10^18
  return (midFee * f + outFee * (PRECISION - f)) / PRECISION;
}

/**
 * Off-chain implementation of CryptoSwap get_dy
 * Direct translation from Curve v2 Vyper source
 *
 * @param params Pool parameters
 * @param i Input token index (0 or 1)
 * @param j Output token index (0 or 1)
 * @param dx Input amount (in external units)
 * @returns Output amount after fees (in external units)
 */
export function getDy(
  params: CryptoSwapParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  if (dx === 0n) return 0n;

  const { A, gamma, D, midFee, outFee, feeGamma, priceScale, balances } = params;
  const precisions = params.precisions ?? [1n, 1n];

  // price_scale_internal = price_scale * precisions[1]
  const price_scale_internal = priceScale * precisions[1];

  // Start with unscaled balances
  const xp_unscaled: [bigint, bigint] = [balances[0], balances[1]];

  // Add dx to input token BEFORE scaling
  xp_unscaled[i] = xp_unscaled[i] + dx;

  // Scale to internal units
  // xp = [xp[0] * precisions[0], xp[1] * price_scale_internal / PRECISION]
  const xp: [bigint, bigint] = [
    xp_unscaled[0] * precisions[0],
    (xp_unscaled[1] * price_scale_internal) / PRECISION,
  ];

  // Newton's method to find new y
  const y = newtonY(A, gamma, xp, D, j);

  // dy = xp[j] - y - 1
  let dy = xp[j] - y - 1n;
  if (dy < 0n) return 0n;

  // Update xp[j] for fee calculation
  const xp_after: [bigint, bigint] = [xp[0], xp[1]];
  xp_after[j] = y;

  // Convert dy back to external units
  if (j > 0) {
    // dy = dy * PRECISION / price_scale_internal
    dy = (dy * PRECISION) / price_scale_internal;
  } else {
    // dy /= precisions[0]
    dy = dy / precisions[0];
  }

  // Apply dynamic fee
  const fee = dynamicFee(xp_after, feeGamma, midFee, outFee);
  dy = dy - (dy * fee) / FEE_DENOMINATOR;

  return dy;
}

/**
 * Find peg point using off-chain CryptoSwap math (binary search)
 * Returns the maximum amount where swap output >= input (rate >= 1:1)
 *
 * @param params Pool parameters
 * @param i Input token index
 * @param j Output token index
 * @param precision Search precision (default 10 tokens worth of wei)
 * @returns Maximum input amount that yields >= 1:1 output
 */
export function findPegPoint(
  params: CryptoSwapParams,
  i: number,
  j: number,
  precision: bigint = 10n * 10n ** 18n
): bigint {
  // Check if even 1 token gives bonus
  const minAmount = 10n ** 18n; // 1 token
  const dyForMin = getDy(params, i, j, minAmount);
  if (dyForMin < minAmount) {
    return 0n;
  }

  // Upper bound: use total pool TVL as reasonable max
  const maxSwap = params.balances[0] + params.balances[1];

  // Binary search for peg point
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
 * Calculate min output with slippage tolerance
 * @param expectedOutput - Expected output from getDy
 * @param slippageBps - Slippage in basis points (100 = 1%)
 * @returns min_dy value accounting for slippage
 */
export function calculateMinDy(expectedOutput: bigint, slippageBps: number): string {
  const minDy = (expectedOutput * BigInt(10000 - slippageBps)) / BigInt(10000);
  return minDy.toString();
}

/**
 * Create default precisions for 18-decimal tokens
 */
export function defaultPrecisions(): [bigint, bigint] {
  return [1n, 1n];
}

/**
 * Scale balances to internal units
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
