/**
 * Curve StableSwap Math
 *
 * Off-chain implementation of Curve StableSwap formulas for gas-free calculations.
 * Supports 2-8 coins (the range supported by StableSwapNG pools).
 *
 * Based on the StableSwap invariant: A*n^n*sum(x) + D = A*D*n^n + D^(n+1)/(n^n*prod(x))
 *
 * References:
 * - StableSwap whitepaper: https://curve.fi/files/stableswap-paper.pdf
 * - Algorithm explanation: https://www.rareskills.io/post/curve-get-d-get-y
 */

// Constants
export const A_PRECISION = 100n;
export const FEE_DENOMINATOR = 10n ** 10n;
export const MAX_ITERATIONS = 255;

/**
 * Calculate D (StableSwap invariant) using Newton's method
 * D satisfies: A*n^n*sum(x) + D = A*D*n^n + D^(n+1)/(n^n*prod(x))
 *
 * @param xp - Normalized pool balances (same decimals, in wei)
 * @param Ann - A * A_PRECISION * N_COINS (pre-computed)
 * @returns D invariant value
 */
export function getD(xp: bigint[], Ann: bigint): bigint {
  const N = BigInt(xp.length);
  const N_COINS_POW = N ** N; // n^n

  // Sum of balances
  let S = 0n;
  for (const x of xp) {
    S += x;
  }
  if (S === 0n) return 0n;

  let D = S;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // D_P = D^(n+1) / (n^n * prod(x))
    // Computed incrementally: D_P = D; for x in xp: D_P = D_P * D / x; D_P /= n^n
    let D_P = D;
    for (const x of xp) {
      D_P = (D_P * D) / x;
    }
    D_P = D_P / N_COINS_POW;

    const Dprev = D;

    // Newton iteration:
    // numerator = (Ann * S / A_PRECISION + D_P * N) * D
    // denominator = (Ann - A_PRECISION) * D / A_PRECISION + (N + 1) * D_P
    const numerator = ((Ann * S) / A_PRECISION + D_P * N) * D;
    const denominator = ((Ann - A_PRECISION) * D) / A_PRECISION + (N + 1n) * D_P;
    D = numerator / denominator;

    // Convergence check
    if (D > Dprev ? D - Dprev <= 1n : Dprev - D <= 1n) {
      break;
    }
  }

  return D;
}

/**
 * Calculate y given x values and D using Newton's method
 * Solves for y[j] given all other x values and the invariant D
 *
 * @param i - Input token index
 * @param j - Output token index
 * @param x - New value of x[i] after input
 * @param xp - Current pool balances
 * @param Ann - A * A_PRECISION * N_COINS
 * @param D - Invariant (from getD)
 * @returns New value of y[j]
 */
export function getY(
  i: number,
  j: number,
  x: bigint,
  xp: bigint[],
  Ann: bigint,
  D: bigint
): bigint {
  const N = BigInt(xp.length);

  // c = D^(n+1) / (n^n * prod(x_k for k != j) * Ann * n)
  // b = S' + D / (Ann * n) where S' = sum(x_k for k != j)
  let c = D;
  let S = 0n;

  for (let k = 0; k < xp.length; k++) {
    let _x: bigint;
    if (k === i) {
      _x = x;
    } else if (k !== j) {
      _x = xp[k];
    } else {
      continue;
    }
    S += _x;
    c = (c * D) / (_x * N);
  }

  c = (c * D * A_PRECISION) / (Ann * N);
  const b = S + (D * A_PRECISION) / Ann;

  // Newton iteration for y
  let y = D;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const prevY = y;
    // y = (y^2 + c) / (2y + b - D)
    y = (y * y + c) / (2n * y + b - D);

    if (y > prevY ? y - prevY <= 1n : prevY - y <= 1n) {
      break;
    }
  }

  return y;
}

/**
 * Calculate dynamic fee based on pool balance
 * Fee increases when pool is imbalanced (far from equal weights)
 *
 * @param xpi - Balance of input token (normalized)
 * @param xpj - Balance of output token (normalized)
 * @param baseFee - Base fee from pool
 * @param feeMultiplier - Off-peg fee multiplier
 * @returns Dynamic fee to apply
 */
export function dynamicFee(
  xpi: bigint,
  xpj: bigint,
  baseFee: bigint,
  feeMultiplier: bigint
): bigint {
  if (feeMultiplier <= FEE_DENOMINATOR) return baseFee;

  const xps2 = (xpi + xpj) ** 2n;
  return (
    (feeMultiplier * baseFee) /
    (((feeMultiplier - FEE_DENOMINATOR) * 4n * xpi * xpj) / xps2 + FEE_DENOMINATOR)
  );
}

/**
 * Calculate get_dy (output amount for input dx)
 * Exact match of CurveStableSwapNGViews.get_dy
 *
 * @param i - Input token index
 * @param j - Output token index
 * @param dx - Input amount (in token[i] decimals, normalized to 18)
 * @param xp - Pool balances (normalized to 18 decimals)
 * @param Ann - A * A_PRECISION * N_COINS
 * @param baseFee - Base fee from pool
 * @param feeMultiplier - Off-peg fee multiplier from pool
 * @returns Expected output amount after fees
 */
export function getDy(
  i: number,
  j: number,
  dx: bigint,
  xp: bigint[],
  Ann: bigint,
  baseFee: bigint,
  feeMultiplier: bigint
): bigint {
  // Calculate new x after input
  const newXp = [...xp];
  newXp[i] = xp[i] + dx;

  const D = getD(xp, Ann);
  const y = getY(i, j, newXp[i], xp, Ann, D);
  const dy = xp[j] - y - 1n; // -1 for rounding

  // Fee uses AVERAGE of pre and post xp values (matches Views contract)
  const fee = dynamicFee(
    (xp[i] + newXp[i]) / 2n,
    (xp[j] + y) / 2n,
    baseFee,
    feeMultiplier
  );
  const feeAmount = (dy * fee) / FEE_DENOMINATOR;

  return dy - feeAmount;
}

/**
 * Find the peg point using binary search on off-chain math
 * Returns max input amount where swap output >= input (rate >= 1:1)
 *
 * @param i - Input token index
 * @param j - Output token index
 * @param xp - Pool balances
 * @param Ann - A * A_PRECISION * N_COINS
 * @param fee - Base fee
 * @param feeMultiplier - Off-peg fee multiplier
 * @param precision - Search precision (default 10 tokens worth of wei)
 * @returns Maximum input amount that yields >= 1:1 output
 */
export function findPegPoint(
  i: number,
  j: number,
  xp: bigint[],
  Ann: bigint,
  fee: bigint,
  feeMultiplier: bigint,
  precision: bigint = 10n * 10n ** 18n
): bigint {
  // If input token balance >= output token balance, no swap gives bonus
  if (xp[i] >= xp[j]) {
    return 0n;
  }

  let low = 0n;
  let high = xp[j] - xp[i]; // imbalance as upper bound

  while (high - low > precision) {
    const mid = (low + high) / 2n;
    const dy = getDy(i, j, mid, xp, Ann, fee, feeMultiplier);
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
 * Validate slippage parameter
 * @param slippage - Slippage in basis points as string (100 = 1%)
 * @returns Validated slippage in basis points as number
 * @throws Error if slippage is invalid or out of range
 */
export function validateSlippage(slippage: string | undefined): number {
  const bps = parseInt(slippage ?? "100", 10); // Default 1%
  if (isNaN(bps) || bps < 10 || bps > 5000) {
    throw new Error(`Invalid slippage: ${slippage}. Must be 10-5000 bps (0.1%-50%)`);
  }
  return bps;
}

/**
 * Convert raw A value to Ann (A * A_PRECISION * N_COINS)
 * @param A - Amplification parameter
 * @param nCoins - Number of coins in pool
 * @param isAPrecise - Whether A is already multiplied by A_PRECISION
 */
export function computeAnn(A: bigint, nCoins: number, isAPrecise: boolean = false): bigint {
  const N = BigInt(nCoins);
  if (isAPrecise) {
    return A * N;
  }
  return A * A_PRECISION * N;
}

/**
 * Pool parameters needed for off-chain calculations
 */
export interface StableSwapPoolParams {
  balances: bigint[];
  A: bigint;
  Ann: bigint;
  fee: bigint;
  offpegFeeMultiplier: bigint;
  nCoins: number;
}
