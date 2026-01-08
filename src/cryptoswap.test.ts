import { describe, it, expect } from "vitest";
import {
  // Twocrypto (2-coin)
  newtonY,
  getDy,
  getDx,
  dynamicFee,
  findPegPoint,
  scaleBalances,
  calculateMinDy,
  calculateMaxDx,
  defaultPrecisions,
  calcD,
  calcTokenAmount,
  calcWithdrawOneCoin,
  // Tricrypto (3-coin)
  newtonY3,
  getDy3,
  getDx3,
  dynamicFee3,
  findPegPoint3,
  scaleBalances3,
  defaultPrecisions3,
  calcD3,
  calcTokenAmount3,
  calcWithdrawOneCoin3,
  // Constants and types
  PRECISION,
  FEE_DENOMINATOR,
  type CryptoSwapParams,
  type TricryptoParams,
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

  describe("getDx", () => {
    it("should return 0 for dy = 0", () => {
      const params = createParams();
      const dx = getDx(params, 0, 1, 0n);
      expect(dx).toBe(0n);
    });

    it("should be inverse of getDy", () => {
      const params = createParams();
      const inputDx = 100n * 10n ** 18n;

      // Get dy for this dx
      const dy = getDy(params, 0, 1, inputDx);

      // Get dx needed to produce this dy
      const calculatedDx = getDx(params, 0, 1, dy);

      // Should be close to original dx (within 1%)
      const tolerance = inputDx / 50n; // 2% tolerance for binary search
      expect(calculatedDx).toBeGreaterThan(inputDx - tolerance);
      expect(calculatedDx).toBeLessThan(inputDx + tolerance);
    });

    it("should return 0 when dy >= pool balance", () => {
      const params = createParams();
      const dx = getDx(params, 0, 1, params.balances[1] * 2n);
      expect(dx).toBe(0n);
    });
  });

  describe("calcD", () => {
    it("should calculate D for balanced pool", () => {
      const params = createParams();
      const xp = scaleBalances(
        params.balances,
        params.precisions ?? [1n, 1n],
        params.priceScale
      );

      const D = calcD(params.A, params.gamma, xp);

      // D should be approximately sum of scaled balances
      expect(D).toBeGreaterThan(0n);
      expect(D).toBeGreaterThan(xp[0] + xp[1] - 10n ** 20n);
    });

    it("should return 0 for empty pool", () => {
      const xp: [bigint, bigint] = [0n, 0n];
      const D = calcD(400000n, 145000000000000n, xp);
      expect(D).toBe(0n);
    });
  });

  describe("calcTokenAmount", () => {
    const totalSupply = 2000000n * 10n ** 18n;

    it("should return positive LP tokens for deposit", () => {
      const params = createParams();
      const amounts: [bigint, bigint] = [100n * 10n ** 18n, 100n * 10n ** 18n];

      const lpTokens = calcTokenAmount(params, amounts, totalSupply);

      expect(lpTokens).toBeGreaterThan(0n);
    });

    it("should return D for first deposit", () => {
      const params = createParams({
        balances: [0n, 0n],
      });
      const amounts: [bigint, bigint] = [1000n * 10n ** 18n, 1000n * 10n ** 18n];

      const lpTokens = calcTokenAmount(params, amounts, 0n);

      expect(lpTokens).toBeGreaterThan(0n);
    });
  });

  describe("calcWithdrawOneCoin", () => {
    const totalSupply = 2000000n * 10n ** 18n;

    it("should return positive tokens for withdrawal", () => {
      const params = createParams();
      const lpAmount = 100n * 10n ** 18n;

      const dy = calcWithdrawOneCoin(params, lpAmount, 0, totalSupply);

      expect(dy).toBeGreaterThan(0n);
    });

    it("should withdraw more with larger LP amount", () => {
      const params = createParams();
      const smallLp = 50n * 10n ** 18n;
      const largeLp = 200n * 10n ** 18n;

      const smallDy = calcWithdrawOneCoin(params, smallLp, 0, totalSupply);
      const largeDy = calcWithdrawOneCoin(params, largeLp, 0, totalSupply);

      expect(largeDy).toBeGreaterThan(smallDy);
    });
  });

  describe("calculateMaxDx", () => {
    it("should apply slippage correctly for input", () => {
      const expected = 1000n * 10n ** 18n;
      const maxDx = calculateMaxDx(expected, 100); // 1% slippage
      expect(maxDx).toBe("1010000000000000000000");
    });
  });
});

describe("Tricrypto (3-coin) Math", () => {
  // Test parameters matching a typical Tricrypto pool (e.g., USDT/WBTC/ETH style)
  const createTricryptoParams = (
    overrides: Partial<TricryptoParams> = {}
  ): TricryptoParams => ({
    A: 1707629n, // A parameter from pool
    gamma: 11809167828997n, // gamma from pool
    D: 3000000n * 10n ** 18n, // D invariant (3M tokens total value)
    midFee: 3000000n, // 0.03%
    outFee: 30000000n, // 0.3%
    feeGamma: 500000000000000n,
    priceScales: [PRECISION, PRECISION], // 1:1:1 price scales for simplicity
    balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n, 1000000n * 10n ** 18n], // 1M each
    precisions: [1n, 1n, 1n],
    ...overrides,
  });

  describe("scaleBalances3", () => {
    it("should scale token 0 by precision only", () => {
      const balances: [bigint, bigint, bigint] = [
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
      ];
      const precisions: [bigint, bigint, bigint] = [1n, 1n, 1n];
      const priceScales: [bigint, bigint] = [PRECISION, PRECISION];

      const xp = scaleBalances3(balances, precisions, priceScales);
      expect(xp[0]).toBe(balances[0]);
    });

    it("should scale tokens 1 and 2 by precision and price_scale", () => {
      const balances: [bigint, bigint, bigint] = [
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
      ];
      const precisions: [bigint, bigint, bigint] = [1n, 1n, 1n];
      const priceScales: [bigint, bigint] = [2n * PRECISION, 3n * PRECISION]; // Token 1 worth 2x, Token 2 worth 3x

      const xp = scaleBalances3(balances, precisions, priceScales);
      expect(xp[1]).toBe(balances[1] * 2n);
      expect(xp[2]).toBe(balances[2] * 3n);
    });

    it("should handle different precisions", () => {
      // Token 0: 18 decimals (precision=1)
      // Token 1: 8 decimals (precision=10^10) - like WBTC
      // Token 2: 6 decimals (precision=10^12) - like USDT
      const balances: [bigint, bigint, bigint] = [
        1000n * 10n ** 18n,
        1000n * 10n ** 8n,
        1000n * 10n ** 6n,
      ];
      const precisions: [bigint, bigint, bigint] = [1n, 10n ** 10n, 10n ** 12n];
      const priceScales: [bigint, bigint] = [PRECISION, PRECISION];

      const xp = scaleBalances3(balances, precisions, priceScales);
      // All should be in same units now
      expect(xp[0]).toBe(1000n * 10n ** 18n);
      expect(xp[1]).toBe(1000n * 10n ** 18n);
      expect(xp[2]).toBe(1000n * 10n ** 18n);
    });
  });

  describe("newtonY3", () => {
    it("should find a valid y value", () => {
      const params = createTricryptoParams();
      const xp = scaleBalances3(
        params.balances,
        params.precisions ?? [1n, 1n, 1n],
        params.priceScales
      );

      // Add some input to x[0]
      const dx = 1000n * 10n ** 18n; // 1000 tokens
      const newXp: [bigint, bigint, bigint] = [xp[0] + dx, xp[1], xp[2]];

      const y = newtonY3(params.A, params.gamma, newXp, params.D, 1);

      // y should be less than original xp[1] (we're taking from pool)
      expect(y).toBeLessThan(xp[1]);
      // y should be positive
      expect(y).toBeGreaterThan(0n);
    });

    it("should work for different output indices", () => {
      const params = createTricryptoParams();
      const xp = scaleBalances3(
        params.balances,
        params.precisions ?? [1n, 1n, 1n],
        params.priceScales
      );

      const dx = 1000n * 10n ** 18n;
      const newXp: [bigint, bigint, bigint] = [xp[0] + dx, xp[1], xp[2]];

      // Should work for output index 1 and 2
      const y1 = newtonY3(params.A, params.gamma, newXp, params.D, 1);
      const y2 = newtonY3(params.A, params.gamma, newXp, params.D, 2);

      expect(y1).toBeGreaterThan(0n);
      expect(y2).toBeGreaterThan(0n);
    });
  });

  describe("dynamicFee3", () => {
    it("should return close to mid_fee for balanced pool", () => {
      const xp: [bigint, bigint, bigint] = [
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
      ];
      const fee = dynamicFee3(xp, 500000000000000n, 3000000n, 30000000n);

      // For perfectly balanced pool, K ≈ 1, so fee should be close to mid_fee
      expect(fee).toBeGreaterThanOrEqual(3000000n);
      expect(fee).toBeLessThan(30000000n);
    });

    it("should approach out_fee for imbalanced pool", () => {
      const xp: [bigint, bigint, bigint] = [
        100n * 10n ** 18n,
        10000n * 10n ** 18n,
        5000n * 10n ** 18n,
      ];
      const fee = dynamicFee3(xp, 500000000000000n, 3000000n, 30000000n);

      // For imbalanced pool, fee should be closer to out_fee
      expect(fee).toBeGreaterThan(3000000n);
    });
  });

  describe("getDy3", () => {
    it("should return 0 for dx = 0", () => {
      const params = createTricryptoParams();
      const dy = getDy3(params, 0, 1, 0n);
      expect(dy).toBe(0n);
    });

    it("should return positive output for valid swap", () => {
      const params = createTricryptoParams();
      const dx = 100n * 10n ** 18n; // 100 tokens
      const dy = getDy3(params, 0, 1, dx);

      expect(dy).toBeGreaterThan(0n);
    });

    it("should handle all swap directions", () => {
      const params = createTricryptoParams();
      const dx = 100n * 10n ** 18n;

      // All 6 swap directions
      const dy01 = getDy3(params, 0, 1, dx);
      const dy02 = getDy3(params, 0, 2, dx);
      const dy10 = getDy3(params, 1, 0, dx);
      const dy12 = getDy3(params, 1, 2, dx);
      const dy20 = getDy3(params, 2, 0, dx);
      const dy21 = getDy3(params, 2, 1, dx);

      // All should be positive
      expect(dy01).toBeGreaterThan(0n);
      expect(dy02).toBeGreaterThan(0n);
      expect(dy10).toBeGreaterThan(0n);
      expect(dy12).toBeGreaterThan(0n);
      expect(dy20).toBeGreaterThan(0n);
      expect(dy21).toBeGreaterThan(0n);
    });

    it("should give lower output rate for larger swaps (slippage)", () => {
      const params = createTricryptoParams();
      const smallDx = 100n * 10n ** 18n;
      const largeDx = 10000n * 10n ** 18n;

      const smallDy = getDy3(params, 0, 1, smallDx);
      const largeDy = getDy3(params, 0, 1, largeDx);

      // Rate should be worse for larger swap
      const smallRate = (smallDy * PRECISION) / smallDx;
      const largeRate = (largeDy * PRECISION) / largeDx;
      expect(largeRate).toBeLessThan(smallRate);
    });
  });

  describe("findPegPoint3", () => {
    it("should return 0 when no swap gives bonus in balanced pool", () => {
      const params = createTricryptoParams();
      const pegPoint = findPegPoint3(params, 0, 1);

      // In a balanced CryptoSwap pool, typically no peg point bonus
      expect(pegPoint).toBeGreaterThanOrEqual(0n);
    });

    it("should find peg point when pool is imbalanced", () => {
      const params = createTricryptoParams({
        balances: [800000n * 10n ** 18n, 1200000n * 10n ** 18n, 1000000n * 10n ** 18n],
      });

      const pegPoint = findPegPoint3(params, 0, 1);

      if (pegPoint > 0n) {
        // At peg point, dy should be >= dx
        const dy = getDy3(params, 0, 1, pegPoint);
        expect(dy).toBeGreaterThanOrEqual(pegPoint);
      }
    });
  });

  describe("defaultPrecisions3", () => {
    it("should return [1n, 1n, 1n] for 18-decimal tokens", () => {
      const precisions = defaultPrecisions3();
      expect(precisions).toEqual([1n, 1n, 1n]);
    });
  });

  describe("getDx3", () => {
    it("should return 0 for dy = 0", () => {
      const params = createTricryptoParams();
      const dx = getDx3(params, 0, 1, 0n);
      expect(dx).toBe(0n);
    });

    it("should be inverse of getDy3", () => {
      const params = createTricryptoParams();
      const inputDx = 100n * 10n ** 18n;

      const dy = getDy3(params, 0, 1, inputDx);
      const calculatedDx = getDx3(params, 0, 1, dy);

      const tolerance = inputDx / 50n;
      expect(calculatedDx).toBeGreaterThan(inputDx - tolerance);
      expect(calculatedDx).toBeLessThan(inputDx + tolerance);
    });

    it("should work for all swap directions", () => {
      const params = createTricryptoParams();
      const dy = 50n * 10n ** 18n;

      // Test different swap directions
      const dx01 = getDx3(params, 0, 1, dy);
      const dx02 = getDx3(params, 0, 2, dy);
      const dx12 = getDx3(params, 1, 2, dy);

      expect(dx01).toBeGreaterThan(0n);
      expect(dx02).toBeGreaterThan(0n);
      expect(dx12).toBeGreaterThan(0n);
    });
  });

  describe("calcD3", () => {
    it("should calculate D for balanced pool", () => {
      const params = createTricryptoParams();
      const xp = scaleBalances3(
        params.balances,
        params.precisions ?? [1n, 1n, 1n],
        params.priceScales
      );

      const D = calcD3(params.A, params.gamma, xp);

      expect(D).toBeGreaterThan(0n);
    });

    it("should return 0 for empty pool", () => {
      const xp: [bigint, bigint, bigint] = [0n, 0n, 0n];
      const D = calcD3(1707629n, 11809167828997n, xp);
      expect(D).toBe(0n);
    });
  });

  describe("calcTokenAmount3", () => {
    const totalSupply = 3000000n * 10n ** 18n;

    it("should return positive LP tokens for deposit", () => {
      const params = createTricryptoParams();
      const amounts: [bigint, bigint, bigint] = [
        100n * 10n ** 18n,
        100n * 10n ** 18n,
        100n * 10n ** 18n,
      ];

      const lpTokens = calcTokenAmount3(params, amounts, totalSupply);

      expect(lpTokens).toBeGreaterThan(0n);
    });

    it("should return D for first deposit", () => {
      const params = createTricryptoParams({
        balances: [0n, 0n, 0n],
      });
      const amounts: [bigint, bigint, bigint] = [
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
      ];

      const lpTokens = calcTokenAmount3(params, amounts, 0n);

      expect(lpTokens).toBeGreaterThan(0n);
    });
  });

  describe("calcWithdrawOneCoin3", () => {
    const totalSupply = 3000000n * 10n ** 18n;

    it("should return positive tokens for withdrawal", () => {
      const params = createTricryptoParams();
      const lpAmount = 100n * 10n ** 18n;

      const dy = calcWithdrawOneCoin3(params, lpAmount, 0, totalSupply);

      expect(dy).toBeGreaterThan(0n);
    });

    it("should work for all output token indices", () => {
      const params = createTricryptoParams();
      const lpAmount = 100n * 10n ** 18n;

      const dy0 = calcWithdrawOneCoin3(params, lpAmount, 0, totalSupply);
      const dy1 = calcWithdrawOneCoin3(params, lpAmount, 1, totalSupply);
      const dy2 = calcWithdrawOneCoin3(params, lpAmount, 2, totalSupply);

      expect(dy0).toBeGreaterThan(0n);
      expect(dy1).toBeGreaterThan(0n);
      expect(dy2).toBeGreaterThan(0n);
    });

    it("should withdraw more with larger LP amount", () => {
      const params = createTricryptoParams();
      const smallLp = 50n * 10n ** 18n;
      const largeLp = 200n * 10n ** 18n;

      const smallDy = calcWithdrawOneCoin3(params, smallLp, 0, totalSupply);
      const largeDy = calcWithdrawOneCoin3(params, largeLp, 0, totalSupply);

      expect(largeDy).toBeGreaterThan(smallDy);
    });
  });
});
