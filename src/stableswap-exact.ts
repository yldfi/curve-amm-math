/**
 * Curve StableSwap Math - EXACT PRECISION
 *
 * This module provides exact precision matching with on-chain Curve contracts
 * by replicating the exact order of operations from Vyper.
 *
 * Supports all StableSwap pool types:
 * - Classic StableSwap (3pool, etc.)
 * - StableSwapNG factory pools
 * - Pools with oracle tokens (wstETH, cbETH, etc.)
 * - Pools with ERC4626 tokens (sDAI, etc.)
 * - Metapools
 */

import {
  A_PRECISION,
  FEE_DENOMINATOR,
  MAX_ITERATIONS,
  PRECISION,
} from "./constants";

// Re-export for convenience
export { A_PRECISION, FEE_DENOMINATOR, MAX_ITERATIONS, PRECISION };

/**
 * Asset types for StableSwapNG pools
 */
export enum AssetType {
  /** Standard ERC20 token */
  STANDARD = 0,
  /** Token with rate oracle (wstETH, cbETH, etc.) */
  ORACLE = 1,
  /** Rebasing token (stETH) - balances change, rate static */
  REBASING = 2,
  /** ERC4626 vault token (sDAI, etc.) */
  ERC4626 = 3,
}

/**
 * Pool parameters for exact precision calculations
 */
export interface ExactPoolParams {
  /** Raw balances in native token decimals */
  balances: bigint[];
  /** Rate multipliers (call stored_rates() or compute from decimals) */
  rates: bigint[];
  /** Amplification parameter (raw A from contract, NOT multiplied by A_PRECISION) */
  A: bigint;
  /** Base fee (1e10 precision) */
  fee: bigint;
  /** Off-peg fee multiplier (1e10 precision), 0 if not supported */
  offpegFeeMultiplier: bigint;
}

/**
 * Convert balances to xp (normalized to 18 decimals)
 * Matches Vyper: xp[i] = rates[i] * balances[i] / PRECISION
 * @throws Error if balances and rates have different lengths
 */
export function getXp(balances: bigint[], rates: bigint[]): bigint[] {
  if (balances.length !== rates.length) {
    throw new Error(
      `getXp: balances length (${balances.length}) must match rates length (${rates.length})`
    );
  }
  return balances.map((bal, i) => (rates[i] * bal) / PRECISION);
}

/**
 * Calculate D (StableSwap invariant) - EXACT Vyper match
 *
 * @param xp - Normalized pool balances (from getXp)
 * @param amp - A * A_PRECISION
 * @param nCoins - Number of coins
 * @throws Error if any balance is zero or convergence fails
 */
export function getD(xp: bigint[], amp: bigint, nCoins: number): bigint {
  // Validate nCoins
  if (nCoins < 2) {
    throw new Error(`getD: pool must have at least 2 coins (got ${nCoins})`);
  }
  if (xp.length !== nCoins) {
    throw new Error(`getD: xp.length (${xp.length}) must match nCoins (${nCoins})`);
  }

  const N = BigInt(nCoins);

  // Guard against amp = 0 (invalid pool parameter)
  if (amp === 0n) {
    throw new Error("getD: amp (A parameter) cannot be zero");
  }

  let S = 0n;
  for (const x of xp) {
    S += x;
  }
  if (S === 0n) return 0n;

  // Check for zero balances (would cause division by zero)
  for (const x of xp) {
    if (x === 0n) {
      throw new Error("getD: zero balance would cause division by zero");
    }
  }

  let Dprev = 0n;
  let D = S;
  const Ann = amp * N;

  for (let i = 0; i < 255; i++) {
    let D_P = D;
    for (const x of xp) {
      D_P = (D_P * D) / x;
    }
    // Vyper: D_P /= pow_mod256(N_COINS, N_COINS)
    D_P = D_P / (N ** N);

    Dprev = D;
    // Vyper exact formula:
    // D = ((Ann * S / A_PRECISION + D_P * N_COINS) * D) /
    //     (((Ann - A_PRECISION) * D) / A_PRECISION + (N_COINS + 1) * D_P)
    D =
      (((Ann * S) / A_PRECISION + D_P * N) * D) /
      (((Ann - A_PRECISION) * D) / A_PRECISION + (N + 1n) * D_P);

    // Convergence check: |D - Dprev| <= 1
    if (D > Dprev) {
      if (D - Dprev <= 1n) return D;
    } else {
      if (Dprev - D <= 1n) return D;
    }
  }

  throw new Error("get_D did not converge");
}

/**
 * Calculate y given x values and D - EXACT Vyper match
 *
 * @param i - Input token index
 * @param j - Output token index
 * @param x - New value of xp[i] after input
 * @param xp - Current normalized balances
 * @param amp - A * A_PRECISION
 * @param D - Invariant from getD
 * @param nCoins - Number of coins
 * @throws Error if i === j, indices out of bounds, or zero balance
 */
export function getY(
  i: number,
  j: number,
  x: bigint,
  xp: bigint[],
  amp: bigint,
  D: bigint,
  nCoins: number
): bigint {
  // Input validation
  if (nCoins < 2) {
    throw new Error(`getY: pool must have at least 2 coins (got ${nCoins})`);
  }
  if (xp.length !== nCoins) {
    throw new Error(`getY: xp.length (${xp.length}) must match nCoins (${nCoins})`);
  }
  if (i === j) {
    throw new Error("getY: i and j must be different");
  }
  if (i < 0 || i >= nCoins || j < 0 || j >= nCoins) {
    throw new Error(`getY: index out of bounds (i=${i}, j=${j}, nCoins=${nCoins})`);
  }
  // Guard against amp = 0 (would cause division by zero)
  if (amp === 0n) {
    throw new Error("getY: amp (A parameter) cannot be zero");
  }

  const N = BigInt(nCoins);
  const Ann = amp * N;

  let c = D;
  let S_ = 0n;

  for (let k = 0; k < nCoins; k++) {
    let _x: bigint;
    if (k === i) {
      _x = x;
    } else if (k !== j) {
      _x = xp[k];
    } else {
      continue;
    }
    // Zero balance protection
    if (_x === 0n) {
      throw new Error(`getY: zero balance at index ${k} would cause division by zero`);
    }
    S_ += _x;
    c = (c * D) / (_x * N);
  }

  c = (c * D * A_PRECISION) / (Ann * N);
  const b = S_ + (D * A_PRECISION) / Ann;

  let y = D;
  for (let iter = 0; iter < 255; iter++) {
    const y_prev = y;
    const denom = 2n * y + b - D;
    // Guard against zero or negative denominator
    if (denom <= 0n) {
      throw new Error("getY: denominator (2y + b - D) is non-positive");
    }
    y = (y * y + c) / denom;

    if (y > y_prev) {
      if (y - y_prev <= 1n) return y;
    } else {
      if (y_prev - y <= 1n) return y;
    }
  }

  throw new Error("get_y did not converge");
}

/**
 * Calculate y given D (for liquidity operations) - EXACT Vyper match
 *
 * @param amp - A * A_PRECISION
 * @param i - Token index to solve for
 * @param xp - Current normalized balances
 * @param D - Target D invariant
 * @param nCoins - Number of coins
 * @throws Error if index out of bounds or zero balance
 */
export function getYD(
  amp: bigint,
  i: number,
  xp: bigint[],
  D: bigint,
  nCoins: number
): bigint {
  // Input validation
  if (nCoins < 2) {
    throw new Error(`getYD: pool must have at least 2 coins (got ${nCoins})`);
  }
  if (xp.length !== nCoins) {
    throw new Error(`getYD: xp.length (${xp.length}) must match nCoins (${nCoins})`);
  }
  if (i < 0 || i >= nCoins) {
    throw new Error(`getYD: index out of bounds (i=${i}, nCoins=${nCoins})`);
  }
  // Guard against amp = 0 (would cause division by zero)
  if (amp === 0n) {
    throw new Error("getYD: amp (A parameter) cannot be zero");
  }

  const N = BigInt(nCoins);
  const Ann = amp * N;

  let c = D;
  let S_ = 0n;

  for (let k = 0; k < nCoins; k++) {
    if (k !== i) {
      // Zero balance protection
      if (xp[k] === 0n) {
        throw new Error(`getYD: zero balance at index ${k} would cause division by zero`);
      }
      S_ += xp[k];
      c = (c * D) / (xp[k] * N);
    }
  }

  c = (c * D * A_PRECISION) / (Ann * N);
  const b = S_ + (D * A_PRECISION) / Ann;

  let y = D;
  for (let iter = 0; iter < 255; iter++) {
    const y_prev = y;
    const denom = 2n * y + b - D;
    // Guard against zero or negative denominator
    if (denom <= 0n) {
      throw new Error("getYD: denominator (2y + b - D) is non-positive");
    }
    y = (y * y + c) / denom;

    if (y > y_prev) {
      if (y - y_prev <= 1n) return y;
    } else {
      if (y_prev - y <= 1n) return y;
    }
  }

  throw new Error("get_y_D did not converge");
}

/**
 * Calculate dynamic fee - EXACT Vyper match
 */
export function dynamicFee(
  xpi: bigint,
  xpj: bigint,
  fee: bigint,
  feeMultiplier: bigint
): bigint {
  if (feeMultiplier <= FEE_DENOMINATOR) {
    return fee;
  }

  const xps2 = (xpi + xpj) ** 2n;
  // Guard against zero sum (would cause division by zero)
  if (xps2 === 0n) return fee;

  return (
    (feeMultiplier * fee) /
    (((feeMultiplier - FEE_DENOMINATOR) * 4n * xpi * xpj) / xps2 +
      FEE_DENOMINATOR)
  );
}

/**
 * Calculate get_dy - EXACT Vyper match
 *
 * This function replicates the exact operation order from CurveStableSwapNGViews.get_dy
 *
 * @param i - Input token index
 * @param j - Output token index
 * @param dx - Input amount in NATIVE decimals
 * @param params - Pool parameters
 * @returns Output amount in NATIVE decimals (0n for invalid inputs)
 */
export function getDyExact(
  i: number,
  j: number,
  dx: bigint,
  params: ExactPoolParams
): bigint {
  const { balances, rates, A, fee, offpegFeeMultiplier } = params;
  const nCoins = balances.length;

  // Input validation - return 0n for invalid swaps
  if (i === j) return 0n;
  if (i < 0 || i >= nCoins || j < 0 || j >= nCoins) return 0n;
  if (dx === 0n) return 0n;
  // Guard against zero rates (would cause division by zero)
  if (rates[i] === 0n || rates[j] === 0n) return 0n;

  // Step 1: Convert balances to xp (18 decimals)
  // Vyper: xp[k] = rates[k] * balances[k] / PRECISION
  const xp = getXp(balances, rates);

  // Step 2: Calculate amp
  // Vyper: amp = A() * A_PRECISION
  const amp = A * A_PRECISION;

  // Step 3: Calculate D
  const D = getD(xp, amp, nCoins);

  // Step 4: Calculate new x after input
  // Vyper: x = xp[i] + (dx * rates[i] / PRECISION)
  const x = xp[i] + (dx * rates[i]) / PRECISION;

  // Step 5: Calculate y
  const y = getY(i, j, x, xp, amp, D, nCoins);

  // Step 6: Calculate dy (in xp terms, 18 decimals)
  // Vyper: dy = xp[j] - y - 1
  const dy = xp[j] - y - 1n;

  // Clamp negative outputs to 0
  if (dy <= 0n) return 0n;

  // Step 7: Calculate dynamic fee
  // Vyper: fee = _dynamic_fee((xp[i] + x) / 2, (xp[j] + y) / 2, base_fee, fee_multiplier) * dy / FEE_DENOMINATOR
  const dynFee = dynamicFee(
    (xp[i] + x) / 2n,
    (xp[j] + y) / 2n,
    fee,
    offpegFeeMultiplier
  );
  const feeAmount = (dynFee * dy) / FEE_DENOMINATOR;

  // Step 8: Convert back to native decimals
  // Vyper: return (dy - fee) * PRECISION / rates[j]
  const result = ((dy - feeAmount) * PRECISION) / rates[j];
  return result > 0n ? result : 0n;
}

/**
 * Calculate get_dx using binary search for accuracy with dynamic fees
 *
 * This uses binary search to find the exact input amount that produces
 * the desired output, properly accounting for dynamic fees calculated
 * on average balances.
 *
 * @param i - Input token index
 * @param j - Output token index
 * @param dy - Desired output amount in NATIVE decimals
 * @param params - Pool parameters
 * @returns Required input amount in NATIVE decimals (0n for invalid inputs)
 */
export function getDxExact(
  i: number,
  j: number,
  dy: bigint,
  params: ExactPoolParams
): bigint {
  const { balances, rates } = params;
  const nCoins = balances.length;

  // Input validation - return 0n for invalid swaps
  if (i === j) return 0n;
  if (i < 0 || i >= nCoins || j < 0 || j >= nCoins) return 0n;
  if (dy === 0n) return 0n;
  // Guard against zero rates (would cause division by zero)
  if (rates[i] === 0n || rates[j] === 0n) return 0n;

  // Use binary search to find dx that produces dy
  // Initial estimate: assume 1:1 swap with some buffer for fees
  const maxBalance = balances.reduce((a, b) => (a > b ? a : b), 0n);
  let low = 0n;
  let high = maxBalance * 10n;

  // Expand upper bound if needed
  for (let k = 0; k < 10; k++) {
    const dyAtHigh = getDyExact(i, j, high, params);
    if (dyAtHigh >= dy) break;
    high = high * 2n;
  }

  // Final check: if dy is not achievable even with high input, return 0n
  const dyAtFinalHigh = getDyExact(i, j, high, params);
  if (dyAtFinalHigh < dy) return 0n;

  // Binary search for the correct dx
  for (let k = 0; k < 256; k++) {
    const mid = (low + high) / 2n;
    if (mid === low) {
      // Converged - return high to ensure we get at least dy
      return high;
    }

    const dyMid = getDyExact(i, j, mid, params);
    if (dyMid < dy) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return high;
}

// ============================================================================
// Rate Computation Helpers
// ============================================================================

/**
 * Compute static rate multipliers from decimals (for standard ERC20 tokens)
 *
 * This is what classic pools use: rate_multiplier[i] = 10^(36 - decimals[i])
 *
 * For StableSwapNG pools, you should fetch stored_rates() from the contract
 * instead, as rates may be dynamic for oracle/ERC4626 tokens.
 * @throws Error if any decimal is < 0 or > 36 (would cause invalid exponent)
 */
export function computeRates(decimals: number[]): bigint[] {
  return decimals.map((d, i) => {
    if (d < 0) {
      throw new Error(
        `computeRates: decimals[${i}] = ${d} cannot be negative`
      );
    }
    if (d > 36) {
      throw new Error(
        `computeRates: decimals[${i}] = ${d} exceeds maximum of 36`
      );
    }
    return 10n ** BigInt(36 - d);
  });
}

/**
 * Compute precision multipliers (for normalizing to 18 decimals)
 * precision[i] = 10^(18 - decimals[i])
 *
 * Note: This is different from rates! Rates are 10^(36-d), precisions are 10^(18-d)
 * @throws Error if any decimal is > 18 (would require negative exponent)
 */
export function computePrecisions(decimals: number[]): bigint[] {
  return decimals.map((d, i) => {
    if (d > 18) {
      throw new Error(
        `computePrecisions: decimals[${i}] = ${d} exceeds maximum of 18`
      );
    }
    if (d < 0) {
      throw new Error(
        `computePrecisions: decimals[${i}] = ${d} cannot be negative`
      );
    }
    return 10n ** BigInt(18 - d);
  });
}

/**
 * Helper to create ExactPoolParams from common inputs
 *
 * @param balances - Raw balances in native token decimals
 * @param decimals - Token decimals array
 * @param A - Raw A parameter from contract (NOT multiplied by A_PRECISION)
 * @param fee - Fee in 1e10 precision
 * @param offpegFeeMultiplier - Off-peg fee multiplier (0 if not supported)
 */
export function createExactParams(
  balances: bigint[],
  decimals: number[],
  A: bigint,
  fee: bigint,
  offpegFeeMultiplier: bigint = 0n
): ExactPoolParams {
  if (balances.length !== decimals.length) {
    throw new Error(
      `createExactParams: balances.length (${balances.length}) must match decimals.length (${decimals.length})`
    );
  }
  if (balances.length < 2) {
    throw new Error(`createExactParams: pool must have at least 2 coins (got ${balances.length})`);
  }
  return {
    balances,
    rates: computeRates(decimals),
    A,
    fee,
    offpegFeeMultiplier,
  };
}

/**
 * Create ExactPoolParams with custom rates (for oracle/ERC4626 tokens)
 *
 * Use this when the pool has non-standard asset types. Fetch rates from
 * the pool's stored_rates() function.
 */
export function createExactParamsWithRates(
  balances: bigint[],
  rates: bigint[],
  A: bigint,
  fee: bigint,
  offpegFeeMultiplier: bigint = 0n
): ExactPoolParams {
  if (balances.length !== rates.length) {
    throw new Error(
      `createExactParamsWithRates: balances.length (${balances.length}) must match rates.length (${rates.length})`
    );
  }
  if (balances.length < 2) {
    throw new Error(`createExactParamsWithRates: pool must have at least 2 coins (got ${balances.length})`);
  }
  // Validate rates are non-zero
  for (let i = 0; i < rates.length; i++) {
    if (rates[i] === 0n) {
      throw new Error(`createExactParamsWithRates: rate at index ${i} cannot be zero`);
    }
  }
  return {
    balances,
    rates,
    A,
    fee,
    offpegFeeMultiplier,
  };
}

// ============================================================================
// Pool Type Reference
// ============================================================================

/**
 * Pool types and their rate handling:
 *
 * | Pool Type             | Rate Source              | Notes                           |
 * |-----------------------|--------------------------|---------------------------------|
 * | Classic (3pool)       | 10^(36 - decimals)       | Static, use computeRates()     |
 * | StableSwapNG          | stored_rates()           | May include oracle rates        |
 * | Oracle tokens         | rate_multiplier * oracle | wstETH, cbETH, etc.            |
 * | ERC4626 tokens        | convertToAssets()        | sDAI, etc.                     |
 * | Rebasing tokens       | Static rate              | Balances change instead        |
 * | Metapools             | [rate, virtualPrice]     | LP token uses base pool vPrice |
 *
 * For maximum accuracy, always fetch stored_rates() from StableSwapNG pools
 * rather than computing from decimals.
 */

// ============================================================================
// Liquidity (add / remove) - EXACT Vyper match
// ============================================================================

/**
 * StableSwap contract family, which decides the invariant loop and the fee
 * rules of the liquidity functions:
 *
 * | Variant    | Pools                                   | get_D loop                 | calc_token_amount | Imbalance fee       |
 * |------------|-----------------------------------------|----------------------------|-------------------|---------------------|
 * | `"legacy"` | 3pool, FRAXBP and other pre-factory     | `D_P * D / (x * N)`        | no fee            | static              |
 * | `"plain"`  | Factory plain pools (Vyper 0.3.x)       | `D_P * D / x`, `/ N^N`     | static fee        | static              |
 * | `"ng"`     | StableSwap-NG                           | `D_P * D / x`, `/ N^N`     | dynamic fee       | `offpeg_fee_multiplier` |
 * | `"aave"`   | aave, saave (aTokens, `offpeg_fee_multiplier`) | `D_P * D / (x * N)` | no fee            | dynamic (raw-balance `xs`) |
 *
 * Legacy pools without `A_precise()` (3pool) use `ampPrecision: 1n`.
 * Metapools are not covered.
 */
export type StableSwapVariant = "legacy" | "plain" | "ng" | "aave";

/**
 * Pool parameters for the exact liquidity functions
 */
export interface StableLiquidityParams extends ExactPoolParams {
  /** Contract family (see {@link StableSwapVariant}) */
  variant: StableSwapVariant;
  /** LP token totalSupply() */
  totalSupply: bigint;
  /**
   * The pool's A_PRECISION: 100 (default) for pools with `A_precise()`,
   * 1 for pools without it (3pool)
   */
  ampPrecision?: bigint;
  /**
   * The pool's `A_precise()` (or `A()` when ampPrecision is 1). Overrides
   * `A * ampPrecision`; pass it while A is ramping.
   */
  ampPrecise?: bigint;
  /** Admin share of fees (1e10 precision), default 5e9 (50%) */
  adminFee?: bigint;
  /**
   * `get_dy` rounding order for `"legacy"` pools: true scales dy to coin
   * units before charging the fee (3pool-era pools without `A_precise()`),
   * false charges the fee first. Defaults to `ampPrecision === 1n`.
   */
  feeAfterScaling?: boolean;
  /**
   * `get_dy` subtracts 1 wei from `xp[j] - y` (default true). The y, busd,
   * ETH/rETH and ETH/aETH pools do not: pass false for them.
   */
  getDySubtractOne?: boolean;
}

/** Result of an exact add_liquidity / remove_liquidity_imbalance */
export interface StableLiquidityResult {
  /** LP minted (add) or burned (remove_liquidity_imbalance) */
  lpAmount: bigint;
  /** Per-coin fees in native units (the AddLiquidity / RemoveLiquidityImbalance event `fees`) */
  fees: bigint[];
  /** Pool `balances()` after the call (admin share of the fees removed) */
  balances: bigint[];
  /** LP totalSupply after the call */
  totalSupply: bigint;
  /** Invariant after the call, fees deducted (D2) */
  D: bigint;
}

function liquidityAmp(params: StableLiquidityParams): [bigint, bigint] {
  const ampPrecision = params.ampPrecision ?? A_PRECISION;
  const amp = params.ampPrecise ?? params.A * ampPrecision;
  if (amp === 0n) {
    throw new Error("stableswapExact: amp (A parameter) cannot be zero");
  }
  return [amp, ampPrecision];
}

/**
 * Invariant D for any variant. `"legacy"` iterates `D_P = D_P * D / (x * N)`
 * per coin; `"plain"` and `"ng"` iterate `D_P = D_P * D / x` and divide by
 * N^N once (as {@link getD}). Both stop at |D - D_prev| <= 1.
 *
 * @param xp - Normalized balances
 * @param amp - A * ampPrecision
 * @param ampPrecision - The pool's A_PRECISION (100, or 1 for 3pool)
 */
export function getDVariant(
  xp: bigint[],
  amp: bigint,
  variant: StableSwapVariant,
  ampPrecision: bigint = A_PRECISION
): bigint {
  const N = BigInt(xp.length);
  if (xp.length < 2) {
    throw new Error(`getDVariant: pool must have at least 2 coins (got ${xp.length})`);
  }
  if (amp === 0n) {
    throw new Error("getDVariant: amp (A parameter) cannot be zero");
  }

  let S = 0n;
  for (const x of xp) {
    S += x;
  }
  if (S === 0n) return 0n;
  for (const x of xp) {
    if (x === 0n) {
      throw new Error("getDVariant: zero balance would cause division by zero");
    }
  }

  let D = S;
  const Ann = amp * N;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let D_P = D;
    if (variant === "legacy" || variant === "aave") {
      for (const x of xp) {
        D_P = (D_P * D) / (x * N);
      }
    } else {
      for (const x of xp) {
        D_P = (D_P * D) / x;
      }
      D_P = D_P / N ** N;
    }
    const Dprev = D;
    D =
      (((Ann * S) / ampPrecision + D_P * N) * D) /
      (((Ann - ampPrecision) * D) / ampPrecision + (N + 1n) * D_P);

    if (D > Dprev) {
      if (D - Dprev <= 1n) return D;
    } else {
      if (Dprev - D <= 1n) return D;
    }
  }

  throw new Error("get_D did not converge");
}

/**
 * get_y_D with an explicit A_PRECISION (Vyper `get_y_D` / `_get_y_D`, all
 * variants): x[i] such that the invariant equals D.
 */
export function getYDVariant(
  amp: bigint,
  i: number,
  xp: bigint[],
  D: bigint,
  ampPrecision: bigint = A_PRECISION
): bigint {
  const nCoins = xp.length;
  if (i < 0 || i >= nCoins) {
    throw new Error(`getYDVariant: index out of bounds (i=${i}, nCoins=${nCoins})`);
  }
  if (amp === 0n) {
    throw new Error("getYDVariant: amp (A parameter) cannot be zero");
  }

  const N = BigInt(nCoins);
  const Ann = amp * N;
  let c = D;
  let S_ = 0n;
  for (let k = 0; k < nCoins; k++) {
    if (k === i) continue;
    if (xp[k] === 0n) {
      throw new Error(`getYDVariant: zero balance at index ${k} would cause division by zero`);
    }
    S_ += xp[k];
    c = (c * D) / (xp[k] * N);
  }
  c = (c * D * ampPrecision) / (Ann * N);
  const b = S_ + (D * ampPrecision) / Ann;

  let y = D;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const y_prev = y;
    const denom = 2n * y + b - D;
    if (denom <= 0n) {
      throw new Error("getYDVariant: denominator (2y + b - D) is non-positive");
    }
    y = (y * y + c) / denom;
    if (y > y_prev) {
      if (y - y_prev <= 1n) return y;
    } else {
      if (y_prev - y <= 1n) return y;
    }
  }

  throw new Error("get_y_D did not converge");
}

/**
 * Per-coin imbalance fees shared by add_liquidity, remove_liquidity_imbalance
 * and the plain / NG calc_token_amount: `fee_i = fee' * |ideal_i - new_i|`
 * with `fee' = fee * N / (4 * (N - 1))`, made dynamic for NG pools.
 */
function imbalanceFees(
  params: StableLiquidityParams,
  oldBalances: bigint[],
  newBalances: bigint[],
  D0: bigint,
  D1: bigint
): bigint[] {
  const N = BigInt(oldBalances.length);
  const baseFee = (params.fee * N) / (4n * (N - 1n));
  const ys = (D0 + D1) / N;
  return oldBalances.map((old, i) => {
    const ideal = (D1 * old) / D0;
    const newBalance = newBalances[i];
    const difference = ideal > newBalance ? ideal - newBalance : newBalance - ideal;
    let fee = baseFee;
    if (params.variant === "ng") {
      const xs = (params.rates[i] * (old + newBalance)) / PRECISION;
      fee = dynamicFee(xs, ys, baseFee, params.offpegFeeMultiplier);
    } else if (params.variant === "aave") {
      // aave pools pass raw (unscaled) balances as xs
      fee = dynamicFee(old + newBalance, ys, baseFee, params.offpegFeeMultiplier);
    }
    return (fee * difference) / FEE_DENOMINATOR;
  });
}

function validateLiquidityAmounts(name: string, params: StableLiquidityParams, amounts: bigint[]): void {
  if (amounts.length !== params.balances.length) {
    throw new Error(
      `${name}: amounts length (${amounts.length}) must match balances length (${params.balances.length})`
    );
  }
  for (const a of amounts) {
    if (a < 0n) {
      throw new Error(`${name}: amounts cannot be negative`);
    }
  }
}

/**
 * Exact `calc_token_amount(amounts, is_deposit)` view, as each variant's
 * contract returns it:
 * - `"legacy"`: no fee (`(D1 - D0) * supply / D0`). Legacy `add_liquidity`
 *   does charge the imbalance fee: use {@link calcAddLiquidityExact} for the
 *   amount actually minted.
 * - `"plain"`: static imbalance fee, as `add_liquidity`.
 * - `"ng"`: dynamic imbalance fee (StableSwap-NG views contract), computed
 *   with `A * A_PRECISION` like the views (`ampPrecise` is ignored, so while A
 *   ramps the quote differs from the mint in {@link calcAddLiquidityExact}).
 *
 * For an empty pool (supply 0) the contract returns D1.
 */
export function calcTokenAmountExact(
  params: StableLiquidityParams,
  amounts: bigint[],
  isDeposit: boolean
): bigint {
  validateLiquidityAmounts("calcTokenAmountExact", params, amounts);
  let [amp, ampPrecision] = liquidityAmp(params);
  // The StableSwap-NG views contract uses A() * A_PRECISION, not A_precise():
  // the two differ while A ramps.
  if (params.variant === "ng") {
    ampPrecision = params.ampPrecision ?? A_PRECISION;
    amp = params.A * ampPrecision;
  }
  const { variant, rates, totalSupply } = params;
  const oldBalances = params.balances;

  const D0 = getDVariant(getXp(oldBalances, rates), amp, variant, ampPrecision);
  const newBalances = oldBalances.map((b, i) => {
    if (isDeposit) return b + amounts[i];
    if (amounts[i] > b) {
      throw new Error("calcTokenAmountExact: withdrawal exceeds pool balance");
    }
    return b - amounts[i];
  });
  const D1 = getDVariant(getXp(newBalances, rates), amp, variant, ampPrecision);

  let D2 = D1;
  if (variant === "plain" || variant === "ng") {
    if (totalSupply === 0n) return D1;
    const fees = imbalanceFees(params, oldBalances, newBalances, D0, D1);
    D2 = getDVariant(
      getXp(newBalances.map((b, i) => b - fees[i]), rates),
      amp,
      variant,
      ampPrecision
    );
  }

  if (D0 === 0n) {
    throw new Error("calcTokenAmountExact: pool invariant D is zero");
  }
  const diff = isDeposit ? D2 - D0 : D0 - D2;
  if (diff < 0n) return 0n;
  return (diff * totalSupply) / D0;
}

/**
 * LP minted by `add_liquidity(amounts)`, including the imbalance fee that
 * every variant's `add_liquidity` charges (legacy `calc_token_amount` omits
 * it). Exact translation of the state-changing function; also returns the
 * per-coin fees, the new pool balances and supply.
 *
 * The first deposit (supply 0) mints D1 and charges no fee.
 */
export function calcAddLiquidityExact(
  params: StableLiquidityParams,
  amounts: bigint[]
): StableLiquidityResult {
  validateLiquidityAmounts("calcAddLiquidityExact", params, amounts);
  const [amp, ampPrecision] = liquidityAmp(params);
  const { variant, rates, totalSupply } = params;
  const adminFee = params.adminFee ?? 5000000000n;
  const oldBalances = params.balances;

  const D0 = getDVariant(getXp(oldBalances, rates), amp, variant, ampPrecision);
  const newBalances = oldBalances.map((b, i) => b + amounts[i]);
  const D1 = getDVariant(getXp(newBalances, rates), amp, variant, ampPrecision);
  if (D1 <= D0) {
    throw new Error("calcAddLiquidityExact: D1 must exceed D0 (nothing deposited)");
  }

  if (totalSupply === 0n) {
    return {
      lpAmount: D1,
      fees: amounts.map(() => 0n),
      balances: newBalances,
      totalSupply: D1,
      D: D1,
    };
  }

  const fees = imbalanceFees(params, oldBalances, newBalances, D0, D1);
  const D2 = getDVariant(
    getXp(newBalances.map((b, i) => b - fees[i]), rates),
    amp,
    variant,
    ampPrecision
  );
  const lpAmount = (totalSupply * (D2 - D0)) / D0;
  return {
    lpAmount,
    fees,
    balances: newBalances.map((b, i) => b - (fees[i] * adminFee) / FEE_DENOMINATOR),
    totalSupply: totalSupply + lpAmount,
    D: D2,
  };
}

/**
 * LP burned by `remove_liquidity_imbalance(amounts)` (all variants),
 * including the contract's `+ 1` rounding against the withdrawer.
 */
export function calcRemoveLiquidityImbalanceExact(
  params: StableLiquidityParams,
  amounts: bigint[]
): StableLiquidityResult {
  validateLiquidityAmounts("calcRemoveLiquidityImbalanceExact", params, amounts);
  const [amp, ampPrecision] = liquidityAmp(params);
  const { variant, rates, totalSupply } = params;
  const adminFee = params.adminFee ?? 5000000000n;
  const oldBalances = params.balances;

  const D0 = getDVariant(getXp(oldBalances, rates), amp, variant, ampPrecision);
  const newBalances = oldBalances.map((b, i) => {
    if (amounts[i] > b) {
      throw new Error("calcRemoveLiquidityImbalanceExact: withdrawal exceeds pool balance");
    }
    return b - amounts[i];
  });
  const D1 = getDVariant(getXp(newBalances, rates), amp, variant, ampPrecision);
  const fees = imbalanceFees(params, oldBalances, newBalances, D0, D1);
  const D2 = getDVariant(
    getXp(newBalances.map((b, i) => b - fees[i]), rates),
    amp,
    variant,
    ampPrecision
  );
  const burned = ((D0 - D2) * totalSupply) / D0;
  if (burned === 0n) {
    throw new Error("calcRemoveLiquidityImbalanceExact: zero tokens burned");
  }
  const lpAmount = burned + 1n;
  return {
    lpAmount,
    fees,
    balances: newBalances.map((b, i) => b - (fees[i] * adminFee) / FEE_DENOMINATOR),
    totalSupply: totalSupply - lpAmount,
    D: D2,
  };
}

/**
 * Exact `calc_withdraw_one_coin(burn_amount, i)` (and the amount
 * `remove_liquidity_one_coin` pays). Returns `[dy, fee]` in coin i's native
 * units, `fee` being `dy_0 - dy` as the contract computes it.
 *
 * `"legacy"` / `"plain"` charge the static fee on every coin's expected
 * change; `"ng"` charges `_dynamic_fee(xavg, (D0 + D1) / (2N))`.
 */
export function calcWithdrawOneCoinExact(
  params: StableLiquidityParams,
  burnAmount: bigint,
  i: number
): [bigint, bigint] {
  const { variant, rates, totalSupply } = params;
  const nCoins = params.balances.length;
  if (i < 0 || i >= nCoins) {
    throw new Error(`calcWithdrawOneCoinExact: index out of bounds (i=${i}, nCoins=${nCoins})`);
  }
  if (totalSupply === 0n) {
    throw new Error("calcWithdrawOneCoinExact: totalSupply cannot be zero");
  }
  if (burnAmount > totalSupply) {
    throw new Error("calcWithdrawOneCoinExact: burnAmount exceeds totalSupply");
  }
  const [amp, ampPrecision] = liquidityAmp(params);
  const N = BigInt(nCoins);

  const xp = getXp(params.balances, rates);
  const D0 = getDVariant(xp, amp, variant, ampPrecision);
  const D1 = D0 - (burnAmount * D0) / totalSupply;
  const newY = getYDVariant(amp, i, xp, D1, ampPrecision);

  const baseFee = (params.fee * N) / (4n * (N - 1n));
  const ys = (D0 + D1) / (2n * N);
  const xpReduced = xp.map((xp_j, j) => {
    let dxExpected: bigint;
    let xavg: bigint;
    if (j === i) {
      dxExpected = (xp_j * D1) / D0 - newY;
      xavg = (xp_j + newY) / 2n;
    } else {
      dxExpected = xp_j - (xp_j * D1) / D0;
      xavg = xp_j;
    }
    const fee =
      variant === "ng" || variant === "aave"
        ? dynamicFee(xavg, ys, baseFee, params.offpegFeeMultiplier)
        : baseFee;
    return xp_j - (fee * dxExpected) / FEE_DENOMINATOR;
  });

  let dy = xpReduced[i] - getYDVariant(amp, i, xpReduced, D1, ampPrecision);
  if (dy <= 0n) return [0n, 0n];
  const dy0 = ((xp[i] - newY) * PRECISION) / rates[i];
  dy = ((dy - 1n) * PRECISION) / rates[i];
  return [dy, dy0 - dy];
}

/**
 * Coins paid by balanced `remove_liquidity(burn_amount)`:
 * `balances[i] * burn_amount / totalSupply` (all variants).
 */
export function calcRemoveLiquidityExact(
  params: StableLiquidityParams,
  burnAmount: bigint
): bigint[] {
  if (params.totalSupply === 0n) {
    throw new Error("calcRemoveLiquidityExact: totalSupply cannot be zero");
  }
  if (burnAmount > params.totalSupply) {
    throw new Error("calcRemoveLiquidityExact: burnAmount exceeds totalSupply");
  }
  return params.balances.map((b) => (b * burnAmount) / params.totalSupply);
}

/**
 * Exact `get_virtual_price()`: `D * 10^18 / totalSupply` (all variants).
 */
export function getVirtualPriceExact(params: StableLiquidityParams): bigint {
  if (params.totalSupply === 0n) {
    throw new Error("getVirtualPriceExact: totalSupply cannot be zero");
  }
  const [amp, ampPrecision] = liquidityAmp(params);
  const D = getDVariant(getXp(params.balances, params.rates), amp, params.variant, ampPrecision);
  return (D * PRECISION) / params.totalSupply;
}

/**
 * get_y with an explicit A_PRECISION (Vyper `get_y`, all variants): x[j]
 * such that the invariant stays D when x[i] = x.
 */
export function getYVariant(
  i: number,
  j: number,
  x: bigint,
  xp: bigint[],
  amp: bigint,
  D: bigint,
  ampPrecision: bigint = A_PRECISION
): bigint {
  const nCoins = xp.length;
  if (i === j) throw new Error("getYVariant: i and j must be different");
  if (i < 0 || j < 0 || i >= nCoins || j >= nCoins) {
    throw new Error(`getYVariant: index out of bounds (i=${i}, j=${j}, nCoins=${nCoins})`);
  }
  if (amp === 0n) throw new Error("getYVariant: amp (A parameter) cannot be zero");
  const N = BigInt(nCoins);
  const Ann = amp * N;
  let c = D;
  let S_ = 0n;
  for (let k = 0; k < nCoins; k++) {
    let _x: bigint;
    if (k === i) _x = x;
    else if (k !== j) _x = xp[k];
    else continue;
    if (_x === 0n) throw new Error(`getYVariant: zero balance at index ${k}`);
    S_ += _x;
    c = (c * D) / (_x * N);
  }
  c = (c * D * ampPrecision) / (Ann * N);
  const b = S_ + (D * ampPrecision) / Ann;
  let y = D;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const y_prev = y;
    const denom = 2n * y + b - D;
    if (denom <= 0n) throw new Error("getYVariant: denominator (2y + b - D) is non-positive");
    y = (y * y + c) / denom;
    if (y > y_prev ? y - y_prev <= 1n : y_prev - y <= 1n) return y;
  }
  throw new Error("get_y did not converge");
}

/**
 * Exact `get_dy(i, j, dx)` for any variant: `"legacy"` / `"plain"` charge
 * the static fee (see `feeAfterScaling` for the rounding order), `"ng"` and
 * `"aave"` the dynamic fee at the trade's average balances.
 */
export function getDyVariant(params: StableLiquidityParams, i: number, j: number, dx: bigint): bigint {
  const ampPrecision = params.ampPrecision ?? A_PRECISION;
  const amp = params.ampPrecise ?? params.A * ampPrecision;
  const { rates } = params;
  const xp = getXp(params.balances, rates);
  const D = getDVariant(xp, amp, params.variant, ampPrecision);
  const x = xp[i] + (dx * rates[i]) / PRECISION;
  const y = getYVariant(i, j, x, xp, amp, D, ampPrecision);
  if (params.variant === "aave") {
    // aave `_get_dy`: no `- 1`, scale first, dynamic fee at average balances
    const dyA = ((xp[j] - y) * PRECISION) / rates[j];
    const f = dynamicFee((xp[i] + x) / 2n, (xp[j] + y) / 2n, params.fee, params.offpegFeeMultiplier);
    return dyA - (f * dyA) / FEE_DENOMINATOR;
  }
  let dy = xp[j] - y - (params.getDySubtractOne === false ? 0n : 1n);
  if (dy < 0n) return 0n;
  if (params.variant === "ng") {
    const f =
      (dynamicFee((xp[i] + x) / 2n, (xp[j] + y) / 2n, params.fee, params.offpegFeeMultiplier) * dy) /
      FEE_DENOMINATOR;
    return ((dy - f) * PRECISION) / rates[j];
  }
  const feeAfterScaling = params.feeAfterScaling ?? ampPrecision === 1n;
  if (feeAfterScaling) {
    dy = (dy * PRECISION) / rates[j];
    return dy - (params.fee * dy) / FEE_DENOMINATOR;
  }
  return ((dy - (params.fee * dy) / FEE_DENOMINATOR) * PRECISION) / rates[j];
}

// ============================================================================
// Lending / rate-token pool rates
// ============================================================================

/**
 * Rate of a Compound-style token (cToken, cyToken) as the compound, usdt
 * and Iron Bank pools compute it in `_stored_rates`:
 * `precisionMul * (r + r * supplyRatePerBlock * (block - accrualBlockNumber) / 1e18)`
 * with `r = exchangeRateStored()`.
 */
export function compoundRate(
  exchangeRateStored: bigint,
  supplyRatePerBlock: bigint,
  accrualBlockNumber: bigint,
  blockNumber: bigint,
  precisionMul: bigint
): bigint {
  const elapsed = blockNumber > accrualBlockNumber ? blockNumber - accrualBlockNumber : 0n;
  const rate = exchangeRateStored + (exchangeRateStored * supplyRatePerBlock * elapsed) / PRECISION;
  return precisionMul * rate;
}

/**
 * Rate of a yearn v1 yToken as the y / busd / pax pools compute it:
 * `precisionMul * getPricePerFullShare()`.
 */
export function yearnRate(pricePerFullShare: bigint, precisionMul: bigint): bigint {
  return precisionMul * pricePerFullShare;
}

/**
 * Rate of ankr aETH in the ETH/aETH pool: `1e18 * 1e18 / aETH.ratio()`.
 */
export function ankrAethRate(ratio: bigint): bigint {
  if (ratio === 0n) throw new Error("ankrAethRate: ratio cannot be zero");
  return (PRECISION * PRECISION) / ratio;
}

/** Result of {@link calcExchangeExact} */
export interface StableExchangeResult {
  /** Amount of coin j sent to the trader */
  dy: bigint;
  /** Admin share of the fee, in coin j units */
  adminFee: bigint;
  /** Pool `balances()` after the swap */
  balances: bigint[];
}

/**
 * The state-changing `exchange(i, j, dx)`: the amount paid out (equal to
 * {@link getDyVariant}) and the pool's balances afterwards, with the admin
 * share of the fee removed from coin j (`admin_balances` in NG pools).
 * `"aave"` pools are not supported here.
 */
export function calcExchangeExact(
  params: StableLiquidityParams,
  i: number,
  j: number,
  dx: bigint
): StableExchangeResult {
  if (params.variant === "aave") {
    throw new Error("calcExchangeExact: aave pools are not supported");
  }
  const ampPrecision = params.ampPrecision ?? A_PRECISION;
  const amp = params.ampPrecise ?? params.A * ampPrecision;
  const adminFee = params.adminFee ?? 5000000000n;
  const { rates } = params;
  const xp = getXp(params.balances, rates);
  const D = getDVariant(xp, amp, params.variant, ampPrecision);
  const x = xp[i] + (dx * rates[i]) / PRECISION;
  const y = getYVariant(i, j, x, xp, amp, D, ampPrecision);
  const subtract = params.getDySubtractOne === false ? 0n : 1n;
  let dy = xp[j] - y - subtract;
  let admin: bigint;
  const feeAfterScaling =
    params.variant !== "ng" && (params.feeAfterScaling ?? ampPrecision === 1n);
  if (feeAfterScaling) {
    dy = (dy * PRECISION) / rates[j];
    const dyFee = (params.fee * dy) / FEE_DENOMINATOR;
    admin = (dyFee * adminFee) / FEE_DENOMINATOR;
    dy -= dyFee;
  } else {
    const feeRate =
      params.variant === "ng"
        ? dynamicFee((xp[i] + x) / 2n, (xp[j] + y) / 2n, params.fee, params.offpegFeeMultiplier)
        : params.fee;
    const dyFee = (dy * feeRate) / FEE_DENOMINATOR;
    admin = (((dyFee * adminFee) / FEE_DENOMINATOR) * PRECISION) / rates[j];
    dy = ((dy - dyFee) * PRECISION) / rates[j];
  }
  const balances = [...params.balances];
  balances[i] += dx;
  balances[j] -= dy + admin;
  return { dy, adminFee: admin, balances };
}
