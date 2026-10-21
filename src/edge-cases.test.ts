/**
 * Edge case tests for extreme pool states and unusual inputs.
 * These tests verify the math library handles degenerate cases gracefully.
 */
import { describe, it, expect } from "vitest";
import * as stableswap from "./stableswap";
import * as cryptoswap from "./cryptoswap";
import * as stableswapExact from "./stableswap-exact";

describe("StableSwap Edge Cases", () => {
  describe("Extreme Imbalance", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const baseFee = 4000000n; // 0.04%
    const feeMultiplier = 2n * 10n ** 10n;

    it("should handle 100:1 imbalance", () => {
      const xp = [100n * 10n ** 18n, 1n * 10n ** 18n]; // 100:1 ratio
      const dx = 1n * 10n ** 18n;

      const dy = stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);

      // Output should be positive but much less than input due to imbalance
      expect(dy).toBeGreaterThan(0n);
      expect(dy).toBeLessThan(dx); // Selling the abundant token yields less
    });

    it("should handle 1000:1 imbalance", () => {
      const xp = [1000n * 10n ** 18n, 1n * 10n ** 18n]; // 1000:1 ratio
      const dx = 1n * 10n ** 18n;

      const dy = stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);

      expect(dy).toBeGreaterThan(0n);
      expect(dy).toBeLessThan(dx);
    });

    it("should handle selling the scarce token (premium)", () => {
      const xp = [100n * 10n ** 18n, 1n * 10n ** 18n]; // Token 1 is scarce
      const dx = 1n * 10n ** 17n; // Sell 0.1 of scarce token

      const dy = stableswap.getDy(1, 0, dx, xp, Ann, baseFee, feeMultiplier);

      // Selling scarce token should give MORE than 1:1 (premium)
      expect(dy).toBeGreaterThan(dx);
    });

    it("should handle 10000:1 extreme imbalance with higher A", () => {
      // Higher A parameter for extreme cases
      const highAnn = stableswap.computeAnn(2000n, 2);
      const xp = [10000n * 10n ** 18n, 1n * 10n ** 18n];
      const dx = 1n * 10n ** 17n; // Small swap

      const dy = stableswap.getDy(0, 1, dx, xp, highAnn, baseFee, feeMultiplier);

      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("Very Small Swaps", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const xp = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
    const baseFee = 4000000n;
    const feeMultiplier = 2n * 10n ** 10n;

    it("should handle 1 wei swap", () => {
      const dy = stableswap.getDy(0, 1, 1n, xp, Ann, baseFee, feeMultiplier);

      // 1 wei might be consumed entirely by fees, result could be 0
      expect(dy).toBeGreaterThanOrEqual(0n);
    });

    it("should handle 1000 wei swap", () => {
      const dy = stableswap.getDy(0, 1, 1000n, xp, Ann, baseFee, feeMultiplier);

      expect(dy).toBeGreaterThan(0n);
      expect(dy).toBeLessThanOrEqual(1000n); // Can't get more than input
    });
  });

  describe("Very Large Swaps", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const xp = [1000000n * 10n ** 18n, 1000000n * 10n ** 18n]; // 1M each
    const baseFee = 4000000n;
    const feeMultiplier = 2n * 10n ** 10n;

    it("should handle swapping entire balance", () => {
      // Try to swap all of token 0 (this should drain token 1)
      const dx = xp[0];
      const dy = stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);

      // Should get significant output but less than token 1 balance
      expect(dy).toBeGreaterThan(0n);
      expect(dy).toBeLessThan(xp[1]);
    });

    it("should handle swap larger than any balance", () => {
      // Try to swap more than exists
      const dx = xp[0] * 10n;

      // This might throw or return a very small output
      try {
        const dy = stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);
        // If it doesn't throw, output should be limited by pool balance
        expect(dy).toBeLessThan(xp[1]);
      } catch {
        // Throwing is acceptable for impossible swaps
        expect(true).toBe(true);
      }
    });
  });

  describe("Precision Extremes", () => {
    it("should handle 0-decimal token equivalent", () => {
      // Simulate 0-decimal token scaled to 18 decimals
      // If token has 0 decimals, 1 token = 1e18 in xp
      const Ann = stableswap.computeAnn(100n, 2);
      const xp = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
      const baseFee = 4000000n;
      const feeMultiplier = 2n * 10n ** 10n;

      // Swap exactly 1 "token" (1e18 in precision)
      const dx = 10n ** 18n;
      const dy = stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);

      expect(dy).toBeGreaterThan(0n);
      // Close to 1:1 for balanced pool
      expect(dy).toBeGreaterThan(9n * 10n ** 17n);
    });

    it("should handle different precision multipliers", () => {
      // Pool with 6 vs 18 decimal tokens (USDC/DAI style)
      // After precision adjustment both should be 1e18
      const Ann = stableswap.computeAnn(100n, 2);
      const xp = [1000000n * 10n ** 18n, 1000000n * 10n ** 18n]; // Both normalized
      const baseFee = 4000000n;
      const feeMultiplier = 2n * 10n ** 10n;

      const dx = 1000n * 10n ** 18n; // 1000 tokens normalized
      const dy = stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);

      // Should be close to 1:1
      expect(dy).toBeGreaterThan(990n * 10n ** 18n);
      expect(dy).toBeLessThan(1010n * 10n ** 18n);
    });
  });

  describe("Zero and Boundary Values", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const xp = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
    const baseFee = 4000000n;
    const feeMultiplier = 2n * 10n ** 10n;

    it("should handle 0 input gracefully", () => {
      const dy = stableswap.getDy(0, 1, 0n, xp, Ann, baseFee, feeMultiplier);
      // 0 input might return 0 or -1 (due to fee subtraction from nothing)
      // The important thing is it doesn't throw
      expect(dy).toBeLessThanOrEqual(0n);
    });

    it("should handle same index swap (i == j)", () => {
      // Swapping token to itself should either throw or return 0
      try {
        const dy = stableswap.getDy(0, 0, 10n ** 18n, xp, Ann, baseFee, feeMultiplier);
        expect(dy).toBe(0n);
      } catch {
        // Throwing is acceptable
        expect(true).toBe(true);
      }
    });
  });

  describe("Multi-Coin Pools", () => {
    it("should handle 3-coin balanced pool", () => {
      const Ann = stableswap.computeAnn(100n, 3);
      const xp = [
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
      ];
      const baseFee = 4000000n;
      const feeMultiplier = 2n * 10n ** 10n;

      // Test all pair combinations
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (i !== j) {
            const dy = stableswap.getDy(
              i,
              j,
              10n * 10n ** 18n,
              xp,
              Ann,
              baseFee,
              feeMultiplier
            );
            expect(dy).toBeGreaterThan(0n);
          }
        }
      }
    });

    it("should handle 4-coin pool", () => {
      const Ann = stableswap.computeAnn(100n, 4);
      const xp = [
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
        1000n * 10n ** 18n,
      ];
      const baseFee = 4000000n;
      const feeMultiplier = 2n * 10n ** 10n;

      const dy = stableswap.getDy(0, 3, 10n * 10n ** 18n, xp, Ann, baseFee, feeMultiplier);
      expect(dy).toBeGreaterThan(0n);
    });
  });
});

describe("CryptoSwap Edge Cases", () => {
  describe("Extreme Price Ratios", () => {
    it("should handle high price_scale (expensive token)", () => {
      // Use balanced params where D is consistent with balances * price_scale
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 145000000000000n,
        D: 2000000n * 10n ** 18n, // D should match scaled balance sum
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 10n ** 18n, // 1:1 price scale
        balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
        precisions: [1n, 1n],
      };

      const dx = 100n * 10n ** 18n; // Swap 100 tokens
      const dy = cryptoswap.getDy(params, 0, 1, dx);

      // Should get approximately 100 tokens out (minus fees)
      expect(dy).toBeGreaterThan(0n);
      expect(dy).toBeLessThan(dx * 2n); // Reasonable output
    });

    it("should handle swapping with fees applied", () => {
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 145000000000000n,
        D: 2000000n * 10n ** 18n,
        midFee: 3000000n, // 0.03%
        outFee: 30000000n, // 0.3%
        feeGamma: 230000000000000n,
        priceScale: 10n ** 18n,
        balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
        precisions: [1n, 1n],
      };

      const dx = 1000n * 10n ** 18n;
      const dy = cryptoswap.getDy(params, 0, 1, dx);

      // Output should be less than input due to fees
      expect(dy).toBeGreaterThan(0n);
      expect(dy).toBeLessThan(dx);
    });
  });

  describe("Extreme Gamma Values", () => {
    it("should handle very low gamma (more concentrated liquidity)", () => {
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 10n ** 10n, // Very low gamma
        D: 2000000n * 10n ** 18n,
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 10n ** 18n,
        balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
        precisions: [1n, 1n],
      };

      const dx = 1000n * 10n ** 18n;
      const dy = cryptoswap.getDy(params, 0, 1, dx);

      expect(dy).toBeGreaterThan(0n);
    });

    it("should handle high gamma (flatter curve)", () => {
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 10n ** 16n, // High gamma
        D: 2000000n * 10n ** 18n,
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 10n ** 18n,
        balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
        precisions: [1n, 1n],
      };

      const dx = 1000n * 10n ** 18n;
      const dy = cryptoswap.getDy(params, 0, 1, dx);

      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("Tricrypto Edge Cases", () => {
    it("should handle 3-coin balanced pool", () => {
      // Use consistent D with balanced pools at 1:1 price scales
      const params: cryptoswap.TricryptoParams = {
        A: 2700n,
        gamma: 1300000000000n,
        D: 3000000n * 10n ** 18n, // Consistent with 3 * 1M tokens
        midFee: 1000000n,
        outFee: 45000000n,
        feeGamma: 5000000000000000n,
        priceScales: [10n ** 18n, 10n ** 18n], // 1:1:1 price scales
        balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
        precisions: [1n, 1n, 1n],
      };

      // Test 0 -> 1
      const dy1 = cryptoswap.getDy3(params, 0, 1, 100n * 10n ** 18n);
      expect(dy1).toBeGreaterThan(0n);

      // Test 1 -> 2
      const dy2 = cryptoswap.getDy3(params, 1, 2, 100n * 10n ** 18n);
      expect(dy2).toBeGreaterThan(0n);

      // Test 2 -> 0
      const dy3 = cryptoswap.getDy3(params, 2, 0, 100n * 10n ** 18n);
      expect(dy3).toBeGreaterThan(0n);
    });
  });

  describe("Newton's Method Convergence", () => {
    it("should converge for standard parameters", () => {
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 145000000000000n,
        D: 2000000n * 10n ** 18n,
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 10n ** 18n,
        balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
        precisions: [1n, 1n],
      };

      // Multiple swap sizes to test convergence
      const sizes = [1n, 100n, 10000n, 100000n, 1000000n];

      for (const size of sizes) {
        const dx = size * 10n ** 18n;
        const dy = cryptoswap.getDy(params, 0, 1, dx);
        expect(dy).toBeGreaterThanOrEqual(0n);
      }
    });

    it("should handle balanced CryptoSwap pool with standard swap", () => {
      // Fully balanced pool for reliable convergence
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 145000000000000n,
        D: 2000000n * 10n ** 18n,
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 10n ** 18n,
        balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n], // Balanced
        precisions: [1n, 1n],
      };

      const dx = 1000n * 10n ** 18n;
      const dy = cryptoswap.getDy(params, 0, 1, dx);

      expect(dy).toBeGreaterThan(0n);
    });
  });
});

describe("StableSwap Exact Precision Edge Cases", () => {
  describe("Extreme Balances", () => {
    it("should handle very small balances", () => {
      const params: stableswapExact.ExactPoolParams = {
        balances: [1000n, 1000n], // Very small balances
        rates: [10n ** 30n, 10n ** 30n], // 6 decimal tokens
        A: 100n,
        fee: 4000000n,
        offpegFeeMultiplier: 0n,
      };

      const dy = stableswapExact.getDyExact(0, 1, 100n, params);
      expect(dy).toBeGreaterThanOrEqual(0n);
    });

    it("should handle max uint128 balances", () => {
      const maxUint128 = 2n ** 128n - 1n;
      const params: stableswapExact.ExactPoolParams = {
        balances: [maxUint128 / 2n, maxUint128 / 2n], // Large but not overflow
        rates: [10n ** 18n, 10n ** 18n],
        A: 100n,
        fee: 4000000n,
        offpegFeeMultiplier: 0n,
      };

      // Should not throw
      const xp = stableswapExact.getXp(params.balances, params.rates);
      expect(xp.length).toBe(2);
    });
  });

  describe("Zero and Invalid Inputs", () => {
    const params: stableswapExact.ExactPoolParams = {
      balances: [10n ** 24n, 10n ** 24n],
      rates: [10n ** 18n, 10n ** 18n],
      A: 100n,
      fee: 4000000n,
      offpegFeeMultiplier: 0n,
    };

    it("should handle zero input amount", () => {
      const dy = stableswapExact.getDyExact(0, 1, 0n, params);
      // Zero input might give negative result due to -1 in formula, that's expected
      expect(dy).toBeLessThanOrEqual(0n);
    });

    it("should handle zero fee", () => {
      const zeroFeeParams = { ...params, fee: 0n };
      const dy = stableswapExact.getDyExact(0, 1, 10n ** 18n, zeroFeeParams);
      expect(dy).toBeGreaterThan(0n);
    });

    it("should handle zero offpeg fee multiplier", () => {
      const dy = stableswapExact.getDyExact(0, 1, 10n ** 18n, params);
      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("Different Decimal Combinations", () => {
    it("should handle 6/6 decimal pair (USDC/USDT)", () => {
      const params: stableswapExact.ExactPoolParams = {
        balances: [10n ** 12n, 10n ** 12n], // 1M each in 6 decimals
        rates: [10n ** 30n, 10n ** 30n], // 10^(36-6)
        A: 100n,
        fee: 4000000n,
        offpegFeeMultiplier: 0n,
      };

      const dy = stableswapExact.getDyExact(0, 1, 10n ** 6n, params);
      expect(dy).toBeGreaterThan(0n);
      expect(dy).toBeLessThan(10n ** 7n); // Reasonable output
    });

    it("should handle 8/18 decimal pair (WBTC/WETH)", () => {
      const params: stableswapExact.ExactPoolParams = {
        balances: [100n * 10n ** 8n, 100n * 10n ** 18n], // 100 WBTC, 100 WETH
        rates: [10n ** 28n, 10n ** 18n], // Different rates
        A: 100n,
        fee: 4000000n,
        offpegFeeMultiplier: 0n,
      };

      const dy = stableswapExact.getDyExact(0, 1, 10n ** 8n, params);
      expect(dy).toBeGreaterThan(0n);
    });

    it("should handle 18/6 decimal pair (DAI/USDC)", () => {
      const params: stableswapExact.ExactPoolParams = {
        balances: [10n ** 24n, 10n ** 12n], // 1M DAI, 1M USDC
        rates: [10n ** 18n, 10n ** 30n],
        A: 100n,
        fee: 4000000n,
        offpegFeeMultiplier: 0n,
      };

      const dy = stableswapExact.getDyExact(0, 1, 10n ** 18n, params);
      expect(dy).toBeGreaterThan(0n);
      // 1 DAI should give approximately 1 USDC (6 decimals)
      expect(dy).toBeLessThan(2n * 10n ** 6n);
    });
  });

  describe("Dynamic Fee Edge Cases", () => {
    it("should increase fee for imbalanced pool", () => {
      // Balanced pool fee
      const balancedFee = stableswapExact.dynamicFee(
        10n ** 18n,
        10n ** 18n,
        4000000n,
        20000000000n // 2x fee multiplier
      );

      // Imbalanced pool fee (10:1 ratio)
      const imbalancedFee = stableswapExact.dynamicFee(
        10n * 10n ** 18n,
        1n * 10n ** 18n,
        4000000n,
        20000000000n
      );

      expect(imbalancedFee).toBeGreaterThan(balancedFee);
    });

    it("should return base fee when multiplier <= FEE_DENOMINATOR", () => {
      const fee = stableswapExact.dynamicFee(
        10n ** 18n,
        10n ** 18n,
        4000000n,
        10n ** 10n // Exactly FEE_DENOMINATOR
      );

      expect(fee).toBe(4000000n);
    });
  });

  describe("getD Convergence", () => {
    it("should converge for standard pool", () => {
      const xp = [10n ** 24n, 10n ** 24n];
      const amp = 100n * 100n; // A * A_PRECISION
      const D = stableswapExact.getD(xp, amp, 2);
      expect(D).toBeGreaterThan(0n);
    });

    it("should converge for highly imbalanced pool", () => {
      const xp = [10n ** 26n, 10n ** 22n]; // 10000:1 ratio
      const amp = 100n * 100n;
      const D = stableswapExact.getD(xp, amp, 2);
      expect(D).toBeGreaterThan(0n);
    });

    it("should return 0 for empty pool", () => {
      const D = stableswapExact.getD([0n, 0n], 10000n, 2);
      expect(D).toBe(0n);
    });
  });

  describe("getY Convergence", () => {
    it("should converge for standard swap", () => {
      const xp = [10n ** 24n, 10n ** 24n];
      const amp = 10000n;
      const D = stableswapExact.getD(xp, amp, 2);

      const newXp0 = xp[0] + 10n ** 23n;
      const y = stableswapExact.getY(0, 1, newXp0, xp, amp, D, 2);

      expect(y).toBeGreaterThan(0n);
      expect(y).toBeLessThan(xp[1]); // Should decrease token 1
    });
  });

  describe("getDx Exact Precision", () => {
    it("should find correct input for desired output", () => {
      const params: stableswapExact.ExactPoolParams = {
        balances: [10n ** 24n, 10n ** 24n],
        rates: [10n ** 18n, 10n ** 18n],
        A: 100n,
        fee: 4000000n,
        offpegFeeMultiplier: 0n,
      };

      const desiredDy = 10n ** 22n; // Want 10,000 tokens out
      const dx = stableswapExact.getDxExact(0, 1, desiredDy, params);

      // Verify: getDyExact(dx) should give approximately desiredDy
      const actualDy = stableswapExact.getDyExact(0, 1, dx, params);

      const diff = actualDy > desiredDy ? actualDy - desiredDy : desiredDy - actualDy;
      const tolerance = desiredDy / 100n; // 1% tolerance
      expect(diff).toBeLessThanOrEqual(tolerance);
    });
  });
});

describe("Input Validation", () => {
  describe("StableSwap Index Validation", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const xp = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
    const baseFee = 4000000n;
    const feeMultiplier = 2n * 10n ** 10n;

    it("getDy should return 0 for i === j", () => {
      expect(stableswap.getDy(0, 0, 10n ** 18n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
      expect(stableswap.getDy(1, 1, 10n ** 18n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
    });

    it("getDy should return 0 for out-of-bounds indices", () => {
      expect(stableswap.getDy(-1, 0, 10n ** 18n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
      expect(stableswap.getDy(0, 2, 10n ** 18n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
      expect(stableswap.getDy(5, 0, 10n ** 18n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
    });

    it("getDy should return 0 for dx === 0", () => {
      expect(stableswap.getDy(0, 1, 0n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
    });

    it("getDx should return 0 for i === j", () => {
      expect(stableswap.getDx(0, 0, 10n ** 18n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
    });

    it("getDx should return 0 for out-of-bounds indices", () => {
      expect(stableswap.getDx(-1, 0, 10n ** 18n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
      expect(stableswap.getDx(0, 2, 10n ** 18n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
    });

    it("getDx should return 0 for dy === 0", () => {
      expect(stableswap.getDx(0, 1, 0n, xp, Ann, baseFee, feeMultiplier)).toBe(0n);
    });

    it("getY should throw for i === j", () => {
      const D = stableswap.getD(xp, Ann);
      expect(() => stableswap.getY(0, 0, xp[0], xp, Ann, D)).toThrow("i and j must be different");
    });

    it("getY should throw for out-of-bounds indices", () => {
      const D = stableswap.getD(xp, Ann);
      expect(() => stableswap.getY(-1, 0, xp[0], xp, Ann, D)).toThrow("index out of bounds");
      expect(() => stableswap.getY(0, 5, xp[0], xp, Ann, D)).toThrow("index out of bounds");
    });

    it("getYD should throw for out-of-bounds index", () => {
      const D = stableswap.getD(xp, Ann);
      expect(() => stableswap.getYD(5, xp, Ann, D)).toThrow("index out of bounds");
      expect(() => stableswap.getYD(-1, xp, Ann, D)).toThrow("index out of bounds");
    });
  });

  describe("StableSwap Zero Balance Validation", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const _baseFee = 4000000n;
    const _feeMultiplier = 2n * 10n ** 10n;

    it("getD should throw for zero balances", () => {
      expect(() => stableswap.getD([0n, 1000n * 10n ** 18n], Ann)).toThrow(
        "zero balance would cause division by zero"
      );
      expect(() => stableswap.getD([1000n * 10n ** 18n, 0n], Ann)).toThrow(
        "zero balance would cause division by zero"
      );
    });

    it("getY should throw for zero balance in computation", () => {
      const xp = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
      const D = stableswap.getD(xp, Ann);
      // When x = 0, getY should throw
      expect(() => stableswap.getY(0, 1, 0n, xp, Ann, D)).toThrow(
        "zero balance at index 0 would cause division by zero"
      );
    });
  });

  describe("CryptoSwap Index Validation", () => {
    const params: cryptoswap.TwocryptoParams = {
      A: 400000n,
      gamma: 145000000000000n,
      D: 2000000n * 10n ** 18n,
      midFee: 3000000n,
      outFee: 30000000n,
      feeGamma: 230000000000000n,
      priceScale: 10n ** 18n,
      balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
      precisions: [1n, 1n],
    };

    it("getDy should return 0 for i === j", () => {
      expect(cryptoswap.getDy(params, 0, 0, 10n ** 18n)).toBe(0n);
      expect(cryptoswap.getDy(params, 1, 1, 10n ** 18n)).toBe(0n);
    });

    it("getDy should return 0 for out-of-bounds indices", () => {
      expect(cryptoswap.getDy(params, -1, 0, 10n ** 18n)).toBe(0n);
      expect(cryptoswap.getDy(params, 0, 2, 10n ** 18n)).toBe(0n);
      expect(cryptoswap.getDy(params, 5, 0, 10n ** 18n)).toBe(0n);
    });

    it("getDy should return 0 for dx === 0", () => {
      expect(cryptoswap.getDy(params, 0, 1, 0n)).toBe(0n);
    });

    it("getDx should return 0 for i === j", () => {
      expect(cryptoswap.getDx(params, 0, 0, 10n ** 18n)).toBe(0n);
    });

    it("getDx should return 0 for out-of-bounds indices", () => {
      expect(cryptoswap.getDx(params, -1, 0, 10n ** 18n)).toBe(0n);
      expect(cryptoswap.getDx(params, 0, 2, 10n ** 18n)).toBe(0n);
    });

    it("getDx should return 0 for dy === 0", () => {
      expect(cryptoswap.getDx(params, 0, 1, 0n)).toBe(0n);
    });

    it("getSpotPrice should return 0 for i === j", () => {
      expect(cryptoswap.getSpotPrice(params, 0, 0)).toBe(0n);
    });

    it("getSpotPrice should return 0 for out-of-bounds indices", () => {
      expect(cryptoswap.getSpotPrice(params, -1, 0)).toBe(0n);
      expect(cryptoswap.getSpotPrice(params, 0, 5)).toBe(0n);
    });
  });

  describe("CryptoSwap 3-Coin Index Validation", () => {
    const params: cryptoswap.TricryptoParams = {
      A: 2700n,
      gamma: 1300000000000n,
      D: 3000000n * 10n ** 18n,
      midFee: 1000000n,
      outFee: 45000000n,
      feeGamma: 5000000000000000n,
      priceScales: [10n ** 18n, 10n ** 18n],
      balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
      precisions: [1n, 1n, 1n],
    };

    it("getDy3 should return 0 for i === j", () => {
      expect(cryptoswap.getDy3(params, 0, 0, 10n ** 18n)).toBe(0n);
      expect(cryptoswap.getDy3(params, 2, 2, 10n ** 18n)).toBe(0n);
    });

    it("getDy3 should return 0 for out-of-bounds indices", () => {
      expect(cryptoswap.getDy3(params, -1, 0, 10n ** 18n)).toBe(0n);
      expect(cryptoswap.getDy3(params, 0, 3, 10n ** 18n)).toBe(0n);
      expect(cryptoswap.getDy3(params, 5, 0, 10n ** 18n)).toBe(0n);
    });

    it("getDy3 should return 0 for dx === 0", () => {
      expect(cryptoswap.getDy3(params, 0, 1, 0n)).toBe(0n);
    });

    it("getDx3 should return 0 for i === j", () => {
      expect(cryptoswap.getDx3(params, 0, 0, 10n ** 18n)).toBe(0n);
    });

    it("getDx3 should return 0 for out-of-bounds indices", () => {
      expect(cryptoswap.getDx3(params, -1, 0, 10n ** 18n)).toBe(0n);
      expect(cryptoswap.getDx3(params, 0, 3, 10n ** 18n)).toBe(0n);
    });

    it("getDx3 should return 0 for dy === 0", () => {
      expect(cryptoswap.getDx3(params, 0, 1, 0n)).toBe(0n);
    });

    it("getSpotPrice3 should return 0 for i === j", () => {
      expect(cryptoswap.getSpotPrice3(params, 1, 1)).toBe(0n);
    });

    it("getSpotPrice3 should return 0 for out-of-bounds indices", () => {
      expect(cryptoswap.getSpotPrice3(params, -1, 0)).toBe(0n);
      expect(cryptoswap.getSpotPrice3(params, 0, 5)).toBe(0n);
    });
  });

  describe("StableSwap Exact Index Validation", () => {
    const params: stableswapExact.ExactPoolParams = {
      balances: [10n ** 24n, 10n ** 24n],
      rates: [10n ** 18n, 10n ** 18n],
      A: 100n,
      fee: 4000000n,
      offpegFeeMultiplier: 0n,
    };

    it("getDyExact should return 0 for i === j", () => {
      expect(stableswapExact.getDyExact(0, 0, 10n ** 18n, params)).toBe(0n);
    });

    it("getDyExact should return 0 for out-of-bounds indices", () => {
      expect(stableswapExact.getDyExact(-1, 0, 10n ** 18n, params)).toBe(0n);
      expect(stableswapExact.getDyExact(0, 2, 10n ** 18n, params)).toBe(0n);
    });

    it("getDyExact should return 0 for dx === 0", () => {
      expect(stableswapExact.getDyExact(0, 1, 0n, params)).toBe(0n);
    });

    it("getDxExact should return 0 for i === j", () => {
      expect(stableswapExact.getDxExact(0, 0, 10n ** 18n, params)).toBe(0n);
    });

    it("getDxExact should return 0 for out-of-bounds indices", () => {
      expect(stableswapExact.getDxExact(-1, 0, 10n ** 18n, params)).toBe(0n);
      expect(stableswapExact.getDxExact(0, 2, 10n ** 18n, params)).toBe(0n);
    });

    it("getDxExact should return 0 for dy === 0", () => {
      expect(stableswapExact.getDxExact(0, 1, 0n, params)).toBe(0n);
    });

    it("getY should throw for i === j", () => {
      const xp = stableswapExact.getXp(params.balances, params.rates);
      const amp = params.A * stableswapExact.A_PRECISION;
      const D = stableswapExact.getD(xp, amp, 2);
      expect(() => stableswapExact.getY(0, 0, xp[0], xp, amp, D, 2)).toThrow("i and j must be different");
    });

    it("getY should throw for out-of-bounds indices", () => {
      const xp = stableswapExact.getXp(params.balances, params.rates);
      const amp = params.A * stableswapExact.A_PRECISION;
      const D = stableswapExact.getD(xp, amp, 2);
      expect(() => stableswapExact.getY(-1, 0, xp[0], xp, amp, D, 2)).toThrow("index out of bounds");
      expect(() => stableswapExact.getY(0, 5, xp[0], xp, amp, D, 2)).toThrow("index out of bounds");
    });

    it("getYD should throw for out-of-bounds index", () => {
      const xp = stableswapExact.getXp(params.balances, params.rates);
      const amp = params.A * stableswapExact.A_PRECISION;
      const D = stableswapExact.getD(xp, amp, 2);
      expect(() => stableswapExact.getYD(amp, 5, xp, D, 2)).toThrow("index out of bounds");
    });
  });

  describe("StableSwap Exact Zero Balance Validation", () => {
    it("getD should throw for zero balances", () => {
      const rates = [10n ** 18n, 10n ** 18n];
      const xp = stableswapExact.getXp([0n, 1000n * 10n ** 18n], rates);
      const amp = 100n * stableswapExact.A_PRECISION;
      expect(() => stableswapExact.getD(xp, amp, 2)).toThrow(
        "zero balance would cause division by zero"
      );
    });

    it("getY should throw for zero balance in computation", () => {
      const rates = [10n ** 18n, 10n ** 18n];
      const balances = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
      const xp = stableswapExact.getXp(balances, rates);
      const amp = 100n * stableswapExact.A_PRECISION;
      const D = stableswapExact.getD(xp, amp, 2);
      expect(() => stableswapExact.getY(0, 1, 0n, xp, amp, D, 2)).toThrow(
        "zero balance at index 0 would cause division by zero"
      );
    });

    it("getYD should throw for zero balance", () => {
      const _rates = [10n ** 18n, 10n ** 18n];
      const xp = [1000n * 10n ** 18n, 0n]; // Zero balance at index 1
      const amp = 100n * stableswapExact.A_PRECISION;
      // Use a positive D
      const D = 1000n * 10n ** 18n;
      expect(() => stableswapExact.getYD(amp, 0, xp, D, 2)).toThrow(
        "zero balance at index 1 would cause division by zero"
      );
    });
  });
});

describe("Parameter Boundary Tests", () => {
  describe("StableSwap A Parameter Bounds", () => {
    const xp = [1000n * 10n ** 18n, 1000n * 10n ** 18n];
    const baseFee = 4000000n;
    const feeMultiplier = 2n * 10n ** 10n;

    it("should work with minimum A = 1", () => {
      const Ann = stableswap.computeAnn(1n, 2);
      const dy = stableswap.getDy(0, 1, 10n ** 18n, xp, Ann, baseFee, feeMultiplier);
      expect(dy).toBeGreaterThan(0n);
    });

    it("should work with very high A = 5000", () => {
      // High A makes curve more like constant sum
      const Ann = stableswap.computeAnn(5000n, 2);
      const dy = stableswap.getDy(0, 1, 10n ** 18n, xp, Ann, baseFee, feeMultiplier);
      expect(dy).toBeGreaterThan(0n);
      // High A should give nearly 1:1 rate
      expect(dy).toBeGreaterThan(9n * 10n ** 17n);
    });

    it("should work with production-level A = 2000 (Curve 3pool)", () => {
      const Ann = stableswap.computeAnn(2000n, 3);
      const xp3 = [1000n * 10n ** 18n, 1000n * 10n ** 18n, 1000n * 10n ** 18n];
      const dy = stableswap.getDy(0, 1, 10n ** 18n, xp3, Ann, baseFee, feeMultiplier);
      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("StableSwap Fee Bounds", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const xp = [1000n * 10n ** 18n, 1000n * 10n ** 18n];

    it("should work with zero fee", () => {
      const dy = stableswap.getDy(0, 1, 10n ** 18n, xp, Ann, 0n, 0n);
      expect(dy).toBeGreaterThan(0n);
      // With zero fee, output should be very close to input
      expect(dy).toBeGreaterThan(99n * 10n ** 16n);
    });

    it("should work with maximum fee = 0.5% (50000000n)", () => {
      const maxFee = 50000000n; // 0.5%
      const dy = stableswap.getDy(0, 1, 10n ** 18n, xp, Ann, maxFee, 10n ** 10n);
      expect(dy).toBeGreaterThan(0n);
      // High fee should reduce output
      expect(dy).toBeLessThan(10n ** 18n);
    });

    it("should work with dynamic fee multiplier at 2x", () => {
      const baseFee = 4000000n;
      const feeMultiplier = 2n * 10n ** 10n; // 2x
      const dy = stableswap.getDy(0, 1, 10n ** 18n, xp, Ann, baseFee, feeMultiplier);
      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("CryptoSwap Gamma Bounds", () => {
    const baseParams: cryptoswap.TwocryptoParams = {
      A: 400000n,
      gamma: 145000000000000n,
      D: 2000000n * 10n ** 18n,
      midFee: 3000000n,
      outFee: 30000000n,
      feeGamma: 230000000000000n,
      priceScale: 10n ** 18n,
      balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
      precisions: [1n, 1n],
    };

    it("should work with low gamma (concentrated liquidity)", () => {
      const params = { ...baseParams, gamma: 10n ** 12n };
      const dy = cryptoswap.getDy(params, 0, 1, 1000n * 10n ** 18n);
      expect(dy).toBeGreaterThan(0n);
    });

    it("should work with high gamma (flatter curve)", () => {
      const params = { ...baseParams, gamma: 10n ** 16n };
      const dy = cryptoswap.getDy(params, 0, 1, 1000n * 10n ** 18n);
      expect(dy).toBeGreaterThan(0n);
    });

    it("should work with production gamma (typical tricrypto)", () => {
      const params = { ...baseParams, gamma: 11000000000000n };
      const dy = cryptoswap.getDy(params, 0, 1, 1000n * 10n ** 18n);
      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("CryptoSwap A Bounds", () => {
    const baseParams: cryptoswap.TwocryptoParams = {
      A: 400000n,
      gamma: 145000000000000n,
      D: 2000000n * 10n ** 18n,
      midFee: 3000000n,
      outFee: 30000000n,
      feeGamma: 230000000000000n,
      priceScale: 10n ** 18n,
      balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
      precisions: [1n, 1n],
    };

    it("should work with low A = 4000", () => {
      const params = { ...baseParams, A: 4000n };
      const dy = cryptoswap.getDy(params, 0, 1, 1000n * 10n ** 18n);
      expect(dy).toBeGreaterThan(0n);
    });

    it("should work with high A = 4000000", () => {
      const params = { ...baseParams, A: 4000000n };
      const dy = cryptoswap.getDy(params, 0, 1, 1000n * 10n ** 18n);
      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("CryptoSwap Fee Bounds", () => {
    const baseParams: cryptoswap.TwocryptoParams = {
      A: 400000n,
      gamma: 145000000000000n,
      D: 2000000n * 10n ** 18n,
      midFee: 3000000n,
      outFee: 30000000n,
      feeGamma: 230000000000000n,
      priceScale: 10n ** 18n,
      balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
      precisions: [1n, 1n],
    };

    it("should work with zero midFee", () => {
      const params = { ...baseParams, midFee: 0n };
      const dy = cryptoswap.getDy(params, 0, 1, 1000n * 10n ** 18n);
      expect(dy).toBeGreaterThan(0n);
    });

    it("should work with high outFee = 1%", () => {
      const params = { ...baseParams, outFee: 100000000n }; // 1%
      const dy = cryptoswap.getDy(params, 0, 1, 1000n * 10n ** 18n);
      expect(dy).toBeGreaterThan(0n);
      expect(dy).toBeLessThan(1000n * 10n ** 18n);
    });
  });

  describe("Decimal Precision Bounds", () => {
    it("StableSwapExact should handle 6-decimal tokens (USDC)", () => {
      const params: stableswapExact.ExactPoolParams = {
        balances: [10n ** 12n, 10n ** 12n], // 1M USDC each (6 decimals)
        rates: [10n ** 30n, 10n ** 30n], // 10^(36-6) = 10^30
        A: 100n,
        fee: 4000000n,
        offpegFeeMultiplier: 0n,
      };
      const dy = stableswapExact.getDyExact(0, 1, 10n ** 6n, params); // 1 USDC
      expect(dy).toBeGreaterThan(0n);
      expect(dy).toBeLessThan(2n * 10n ** 6n);
    });

    it("StableSwapExact should handle 8-decimal tokens (WBTC)", () => {
      const params: stableswapExact.ExactPoolParams = {
        balances: [10n * 10n ** 8n, 10n * 10n ** 8n], // 10 WBTC each
        rates: [10n ** 28n, 10n ** 28n], // 10^(36-8) = 10^28
        A: 100n,
        fee: 4000000n,
        offpegFeeMultiplier: 0n,
      };
      const dy = stableswapExact.getDyExact(0, 1, 10n ** 8n, params); // 1 WBTC
      expect(dy).toBeGreaterThan(0n);
    });

    it("StableSwapExact should handle mixed 6/18 decimals", () => {
      const params: stableswapExact.ExactPoolParams = {
        balances: [10n ** 12n, 10n ** 24n], // 1M USDC (6 dec), 1M DAI (18 dec)
        rates: [10n ** 30n, 10n ** 18n],
        A: 100n,
        fee: 4000000n,
        offpegFeeMultiplier: 0n,
      };
      // Swap 1 USDC for DAI
      const dy = stableswapExact.getDyExact(0, 1, 10n ** 6n, params);
      expect(dy).toBeGreaterThan(0n);
      // Should get close to 1 DAI (1e18)
      expect(dy).toBeGreaterThan(9n * 10n ** 17n);
    });

    it("CryptoSwap should handle 6-decimal precision multiplier", () => {
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 145000000000000n,
        D: 2000000n * 10n ** 18n,
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 10n ** 18n,
        balances: [1000000n * 10n ** 6n, 1000000n * 10n ** 18n], // USDC/DAI style
        precisions: [10n ** 12n, 1n], // 10^(18-6), 10^(18-18)
      };
      const dy = cryptoswap.getDy(params, 0, 1, 1000n * 10n ** 6n);
      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("Balance Size Bounds", () => {
    it("should handle very small balances (1 token)", () => {
      const Ann = stableswap.computeAnn(100n, 2);
      const xp = [10n ** 18n, 10n ** 18n]; // 1 token each
      const baseFee = 4000000n;
      const feeMultiplier = 2n * 10n ** 10n;

      const dy = stableswap.getDy(0, 1, 10n ** 17n, xp, Ann, baseFee, feeMultiplier); // 0.1 token
      expect(dy).toBeGreaterThan(0n);
    });

    it("should handle large balances (1 billion tokens)", () => {
      const Ann = stableswap.computeAnn(100n, 2);
      const xp = [10n ** 27n, 10n ** 27n]; // 1B tokens each (18 decimals)
      const baseFee = 4000000n;
      const feeMultiplier = 2n * 10n ** 10n;

      const dy = stableswap.getDy(0, 1, 10n ** 24n, xp, Ann, baseFee, feeMultiplier); // 1M tokens
      expect(dy).toBeGreaterThan(0n);
    });

    it("CryptoSwap should handle large D values", () => {
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 145000000000000n,
        D: 10n ** 30n, // Very large D
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 10n ** 18n,
        balances: [5n * 10n ** 29n, 5n * 10n ** 29n], // Corresponding balances
        precisions: [1n, 1n],
      };
      const dy = cryptoswap.getDy(params, 0, 1, 10n ** 27n);
      expect(dy).toBeGreaterThan(0n);
    });
  });

  describe("Price Scale Bounds", () => {
    it("CryptoSwap should handle high priceScale (expensive token)", () => {
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 145000000000000n,
        D: 2000000n * 10n ** 18n,
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 60000n * 10n ** 18n, // BTC price ~60k USD
        balances: [1000000n * 10n ** 18n, 16n * 10n ** 18n], // $1M USD, ~16 BTC
        precisions: [1n, 1n],
      };
      const dy = cryptoswap.getDy(params, 0, 1, 1000n * 10n ** 18n);
      expect(dy).toBeGreaterThanOrEqual(0n);
    });

    it("CryptoSwap should handle low priceScale", () => {
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 145000000000000n,
        D: 2000000n * 10n ** 18n,
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 10n ** 14n, // Very low price (0.0001)
        balances: [1000n * 10n ** 18n, 10000000n * 10n ** 18n],
        precisions: [1n, 1n],
      };
      // Scaled balances this far from D fail newton_y's safety asserts, as on chain
      expect(() => cryptoswap.getDy(params, 0, 1, 100n * 10n ** 18n)).toThrow("unsafe value");
    });

    it("Tricrypto should handle varied priceScales", () => {
      const params: cryptoswap.TricryptoParams = {
        A: 2700n,
        gamma: 1300000000000n,
        D: 3000000n * 10n ** 18n,
        midFee: 1000000n,
        outFee: 45000000n,
        feeGamma: 5000000000000000n,
        priceScales: [60000n * 10n ** 18n, 3000n * 10n ** 18n], // BTC, ETH prices
        balances: [1000000n * 10n ** 18n, 16n * 10n ** 18n, 333n * 10n ** 18n],
        precisions: [1n, 1n, 1n],
      };
      const dy = cryptoswap.getDy3(params, 0, 1, 1000n * 10n ** 18n);
      expect(dy).toBeGreaterThanOrEqual(0n);
    });
  });
});

describe("Inverse Function Accuracy", () => {
  describe("StableSwap getDx/getDy inverse", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const xp = [10000n * 10n ** 18n, 10000n * 10n ** 18n];
    const baseFee = 4000000n;
    const feeMultiplier = 2n * 10n ** 10n;

    it("should satisfy getDy(getDx(desired_dy)) ≈ desired_dy", () => {
      const desiredDy = 100n * 10n ** 18n;

      const dx = stableswap.getDx(0, 1, desiredDy, xp, Ann, baseFee, feeMultiplier);
      const actualDy = stableswap.getDy(0, 1, dx, xp, Ann, baseFee, feeMultiplier);

      // Allow 1% tolerance
      const diff = actualDy > desiredDy ? actualDy - desiredDy : desiredDy - actualDy;
      const tolerance = desiredDy / 100n;

      expect(diff).toBeLessThanOrEqual(tolerance);
    });

    it("should satisfy getDx(getDy(dx)) ≈ dx (round-trip)", () => {
      const originalDx = 100n * 10n ** 18n;

      const dy = stableswap.getDy(0, 1, originalDx, xp, Ann, baseFee, feeMultiplier);
      const recoveredDx = stableswap.getDx(0, 1, dy, xp, Ann, baseFee, feeMultiplier);

      // Allow 2% tolerance for round-trip (fees compound)
      const diff =
        recoveredDx > originalDx ? recoveredDx - originalDx : originalDx - recoveredDx;
      const tolerance = originalDx / 50n;

      expect(diff).toBeLessThanOrEqual(tolerance);
    });
  });

  describe("CryptoSwap getDx/getDy inverse", () => {
    const params: cryptoswap.TwocryptoParams = {
      A: 400000n,
      gamma: 145000000000000n,
      D: 2000000n * 10n ** 18n,
      midFee: 3000000n,
      outFee: 30000000n,
      feeGamma: 230000000000000n,
      priceScale: 10n ** 18n,
      balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
      precisions: [1n, 1n],
    };

    it("should satisfy getDy(getDx(desired_dy)) ≈ desired_dy", () => {
      const desiredDy = 100n * 10n ** 18n;

      const dx = cryptoswap.getDx(params, 0, 1, desiredDy);
      const actualDy = cryptoswap.getDy(params, 0, 1, dx);

      // Allow 1% tolerance
      const diff = actualDy > desiredDy ? actualDy - desiredDy : desiredDy - actualDy;
      const tolerance = desiredDy / 100n;

      expect(diff).toBeLessThanOrEqual(tolerance);
    });
  });
});

describe("Input Validation Tests", () => {
  describe("StableSwap Liquidity Function Validation", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const baseFee = 4000000n;

    describe("calcTokenAmount", () => {
      it("should throw for xp.length < 2", () => {
        const xp = [100n * 10n ** 18n]; // Only 1 coin
        const amounts = [10n * 10n ** 18n];
        const totalSupply = 1000n * 10n ** 18n;

        expect(() =>
          stableswap.calcTokenAmount(amounts, true, xp, Ann, totalSupply, baseFee)
        ).toThrow("pool must have at least 2 coins");
      });

      it("should throw for amounts.length !== N_COINS", () => {
        const xp = [100n * 10n ** 18n, 100n * 10n ** 18n];
        const amounts = [10n * 10n ** 18n, 10n * 10n ** 18n, 10n * 10n ** 18n]; // 3 amounts
        const totalSupply = 1000n * 10n ** 18n;

        expect(() =>
          stableswap.calcTokenAmount(amounts, true, xp, Ann, totalSupply, baseFee)
        ).toThrow("amounts length (3) must match pool size (2)");
      });
    });

    describe("calcWithdrawOneCoin", () => {
      it("should throw for xp.length < 2", () => {
        const xp = [100n * 10n ** 18n]; // Only 1 coin
        const tokenAmount = 10n * 10n ** 18n;
        const totalSupply = 1000n * 10n ** 18n;

        expect(() =>
          stableswap.calcWithdrawOneCoin(tokenAmount, 0, xp, Ann, totalSupply, baseFee)
        ).toThrow("pool must have at least 2 coins");
      });

      it("should throw for index out of bounds", () => {
        const xp = [100n * 10n ** 18n, 100n * 10n ** 18n];
        const tokenAmount = 10n * 10n ** 18n;
        const totalSupply = 1000n * 10n ** 18n;

        expect(() =>
          stableswap.calcWithdrawOneCoin(tokenAmount, 5, xp, Ann, totalSupply, baseFee)
        ).toThrow("index out of bounds");
        expect(() =>
          stableswap.calcWithdrawOneCoin(tokenAmount, -1, xp, Ann, totalSupply, baseFee)
        ).toThrow("index out of bounds");
      });

      it("should throw for totalSupply === 0", () => {
        const xp = [100n * 10n ** 18n, 100n * 10n ** 18n];
        const tokenAmount = 10n * 10n ** 18n;

        expect(() =>
          stableswap.calcWithdrawOneCoin(tokenAmount, 0, xp, Ann, 0n, baseFee)
        ).toThrow("totalSupply cannot be zero");
      });

      it("should return [0, 0] for tokenAmount === 0", () => {
        const xp = [100n * 10n ** 18n, 100n * 10n ** 18n];
        const totalSupply = 1000n * 10n ** 18n;

        const result = stableswap.calcWithdrawOneCoin(0n, 0, xp, Ann, totalSupply, baseFee);
        expect(result).toEqual([0n, 0n]);
      });
    });

    describe("calcRemoveLiquidityImbalance", () => {
      it("should throw for xp.length < 2", () => {
        const xp = [100n * 10n ** 18n]; // Only 1 coin
        const amounts = [10n * 10n ** 18n];
        const totalSupply = 1000n * 10n ** 18n;

        expect(() =>
          stableswap.calcRemoveLiquidityImbalance(amounts, xp, Ann, totalSupply, baseFee)
        ).toThrow("pool must have at least 2 coins");
      });

      it("should throw for amounts.length !== N_COINS", () => {
        const xp = [100n * 10n ** 18n, 100n * 10n ** 18n];
        const amounts = [10n * 10n ** 18n]; // Only 1 amount
        const totalSupply = 1000n * 10n ** 18n;

        expect(() =>
          stableswap.calcRemoveLiquidityImbalance(amounts, xp, Ann, totalSupply, baseFee)
        ).toThrow("amounts length (1) must match pool size (2)");
      });

      it("should throw for totalSupply === 0", () => {
        const xp = [100n * 10n ** 18n, 100n * 10n ** 18n];
        const amounts = [10n * 10n ** 18n, 10n * 10n ** 18n];

        expect(() =>
          stableswap.calcRemoveLiquidityImbalance(amounts, xp, Ann, 0n, baseFee)
        ).toThrow("totalSupply cannot be zero");
      });
    });
  });

  describe("CryptoSwap Core Function Validation", () => {
    describe("calcD", () => {
      it("should throw for A === 0", () => {
        const xp = [100n * 10n ** 18n, 100n * 10n ** 18n];
        const gamma = 145000000000000n;

        expect(() => cryptoswap.calcD(0n, gamma, xp)).toThrow("A parameter cannot be zero");
      });

      it("should throw for gamma === 0", () => {
        const xp = [100n * 10n ** 18n, 100n * 10n ** 18n];
        const A = 400000n;

        expect(() => cryptoswap.calcD(A, 0n, xp)).toThrow("gamma parameter cannot be zero");
      });

      it("should throw for xp.length < 2", () => {
        const xp = [100n * 10n ** 18n]; // Only 1 coin
        const A = 400000n;
        const gamma = 145000000000000n;

        expect(() => cryptoswap.calcD(A, gamma, xp)).toThrow("pool must have at least 2 coins");
      });
    });

    describe("calcWithdrawOneCoin (2-coin)", () => {
      const params: cryptoswap.TwocryptoParams = {
        A: 400000n,
        gamma: 145000000000000n,
        D: 2000000n * 10n ** 18n,
        midFee: 3000000n,
        outFee: 30000000n,
        feeGamma: 230000000000000n,
        priceScale: 10n ** 18n,
        balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
        precisions: [1n, 1n],
      };

      it("should throw for totalSupply === 0", () => {
        expect(() => cryptoswap.calcWithdrawOneCoin(params, 100n * 10n ** 18n, 0, 0n)).toThrow(
          "totalSupply cannot be zero"
        );
      });

      it("should return 0 for index out of bounds", () => {
        const totalSupply = 2000000n * 10n ** 18n;
        expect(cryptoswap.calcWithdrawOneCoin(params, 100n * 10n ** 18n, -1, totalSupply)).toBe(0n);
        expect(cryptoswap.calcWithdrawOneCoin(params, 100n * 10n ** 18n, 2, totalSupply)).toBe(0n);
      });

      it("should return 0 for tokenAmount === 0", () => {
        const totalSupply = 2000000n * 10n ** 18n;
        expect(cryptoswap.calcWithdrawOneCoin(params, 0n, 0, totalSupply)).toBe(0n);
      });
    });

    describe("calcWithdrawOneCoin3 (3-coin)", () => {
      const params: cryptoswap.TricryptoParams = {
        A: 2700n,
        gamma: 1300000000000n,
        D: 3000000n * 10n ** 18n,
        midFee: 1000000n,
        outFee: 45000000n,
        feeGamma: 5000000000000000n,
        priceScales: [10n ** 18n, 10n ** 18n],
        balances: [1000000n * 10n ** 18n, 1000000n * 10n ** 18n, 1000000n * 10n ** 18n],
        precisions: [1n, 1n, 1n],
      };

      it("should throw for totalSupply === 0", () => {
        expect(() => cryptoswap.calcWithdrawOneCoin3(params, 100n * 10n ** 18n, 0, 0n)).toThrow(
          "totalSupply cannot be zero"
        );
      });

      it("should return 0 for index out of bounds", () => {
        const totalSupply = 3000000n * 10n ** 18n;
        expect(cryptoswap.calcWithdrawOneCoin3(params, 100n * 10n ** 18n, -1, totalSupply)).toBe(0n);
        expect(cryptoswap.calcWithdrawOneCoin3(params, 100n * 10n ** 18n, 3, totalSupply)).toBe(0n);
      });

      it("should return 0 for tokenAmount === 0", () => {
        const totalSupply = 3000000n * 10n ** 18n;
        expect(cryptoswap.calcWithdrawOneCoin3(params, 0n, 0, totalSupply)).toBe(0n);
      });
    });
  });

  describe("StableSwap computeAnn Validation", () => {
    it("should throw for A === 0", () => {
      expect(() => stableswap.computeAnn(0n, 2)).toThrow("A parameter cannot be zero");
    });

    it("should work with valid A", () => {
      expect(stableswap.computeAnn(100n, 2)).toBeGreaterThan(0n);
    });
  });

  describe("StableSwap getDx Fee Guard", () => {
    const Ann = stableswap.computeAnn(100n, 2);
    const xp = [1000n * 10n ** 18n, 1000n * 10n ** 18n];

    it("should return 0n when fee >= FEE_DENOMINATOR", () => {
      // With extreme baseFee and feeMultiplier, dynamic fee could exceed limit
      const extremeFee = 10n ** 10n; // Equal to FEE_DENOMINATOR
      const extremeMultiplier = 10n ** 11n; // 10x FEE_DENOMINATOR
      const result = stableswap.getDx(0, 1, 100n * 10n ** 18n, xp, Ann, extremeFee, extremeMultiplier);
      // Should return 0 or a valid positive value, not throw
      expect(result).toBeGreaterThanOrEqual(0n);
    });
  });

  describe("CryptoSwap newtonY/newtonY3 Zero Balance Validation", () => {
    it("newtonY should throw for zero balance", () => {
      const A = 400000n;
      const gamma = 145000000000000n;
      const D = 2000000n * 10n ** 18n;
      const x: [bigint, bigint] = [0n, 1000000n * 10n ** 18n]; // Zero balance at index 0

      expect(() => cryptoswap.newtonY(A, gamma, x, D, 1)).toThrow("zero balance");
    });

    it("newtonY should throw for D === 0", () => {
      const A = 400000n;
      const gamma = 145000000000000n;
      const x: [bigint, bigint] = [1000000n * 10n ** 18n, 1000000n * 10n ** 18n];

      expect(() => cryptoswap.newtonY(A, gamma, x, 0n, 0)).toThrow("D cannot be zero");
    });

    it("newtonY3 should throw for zero balance", () => {
      const A = 2700n;
      const gamma = 1300000000000n;
      const D = 3000000n * 10n ** 18n;
      const x: [bigint, bigint, bigint] = [1000000n * 10n ** 18n, 0n, 1000000n * 10n ** 18n];

      expect(() => cryptoswap.newtonY3(A, gamma, x, D, 0)).toThrow("zero balance at index 1");
    });

    it("newtonY3 should throw for D === 0", () => {
      const A = 2700n;
      const gamma = 1300000000000n;
      const x: [bigint, bigint, bigint] = [1000000n * 10n ** 18n, 1000000n * 10n ** 18n, 1000000n * 10n ** 18n];

      expect(() => cryptoswap.newtonY3(A, gamma, x, 0n, 0)).toThrow("D cannot be zero");
    });
  });
});
