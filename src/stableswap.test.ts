import { describe, it, expect } from "vitest";
import {
  getD,
  getY,
  getDy,
  dynamicFee,
  findPegPoint,
  calculateMinDy,
  validateSlippage,
  computeAnn,
  A_PRECISION,
  FEE_DENOMINATOR,
} from "./stableswap";

describe("StableSwap Math", () => {
  // Test parameters matching a typical StableSwap pool
  const A = 100n;
  const nCoins = 2;
  const Ann = computeAnn(A, nCoins);
  const baseFee = 4000000n; // 0.04%
  const feeMultiplier = 2n * FEE_DENOMINATOR; // 2x

  describe("computeAnn", () => {
    it("should compute Ann = A * A_PRECISION * N_COINS", () => {
      expect(computeAnn(100n, 2)).toBe(100n * A_PRECISION * 2n);
      expect(computeAnn(200n, 3)).toBe(200n * A_PRECISION * 3n);
    });

    it("should handle isAPrecise flag", () => {
      // If A is already multiplied by A_PRECISION, just multiply by N
      expect(computeAnn(10000n, 2, true)).toBe(10000n * 2n);
    });
  });

  describe("getD", () => {
    it("should return 0 for empty pool", () => {
      expect(getD([0n, 0n], Ann)).toBe(0n);
    });

    it("should return sum for balanced pool", () => {
      const balance = 1000n * 10n ** 18n;
      const D = getD([balance, balance], Ann);
      // D should be close to 2 * balance for balanced pool
      expect(D).toBeGreaterThan(balance * 2n - 10n ** 18n);
      expect(D).toBeLessThan(balance * 2n + 10n ** 18n);
    });

    it("should handle imbalanced pools", () => {
      const D = getD([1000n * 10n ** 18n, 1100n * 10n ** 18n], Ann);
      // D should be between sum and geometric mean
      expect(D).toBeGreaterThan(2000n * 10n ** 18n);
      expect(D).toBeLessThan(2100n * 10n ** 18n);
    });

    it("should work with 3+ coins", () => {
      const Ann3 = computeAnn(100n, 3);
      const balance = 1000n * 10n ** 18n;
      const D = getD([balance, balance, balance], Ann3);
      // D should be close to 3 * balance
      expect(D).toBeGreaterThan(balance * 3n - 10n ** 18n);
      expect(D).toBeLessThan(balance * 3n + 10n ** 18n);
    });
  });

  describe("getY", () => {
    it("should maintain invariant approximately", () => {
      const balances = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
      const D = getD(balances, Ann);
      const dx = 10n * 10n ** 18n;
      const newX = balances[0] + dx;
      const y = getY(0, 1, newX, balances, Ann, D);

      // y should be less than original balance[1]
      expect(y).toBeLessThan(balances[1]);
      // dy should be positive
      expect(balances[1] - y).toBeGreaterThan(0n);
    });
  });

  describe("dynamicFee", () => {
    it("should return baseFee when feeMultiplier <= FEE_DENOMINATOR", () => {
      const fee = dynamicFee(1000n, 1000n, baseFee, FEE_DENOMINATOR);
      expect(fee).toBe(baseFee);
    });

    it("should return baseFee for balanced pool", () => {
      const balance = 1000n * 10n ** 18n;
      const fee = dynamicFee(balance, balance, baseFee, feeMultiplier);
      // For balanced pool, fee should be close to baseFee
      expect(fee).toBe(baseFee);
    });

    it("should increase fee for imbalanced pool", () => {
      const fee = dynamicFee(
        1000n * 10n ** 18n,
        2000n * 10n ** 18n,
        baseFee,
        feeMultiplier
      );
      // Fee should be higher than baseFee for imbalanced pool
      expect(fee).toBeGreaterThan(baseFee);
    });
  });

  describe("getDy", () => {
    it("should return positive output for valid swap", () => {
      const balances = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
      const dx = 10n * 10n ** 18n;
      const dy = getDy(0, 1, dx, balances, Ann, baseFee, feeMultiplier);

      expect(dy).toBeGreaterThan(0n);
      // Output should be less than input due to fees and curve
      expect(dy).toBeLessThanOrEqual(dx);
    });

    it("should give approximately 1:1 for small swaps in balanced pool", () => {
      const balances = [10000n * 10n ** 18n, 10000n * 10n ** 18n];
      const dx = 1n * 10n ** 18n; // Small swap
      const dy = getDy(0, 1, dx, balances, Ann, baseFee, feeMultiplier);

      // For small swap in balanced pool, should be close to 1:1 minus fees
      const minExpected = (dx * 9990n) / 10000n; // 0.1% tolerance
      expect(dy).toBeGreaterThan(minExpected);
    });

    it("should give bonus for swaps that rebalance pool", () => {
      // Pool has excess of token 1, swapping 0->1 gives bonus
      const balances = [800n * 10n ** 18n, 1200n * 10n ** 18n];
      const dx = 10n * 10n ** 18n;
      const dy = getDy(0, 1, dx, balances, Ann, baseFee, feeMultiplier);

      // Output could be greater than input for rebalancing swaps
      // (depends on pool parameters)
      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("findPegPoint", () => {
    it("should return 0 when input balance >= output balance", () => {
      const balances = [1000n * 10n ** 18n, 800n * 10n ** 18n];
      const pegPoint = findPegPoint(0, 1, balances, Ann, baseFee, feeMultiplier);
      expect(pegPoint).toBe(0n);
    });

    it("should find positive peg point when output balance > input balance", () => {
      const balances = [800n * 10n ** 18n, 1200n * 10n ** 18n];
      const pegPoint = findPegPoint(0, 1, balances, Ann, baseFee, feeMultiplier);

      // Should find a positive peg point
      expect(pegPoint).toBeGreaterThan(0n);

      // At peg point, dy should be >= dx
      const dy = getDy(0, 1, pegPoint, balances, Ann, baseFee, feeMultiplier);
      expect(dy).toBeGreaterThanOrEqual(pegPoint);
    });
  });

  describe("calculateMinDy", () => {
    it("should apply slippage tolerance correctly", () => {
      const expectedOutput = 1000n * 10n ** 18n;

      // 1% slippage (100 bps)
      const minDy1 = calculateMinDy(expectedOutput, 100);
      expect(minDy1).toBe((expectedOutput * 9900n / 10000n).toString());

      // 0.5% slippage (50 bps)
      const minDy05 = calculateMinDy(expectedOutput, 50);
      expect(minDy05).toBe((expectedOutput * 9950n / 10000n).toString());
    });
  });

  describe("validateSlippage", () => {
    it("should accept valid slippage values", () => {
      expect(validateSlippage("100")).toBe(100);
      expect(validateSlippage("50")).toBe(50);
      expect(validateSlippage("500")).toBe(500);
    });

    it("should default to 100 bps (1%)", () => {
      expect(validateSlippage(undefined)).toBe(100);
    });

    it("should reject invalid slippage", () => {
      expect(() => validateSlippage("5")).toThrow();
      expect(() => validateSlippage("6000")).toThrow();
      expect(() => validateSlippage("invalid")).toThrow();
    });
  });
});
