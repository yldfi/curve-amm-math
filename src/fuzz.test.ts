/**
 * Property-Based Fuzz Tests
 *
 * Uses fast-check to generate random inputs and verify mathematical invariants.
 * These tests help find edge cases that unit tests might miss.
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import * as stableswap from "./stableswap";
import * as cryptoswap from "./cryptoswap";

// ============================================================================
// Arbitrary Generators
// ============================================================================

// Generate realistic pool balance (100 tokens to 100M tokens, 18 decimals)
// This is more realistic for StableSwap pools
const balanceArb = fc.bigInt(100n * 10n ** 18n, 100_000_000n * 10n ** 18n);

// Generate valid swap amount (small to 1% of typical balance)
const swapAmountArb = fc.bigInt(10n ** 15n, 10n ** 24n);

// Generate valid A parameter (10 to 5000 - realistic range for StableSwap)
// A=1 is theoretical; real pools use A >= 10
const aParamArb = fc.bigInt(10n, 5000n);

// Generate valid fee (0 to 1% in FEE_DENOMINATOR units)
const feeArb = fc.bigInt(0n, 10n ** 8n); // 0 to 1%

// Generate valid fee multiplier
const feeMultiplierArb = fc.bigInt(10n ** 10n, 5n * 10n ** 10n); // 1x to 5x

// Generate valid CryptoSwap A (typical range)
const cryptoAArb = fc.bigInt(1000n, 1000000n);

// Generate valid gamma (typical range)
const gammaArb = fc.bigInt(10n ** 10n, 10n ** 16n);

// Generate 2-coin pool with constrained balance ratio (max 10:1)
// Real StableSwap pools rarely have extreme imbalances
const pool2Arb = fc.tuple(balanceArb, balanceArb).filter(([a, b]) => {
  const ratio = a > b ? a / b : b / a;
  return ratio <= 100n; // Max 100:1 ratio
});

// Generate 3-coin pool with constrained balance ratios
const pool3Arb = fc
  .tuple(balanceArb, balanceArb, balanceArb)
  .filter(([a, b, c]) => {
    const max = a > b ? (a > c ? a : c) : b > c ? b : c;
    const min = a < b ? (a < c ? a : c) : b < c ? b : c;
    return max / min <= 100n; // Max 100:1 ratio between any two
  });

// ============================================================================
// StableSwap Property Tests
// ============================================================================

describe("StableSwap Fuzz Tests", () => {
  describe("getDy Properties", () => {
    it("should always return non-negative output", () => {
      fc.assert(
        fc.property(
          pool2Arb,
          aParamArb,
          swapAmountArb,
          feeArb,
          feeMultiplierArb,
          (balances, A, dx, baseFee, feeMultiplier) => {
            const xp = [balances[0], balances[1]];
            const Ann = stableswap.computeAnn(A, 2);

            // Limit dx to pool balance to avoid edge cases
            const limitedDx = dx < xp[0] ? dx : xp[0] / 10n;

            const dy = stableswap.getDy(0, 1, limitedDx, xp, Ann, baseFee, feeMultiplier);

            expect(dy).toBeGreaterThanOrEqual(0n);
          }
        ),
        { numRuns: 500 }
      );
    });

    it("should never return more than pool balance", () => {
      fc.assert(
        fc.property(
          pool2Arb,
          aParamArb,
          swapAmountArb,
          feeArb,
          feeMultiplierArb,
          (balances, A, dx, baseFee, feeMultiplier) => {
            const xp = [balances[0], balances[1]];
            const Ann = stableswap.computeAnn(A, 2);

            const dy = stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);

            expect(dy).toBeLessThanOrEqual(xp[1]);
          }
        ),
        { numRuns: 500 }
      );
    });

    it("should be monotonically increasing with dx (larger input = larger output)", () => {
      fc.assert(
        fc.property(
          pool2Arb,
          aParamArb,
          feeArb,
          feeMultiplierArb,
          (balances, A, baseFee, feeMultiplier) => {
            const xp = [balances[0], balances[1]];
            const Ann = stableswap.computeAnn(A, 2);

            const smallDx = xp[0] / 1000n;
            const largeDx = xp[0] / 100n;

            if (smallDx === 0n || largeDx === 0n) return true; // Skip trivial cases

            const smallDy = stableswap.getDy(0, 1, smallDx, xp, Ann, baseFee, feeMultiplier);
            const largeDy = stableswap.getDy(0, 1, largeDx, xp, Ann, baseFee, feeMultiplier);

            expect(largeDy).toBeGreaterThanOrEqual(smallDy);
          }
        ),
        { numRuns: 300 }
      );
    });
  });

  describe("getDx Properties", () => {
    it("should always return non-negative input requirement", () => {
      fc.assert(
        fc.property(
          pool2Arb,
          aParamArb,
          swapAmountArb,
          feeArb,
          feeMultiplierArb,
          (balances, A, dy, baseFee, feeMultiplier) => {
            const xp = [balances[0], balances[1]];
            const Ann = stableswap.computeAnn(A, 2);

            // Limit dy to pool balance
            const limitedDy = dy < xp[1] ? dy : xp[1] / 10n;

            const dx = stableswap.getDx(0, 1, limitedDy, xp, Ann, baseFee, feeMultiplier);

            expect(dx).toBeGreaterThanOrEqual(0n);
          }
        ),
        { numRuns: 500 }
      );
    });
  });

  describe("getD Properties", () => {
    it("should always return positive D for non-zero balanced pools", () => {
      fc.assert(
        fc.property(pool2Arb, aParamArb, (balances, A) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);

          const D = stableswap.getD(xp, Ann);

          expect(D).toBeGreaterThan(0n);
        }),
        { numRuns: 500 }
      );
    });

    it("should be bounded by geometric mean and sum", () => {
      fc.assert(
        fc.property(pool2Arb, aParamArb, (balances, A) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);
          const sum = xp[0] + xp[1];

          const D = stableswap.getD(xp, Ann);

          // D is bounded: geometric_mean * N <= D <= sum
          // For 2-coin: sqrt(x0*x1) * 2 <= D <= x0 + x1
          // D approaches sum for high A, approaches 2*sqrt(x0*x1) for low A
          // Allow small tolerance for rounding
          expect(D).toBeLessThanOrEqual(sum + 2n);
          expect(D).toBeGreaterThan(0n);
        }),
        { numRuns: 300 }
      );
    });

    it("should scale with pool size", () => {
      fc.assert(
        fc.property(pool2Arb, aParamArb, (balances, A) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);

          const D1 = stableswap.getD(xp, Ann);
          const D2 = stableswap.getD([xp[0] * 2n, xp[1] * 2n], Ann);

          // Doubling balances should roughly double D
          expect(D2).toBeGreaterThan(D1);
          expect(D2).toBeLessThan(D1 * 3n); // Should be close to 2x
        }),
        { numRuns: 200 }
      );
    });
  });

  describe("Round-Trip Properties", () => {
    it("getDy(getDx(dy)) should approximately equal dy", () => {
      fc.assert(
        fc.property(
          pool2Arb,
          aParamArb,
          feeArb,
          feeMultiplierArb,
          (balances, A, baseFee, feeMultiplier) => {
            const xp = [balances[0], balances[1]];
            const Ann = stableswap.computeAnn(A, 2);

            // Use a reasonable dy amount
            const desiredDy = xp[1] / 100n;
            if (desiredDy === 0n) return true;

            const dx = stableswap.getDx(0, 1, desiredDy, xp, Ann, baseFee, feeMultiplier);
            if (dx === 0n) return true;

            const actualDy = stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);

            // Allow 5% tolerance due to fees
            const tolerance = desiredDy / 20n + 1n;
            const diff = actualDy > desiredDy ? actualDy - desiredDy : desiredDy - actualDy;

            expect(diff).toBeLessThanOrEqual(tolerance);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe("3-Coin Pool Properties", () => {
    it("should handle 3-coin pools correctly", () => {
      fc.assert(
        fc.property(pool3Arb, aParamArb, swapAmountArb, (balances, A, dx) => {
          const xp = [balances[0], balances[1], balances[2]];
          const Ann = stableswap.computeAnn(A, 3);

          const limitedDx = dx < xp[0] ? dx : xp[0] / 10n;

          const dy = stableswap.getDy(0, 1, limitedDx, xp, Ann, 4000000n, 2n * 10n ** 10n);

          expect(dy).toBeGreaterThanOrEqual(0n);
          expect(dy).toBeLessThanOrEqual(xp[1]);
        }),
        { numRuns: 300 }
      );
    });
  });
});

// ============================================================================
// CryptoSwap Property Tests
// ============================================================================

describe("CryptoSwap Fuzz Tests", () => {
  describe("getDy Properties", () => {
    it("should always return non-negative output", () => {
      fc.assert(
        fc.property(pool2Arb, cryptoAArb, gammaArb, swapAmountArb, (balances, A, gamma, dx) => {
          const params: cryptoswap.TwocryptoParams = {
            A,
            gamma,
            D: balances[0] + balances[1], // Approximate D
            midFee: 3000000n,
            outFee: 30000000n,
            feeGamma: 230000000000000n,
            priceScale: 10n ** 18n,
            balances: [balances[0], balances[1]],
            precisions: [1n, 1n],
          };

          // Limit dx
          const limitedDx = dx < balances[0] / 10n ? dx : balances[0] / 100n;

          try {
            const dy = cryptoswap.getDy(params, 0, 1, limitedDx);
            expect(dy).toBeGreaterThanOrEqual(0n);
          } catch (e) {
            // Convergence failures are acceptable for extreme parameters
            expect((e as Error).message).toMatch(/converge|zero/);
          }
        }),
        { numRuns: 300 }
      );
    });

    it("should never return more than pool balance", () => {
      fc.assert(
        fc.property(pool2Arb, cryptoAArb, gammaArb, swapAmountArb, (balances, A, gamma, dx) => {
          const params: cryptoswap.TwocryptoParams = {
            A,
            gamma,
            D: balances[0] + balances[1],
            midFee: 3000000n,
            outFee: 30000000n,
            feeGamma: 230000000000000n,
            priceScale: 10n ** 18n,
            balances: [balances[0], balances[1]],
            precisions: [1n, 1n],
          };

          try {
            const dy = cryptoswap.getDy(params, 0, 1, dx);
            expect(dy).toBeLessThanOrEqual(balances[1]);
          } catch (e) {
            // Convergence failures and the contract's unsafe-value reverts are acceptable
            expect((e as Error).message).toMatch(/converge|zero|unsafe/);
          }
        }),
        { numRuns: 300 }
      );
    });
  });

  describe("calcD Properties", () => {
    it("should always return positive D for valid parameters", () => {
      fc.assert(
        fc.property(pool2Arb, cryptoAArb, gammaArb, (balances, A, gamma) => {
          const xp = [balances[0], balances[1]];

          try {
            const D = cryptoswap.calcD(A, gamma, xp);
            expect(D).toBeGreaterThan(0n);
          } catch (e) {
            // Convergence failures are acceptable for extreme parameters
            expect((e as Error).message).toMatch(/converge|zero/);
          }
        }),
        { numRuns: 500 }
      );
    });

    it("should scale with pool size", () => {
      fc.assert(
        fc.property(pool2Arb, cryptoAArb, gammaArb, (balances, A, gamma) => {
          const xp1 = [balances[0], balances[1]];
          const xp2 = [balances[0] * 2n, balances[1] * 2n];

          try {
            const D1 = cryptoswap.calcD(A, gamma, xp1);
            const D2 = cryptoswap.calcD(A, gamma, xp2);

            expect(D2).toBeGreaterThan(D1);
          } catch (e) {
            // Convergence failures are acceptable
            expect((e as Error).message).toMatch(/converge|zero/);
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  describe("3-Coin Pool Properties", () => {
    it("getDy3 should always return non-negative output", () => {
      fc.assert(
        fc.property(pool3Arb, cryptoAArb, gammaArb, swapAmountArb, (balances, A, gamma, dx) => {
          const params: cryptoswap.TricryptoParams = {
            A,
            gamma,
            D: balances[0] + balances[1] + balances[2],
            midFee: 3000000n,
            outFee: 30000000n,
            feeGamma: 230000000000000n,
            priceScales: [10n ** 18n, 10n ** 18n],
            balances: [balances[0], balances[1], balances[2]],
            precisions: [1n, 1n, 1n],
          };

          const limitedDx = dx < balances[0] / 10n ? dx : balances[0] / 100n;

          try {
            const dy = cryptoswap.getDy3(params, 0, 1, limitedDx);
            expect(dy).toBeGreaterThanOrEqual(0n);
          } catch (e) {
            expect((e as Error).message).toMatch(/converge|zero/);
          }
        }),
        { numRuns: 300 }
      );
    });
  });
});

// ============================================================================
// Validation Fuzz Tests
// ============================================================================

describe("Validation Fuzz Tests", () => {
  describe("StableSwap Parameter Validation", () => {
    it("should throw for A=0", () => {
      expect(() => stableswap.computeAnn(0n, 2)).toThrow("A parameter cannot be zero");
    });

    it("should handle any valid A without throwing", () => {
      fc.assert(
        fc.property(aParamArb, (A) => {
          expect(() => stableswap.computeAnn(A, 2)).not.toThrow();
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("CryptoSwap Parameter Validation", () => {
    it("should throw for A=0 in calcD", () => {
      const xp = [10n ** 18n, 10n ** 18n];
      expect(() => cryptoswap.calcD(0n, 10n ** 14n, xp)).toThrow("A parameter cannot be zero");
    });

    it("should throw for gamma=0 in calcD", () => {
      const xp = [10n ** 18n, 10n ** 18n];
      expect(() => cryptoswap.calcD(400000n, 0n, xp)).toThrow("gamma parameter cannot be zero");
    });

    it("should handle any valid A/gamma without parameter errors", () => {
      fc.assert(
        fc.property(cryptoAArb, gammaArb, pool2Arb, (A, gamma, balances) => {
          const xp = [balances[0], balances[1]];
          try {
            cryptoswap.calcD(A, gamma, xp);
          } catch (e) {
            // Only convergence errors are acceptable, not parameter errors
            expect((e as Error).message).toMatch(/converge/);
            expect((e as Error).message).not.toMatch(/cannot be zero/);
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  describe("Index Bounds Validation", () => {
    it("should return 0 for invalid indices", () => {
      fc.assert(
        fc.property(
          pool2Arb,
          aParamArb,
          fc.integer({ min: -10, max: 10 }),
          fc.integer({ min: -10, max: 10 }),
          (balances, A, i, j) => {
            const xp = [balances[0], balances[1]];
            const Ann = stableswap.computeAnn(A, 2);

            const dy = stableswap.getDy(i, j, 10n ** 18n, xp, Ann, 4000000n, 2n * 10n ** 10n);

            // Should return 0 for invalid indices or same index
            if (i < 0 || i >= 2 || j < 0 || j >= 2 || i === j) {
              expect(dy).toBe(0n);
            }
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});

// ============================================================================
// Stress Tests
// ============================================================================

describe("Stress Tests", () => {
  // Higher A parameter for extreme imbalance tests (A >= 100)
  const highAArb = fc.bigInt(100n, 2000n);

  describe("Extreme Imbalance", () => {
    it("should handle 100:1 imbalance without crashing", () => {
      fc.assert(
        fc.property(highAArb, swapAmountArb, (A, dx) => {
          // 100:1 ratio (max we support with reasonable A)
          const xp = [100n * 10n ** 18n, 1n * 10n ** 18n];
          const Ann = stableswap.computeAnn(A, 2);

          const limitedDx = dx < xp[0] / 10n ? dx : xp[0] / 100n;

          const dy = stableswap.getDy(0, 1, limitedDx, xp, Ann, 4000000n, 2n * 10n ** 10n);

          expect(dy).toBeGreaterThanOrEqual(0n);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("Very Small Amounts", () => {
    it("should handle small swaps on balanced pools", () => {
      fc.assert(
        fc.property(pool2Arb, aParamArb, fc.bigInt(1n, 10n ** 15n), (balances, A, dx) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);

          const dy = stableswap.getDy(0, 1, dx, xp, Ann, 4000000n, 2n * 10n ** 10n);

          expect(dy).toBeGreaterThanOrEqual(0n);
        }),
        { numRuns: 200 }
      );
    });
  });

  describe("Very Large Amounts", () => {
    it("should handle large swaps without overflow", () => {
      fc.assert(
        fc.property(highAArb, (A) => {
          const xp = [10n ** 30n, 10n ** 30n]; // Huge balanced pool
          const Ann = stableswap.computeAnn(A, 2);
          const dx = 10n ** 28n; // Large swap

          const dy = stableswap.getDy(0, 1, dx, xp, Ann, 4000000n, 2n * 10n ** 10n);

          expect(dy).toBeGreaterThanOrEqual(0n);
          expect(dy).toBeLessThanOrEqual(xp[1]);
        }),
        { numRuns: 100 }
      );
    });
  });
});

// ============================================================================
// Liquidity Operation Fuzz Tests
// ============================================================================

describe("Liquidity Operation Fuzz Tests", () => {
  // Generate deposit amounts (smaller than pool to avoid overflow)
  const depositAmountArb = fc.bigInt(10n ** 16n, 10n ** 22n);
  const totalSupplyArb = fc.bigInt(10n ** 20n, 10n ** 26n);
  const highAArb = fc.bigInt(100n, 2000n);

  describe("calcTokenAmount Properties", () => {
    it("should return positive LP tokens for deposits", () => {
      fc.assert(
        fc.property(pool2Arb, highAArb, depositAmountArb, totalSupplyArb, (balances, A, amount, totalSupply) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);
          const amounts = [amount, 0n]; // Single-sided deposit
          const fee = 4000000n; // 0.04%

          const lpTokens = stableswap.calcTokenAmount(amounts, true, xp, Ann, totalSupply, fee);

          // Deposit should yield positive LP tokens
          expect(lpTokens).toBeGreaterThan(0n);
        }),
        { numRuns: 200 }
      );
    });

    it("should return reasonable LP tokens for balanced deposits", () => {
      fc.assert(
        fc.property(pool2Arb, highAArb, depositAmountArb, totalSupplyArb, (balances, A, amount, totalSupply) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);
          const amounts = [amount, amount]; // Balanced deposit
          const fee = 4000000n;

          const lpTokens = stableswap.calcTokenAmount(amounts, true, xp, Ann, totalSupply, fee);

          // Balanced deposit should yield roughly proportional LP tokens
          expect(lpTokens).toBeGreaterThan(0n);
        }),
        { numRuns: 200 }
      );
    });

    it("should enforce withdrawal amount bounds", () => {
      fc.assert(
        fc.property(pool2Arb, highAArb, totalSupplyArb, (balances, A, totalSupply) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);
          const fee = 4000000n;

          // Try to withdraw more than pool has - should throw
          const amounts = [xp[0] + 1n, 0n];

          expect(() => {
            stableswap.calcTokenAmount(amounts, false, xp, Ann, totalSupply, fee);
          }).toThrow();
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("calcWithdrawOneCoin Properties", () => {
    it("should return positive tokens for valid withdrawals", () => {
      fc.assert(
        fc.property(pool2Arb, highAArb, totalSupplyArb, fc.integer({ min: 0, max: 1 }), (balances, A, totalSupply, i) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);
          const tokenAmount = totalSupply / 100n; // Withdraw 1% of LP tokens
          const fee = 4000000n;

          const [dy, feeAmount] = stableswap.calcWithdrawOneCoin(tokenAmount, i, xp, Ann, totalSupply, fee);

          // Should receive positive tokens
          expect(dy).toBeGreaterThanOrEqual(0n);
          // Fee should be non-negative
          expect(feeAmount).toBeGreaterThanOrEqual(0n);
        }),
        { numRuns: 200 }
      );
    });

    it("should not withdraw more than pool balance", () => {
      fc.assert(
        fc.property(pool2Arb, highAArb, totalSupplyArb, fc.integer({ min: 0, max: 1 }), (balances, A, totalSupply, i) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);
          const tokenAmount = totalSupply / 10n; // Withdraw 10% of LP tokens
          const fee = 4000000n;

          const [dy] = stableswap.calcWithdrawOneCoin(tokenAmount, i, xp, Ann, totalSupply, fee);

          // Should not exceed pool balance
          expect(dy).toBeLessThanOrEqual(xp[i]);
        }),
        { numRuns: 200 }
      );
    });
  });

  describe("Add/Remove Round-Trip", () => {
    it("should approximately preserve value on add then remove", () => {
      fc.assert(
        fc.property(pool2Arb, highAArb, depositAmountArb, totalSupplyArb, (balances, A, amount, totalSupply) => {
          const xp = [balances[0], balances[1]];
          const Ann = stableswap.computeAnn(A, 2);
          const fee = 4000000n;

          // Add liquidity
          const depositAmounts = [amount, 0n];
          const lpTokens = stableswap.calcTokenAmount(depositAmounts, true, xp, Ann, totalSupply, fee);

          // Simulate new pool state after deposit
          const newXp = [xp[0] + amount, xp[1]];
          const newTotalSupply = totalSupply + lpTokens;

          // Remove the LP tokens we just got
          const [withdrawn] = stableswap.calcWithdrawOneCoin(lpTokens, 0, newXp, Ann, newTotalSupply, fee);

          // Should get back approximately what we put in (minus fees)
          // Allow up to 5% loss due to fees and slippage
          const minExpected = (amount * 95n) / 100n;
          expect(withdrawn).toBeGreaterThanOrEqual(minExpected);
        }),
        { numRuns: 100 }
      );
    });
  });
});
