/**
 * curve-amm-math
 *
 * Off-chain TypeScript implementations of Curve AMM math for gas-free calculations.
 * Supports StableSwap (2-8 coins) and CryptoSwap (2-3 coins) pool types.
 *
 * @example Basic StableSwap usage
 * ```typescript
 * import { stableswap } from 'curve-amm-math';
 *
 * const xp = [1000n * 10n**18n, 1100n * 10n**18n]; // Pool balances
 * const Ann = stableswap.computeAnn(100n, 2);      // A=100, 2 coins
 * const baseFee = 4000000n;                        // 0.04%
 * const feeMultiplier = 2n * 10n**10n;             // 2x multiplier
 *
 * // Get output for input (swap quote)
 * const dy = stableswap.getDy(0, 1, 10n * 10n**18n, xp, Ann, baseFee, feeMultiplier);
 *
 * // Get input needed for desired output (reverse quote)
 * const dx = stableswap.getDx(0, 1, 10n * 10n**18n, xp, Ann, baseFee, feeMultiplier);
 *
 * // Calculate LP tokens for deposit
 * const lpTokens = stableswap.calcTokenAmount([5n * 10n**18n, 5n * 10n**18n], true, xp, Ann, totalSupply, baseFee);
 *
 * // Calculate withdrawal amount
 * const [withdrawn, fee] = stableswap.calcWithdrawOneCoin(lpTokens, 0, xp, Ann, totalSupply, baseFee);
 * ```
 *
 * @example Basic CryptoSwap usage
 * ```typescript
 * import { cryptoswap } from 'curve-amm-math';
 *
 * const params: cryptoswap.CryptoSwapParams = {
 *   A: 400000n,
 *   gamma: 145000000000000n,
 *   D: 2000000000000000000000n,
 *   midFee: 3000000n,
 *   outFee: 30000000n,
 *   feeGamma: 230000000000000n,
 *   priceScale: 1000000000000000000n, // 1:1 for same-value tokens
 *   balances: [1000n * 10n**18n, 1000n * 10n**18n],
 *   precisions: [1n, 1n], // Both 18 decimals
 * };
 *
 * // Get output for input
 * const dy = cryptoswap.getDy(params, 0, 1, 10n * 10n**18n);
 *
 * // Get input needed for desired output
 * const dx = cryptoswap.getDx(params, 0, 1, 10n * 10n**18n);
 *
 * // Calculate LP tokens for deposit
 * const lpTokens = cryptoswap.calcTokenAmount(params, [5n * 10n**18n, 5n * 10n**18n], totalSupply);
 *
 * // Calculate withdrawal amount
 * const withdrawn = cryptoswap.calcWithdrawOneCoin(params, lpTokens, 0, totalSupply);
 * ```
 *
 * @packageDocumentation
 */

// StableSwap math (for pegged assets: stablecoins, liquid staking tokens, etc.)
export * as stableswap from "./stableswap";
export type { StableSwapPoolParams } from "./stableswap";

// CryptoSwap math (for volatile asset pairs)
// Supports both Twocrypto-NG (2 coins) and Tricrypto-NG (3 coins)
export * as cryptoswap from "./cryptoswap";
export type {
  CryptoSwapParams,
  TwocryptoParams,
  TricryptoParams,
} from "./cryptoswap";

// Re-export commonly used constants
export {
  A_PRECISION,
  FEE_DENOMINATOR as STABLESWAP_FEE_DENOMINATOR,
} from "./stableswap";

export {
  PRECISION,
  A_MULTIPLIER,
  FEE_DENOMINATOR as CRYPTOSWAP_FEE_DENOMINATOR,
} from "./cryptoswap";
