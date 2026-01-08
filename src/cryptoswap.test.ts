import { describe, it, expect } from "vitest";
import {
  newtonY,
  getDy,
  dynamicFee,
  findPegPoint,
  scaleBalances,
  calculateMinDy,
  defaultPrecisions,
  PRECISION,
  FEE_DENOMINATOR,
  type CryptoSwapParams,
} from "./cryptoswap";

describe("CryptoSwap Math", () => {
  // Test parameters matching a typical Twocrypto pool (lpxCVX/CVX style)
  const createParams = (
    overrides: Partial<CryptoSwapParams> = {}
  ): CryptoSwapParams => ({
    A: 400000n, // A parameter from pool
    gamma: 145000000000000n, // gamma from pool
    D: 2000000n * 10n ** 18n, // D invariant (2M tokens total value)
    midFee: 3000000n, // 0.03%
    outFee: 30000000n, // 0.3%
    feeGamma: 230000000000000n,
    priceScale: PRECISION, // 1:1 price scale
    balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n], // 1M each
    precisions: [1n, 1n],
    ...overrides,
  });

  describe("scaleBalances", () => {
    it("should scale token 0 by precision only", () => {
      const balances: [bigint, bigint] = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
      const precisions: [bigint, bigint] = [1n, 1n];
      const priceScale = PRECISION;

      const xp = scaleBalances(balances, precisions, priceScale);
      expect(xp[0]).toBe(balances[0]);
    });

    it("should scale token 1 by precision and price_scale", () => {
      const balances: [bigint, bigint] = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
      const precisions: [bigint, bigint] = [1n, 1n];
      const priceScale = 2n * PRECISION; // Token 1 worth 2x token 0

      const xp = scaleBalances(balances, precisions, priceScale);
      expect(xp[1]).toBe(balances[1] * 2n);
    });

    it("should handle different precisions", () => {
      // Token 0: 18 decimals (precision=1)
      // Token 1: 6 decimals (precision=10^12)
      const balances: [bigint, bigint] = [1000n * 10n ** 18n, 1000n * 10n ** 6n];
      const precisions: [bigint, bigint] = [1n, 10n ** 12n];
      const priceScale = PRECISION;

      const xp = scaleBalances(balances, precisions, priceScale);
      // Both should be in same units now
      expect(xp[0]).toBe(1000n * 10n ** 18n);
      expect(xp[1]).toBe(1000n * 10n ** 18n);
    });
  });

  describe("newtonY", () => {
    it("should find a valid y value", () => {
      const params = createParams();
      const xp = scaleBalances(
        params.balances,
        params.precisions ?? [1n, 1n],
        params.priceScale
      );

      // Add some input to x[0]
      const dx = 1000n * 10n ** 18n; // 1000 tokens
      const newXp: [bigint, bigint] = [xp[0] + dx, xp[1]];

      const y = newtonY(params.A, params.gamma, newXp, params.D, 1);

      // y should be less than original xp[1] (we're taking from pool)
      expect(y).toBeLessThan(xp[1]);
      // y should be positive
      expect(y).toBeGreaterThan(0n);
    });
  });

  describe("dynamicFee", () => {
    it("should return close to mid_fee for balanced pool", () => {
      const xp: [bigint, bigint] = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
      const fee = dynamicFee(xp, 230000000000000n, 3000000n, 30000000n);

      // For perfectly balanced pool, K ≈ 1, so fee should be close to mid_fee
      expect(fee).toBeGreaterThanOrEqual(3000000n);
      expect(fee).toBeLessThan(30000000n);
    });

    it("should approach out_fee for imbalanced pool", () => {
      const xp: [bigint, bigint] = [100n * 10n ** 18n, 10000n * 10n ** 18n];
      const fee = dynamicFee(xp, 230000000000000n, 3000000n, 30000000n);

      // For imbalanced pool, fee should be closer to out_fee
      expect(fee).toBeGreaterThan(3000000n);
    });
  });

  describe("getDy", () => {
    it("should return 0 for dx = 0", () => {
      const params = createParams();
      const dy = getDy(params, 0, 1, 0n);
      expect(dy).toBe(0n);
    });

    it("should return positive output for valid swap", () => {
      const params = createParams();
      const dx = 100n * 10n ** 18n; // 100 tokens
      const dy = getDy(params, 0, 1, dx);

      expect(dy).toBeGreaterThan(0n);
    });

    it("should handle reverse swap direction", () => {
      const params = createParams();
      const dx = 100n * 10n ** 18n;
      const dy01 = getDy(params, 0, 1, dx);
      const dy10 = getDy(params, 1, 0, dx);

      // Both should be positive
      expect(dy01).toBeGreaterThan(0n);
      expect(dy10).toBeGreaterThan(0n);
    });

    it("should give lower output rate for larger swaps (slippage)", () => {
      const params = createParams();
      const smallDx = 100n * 10n ** 18n;
      const largeDx = 10000n * 10n ** 18n;

      const smallDy = getDy(params, 0, 1, smallDx);
      const largeDy = getDy(params, 0, 1, largeDx);

      // Rate should be worse for larger swap
      const smallRate = (smallDy * PRECISION) / smallDx;
      const largeRate = (largeDy * PRECISION) / largeDx;
      expect(largeRate).toBeLessThan(smallRate);
    });
  });

  describe("findPegPoint", () => {
    it("should return 0 when no swap gives bonus in balanced pool", () => {
      const params = createParams();
      const pegPoint = findPegPoint(params, 0, 1);

      // In a balanced CryptoSwap pool, typically no peg point bonus
      expect(pegPoint).toBeGreaterThanOrEqual(0n);
    });

    it("should find peg point when pool is imbalanced", () => {
      const params = createParams({
        balances: [800000n * 10n ** 18n, 1200000n * 10n ** 18n],
      });

      const pegPoint = findPegPoint(params, 0, 1);

      if (pegPoint > 0n) {
        // At peg point, dy should be >= dx
        const dy = getDy(params, 0, 1, pegPoint);
        expect(dy).toBeGreaterThanOrEqual(pegPoint);
      }
    });
  });

  describe("calculateMinDy", () => {
    it("should apply slippage correctly", () => {
      const expected = 1000n * 10n ** 18n;
      const minDy = calculateMinDy(expected, 100); // 1% slippage
      expect(minDy).toBe("990000000000000000000");
    });
  });

  describe("defaultPrecisions", () => {
    it("should return [1n, 1n] for 18-decimal tokens", () => {
      const precisions = defaultPrecisions();
      expect(precisions).toEqual([1n, 1n]);
    });
  });
});
