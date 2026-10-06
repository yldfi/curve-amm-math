/**
 * Fixture replay of Tricrypto-NG (v2.0.0) and Twocrypto-NG
 * (CurveTwocryptoOptimized v2.1.x) views against on-chain values at pinned
 * blocks. Every value must match to the wei.
 */
import { describe, it, expect } from "vitest";
import * as tricryptoNg from "./tricrypto-ng";
import * as twocryptoOptimized from "./twocrypto-optimized";
import ngCases from "./__fixtures__/crypto-ng-cases.json";
import poolCases from "./__fixtures__/curve-pool-cases.json";

interface NgCase {
  name: string;
  pool: string;
  block: number;
  version: string;
  MATH: string;
  A: string;
  gamma: string;
  D: string;
  mid_fee: string;
  out_fee: string;
  fee_gamma: string;
  fee: string;
  totalSupply: string;
  get_virtual_price: string;
  virtual_price: string;
  lp_price: string;
  price_oracle: string | string[];
  price_scale: string | string[];
  precisions: string[];
  balances: string[];
  get_dy: { i: number; j: number; dx: string; result: string }[];
  calc_token_amount: { amounts: string[]; deposit: boolean; result: string }[];
  calc_withdraw_one_coin: { tokenAmount: string; i: number; result: string }[];
}

const big = (xs: readonly string[]) => xs.map((x) => BigInt(x));

describe("Tricrypto-NG on-chain views", () => {
  for (const c of ngCases.tricrypto as NgCase[]) {
    describe(`${c.name} @${c.block}`, () => {
      const params: tricryptoNg.TricryptoNgParams = {
        A: BigInt(c.A),
        gamma: BigInt(c.gamma),
        D: BigInt(c.D),
        midFee: BigInt(c.mid_fee),
        outFee: BigInt(c.out_fee),
        feeGamma: BigInt(c.fee_gamma),
        priceScales: big(c.price_scale as string[]) as [bigint, bigint],
        balances: big(c.balances) as [bigint, bigint, bigint],
        precisions: big(c.precisions) as [bigint, bigint, bigint],
        totalSupply: BigInt(c.totalSupply),
      };

      it("is the supported implementation", () => {
        expect(() => tricryptoNg.assertSupportedImplementation(c.version, c.MATH)).not.toThrow();
      });

      it("fee and get_virtual_price", () => {
        expect(tricryptoNg.fee(params)).toBe(BigInt(c.fee));
        expect(tricryptoNg.getVirtualPrice(params)).toBe(BigInt(c.get_virtual_price));
      });

      it("get_dy", () => {
        for (const v of c.get_dy) {
          expect(tricryptoNg.getDy(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result));
        }
      });

      it("calc_token_amount", () => {
        for (const v of c.calc_token_amount) {
          expect(tricryptoNg.calcTokenAmount(params, big(v.amounts), v.deposit)).toBe(
            BigInt(v.result)
          );
        }
      });

      it("calc_withdraw_one_coin", () => {
        for (const v of c.calc_withdraw_one_coin) {
          expect(tricryptoNg.calcWithdrawOneCoin(params, BigInt(v.tokenAmount), v.i)).toBe(
            BigInt(v.result)
          );
        }
      });
    });
  }

  it("rejects other implementations", () => {
    expect(() => tricryptoNg.assertSupportedImplementation("v1.0.0")).toThrow("unsupported");
  });
});

describe("Tricrypto-NG calc_withdraw_one_coin fixture rows", () => {
  const NG_POOLS = new Set([
    "0xf5f5b97624542d72a9e06f04804bf81baa15e2b4",
    "0x4ebdf703948ddcea3b11f675b4d1fba9d2414a14",
    "0x86bf09acb47ab31686be413d614e9ded3666a1d3",
  ]);
  const rows = (
    poolCases.cases as {
      name: string;
      block: number;
      pool: string;
      decimals: number[];
      balances: string[];
      totalSupply: string;
      A: string;
      gamma?: string;
      D?: string;
      price_scale?: string[];
      mid_fee?: string;
      out_fee?: string;
      fee_gamma?: string;
      fee: string;
      withdraw: string[];
    }[]
  ).filter((r) => NG_POOLS.has(r.pool));

  it("covers every Tricrypto-NG row", () => {
    expect(rows.length).toBe(4);
  });

  for (const r of rows) {
    it(`${r.name} @${r.block}`, () => {
      const params: tricryptoNg.TricryptoNgParams = {
        A: BigInt(r.A),
        gamma: BigInt(r.gamma!),
        D: BigInt(r.D!),
        midFee: BigInt(r.mid_fee!),
        outFee: BigInt(r.out_fee!),
        feeGamma: BigInt(r.fee_gamma!),
        priceScales: big(r.price_scale!) as [bigint, bigint],
        balances: big(r.balances) as [bigint, bigint, bigint],
        precisions: r.decimals.map((d) => 10n ** BigInt(18 - d)) as [bigint, bigint, bigint],
        totalSupply: BigInt(r.totalSupply),
      };
      expect(tricryptoNg.fee(params)).toBe(BigInt(r.fee));
      for (let i = 0; i < 3; i++) {
        expect(tricryptoNg.calcWithdrawOneCoin(params, 10n ** 18n, i)).toBe(BigInt(r.withdraw[i]));
      }
    });
  }
});

describe("Twocrypto-NG (CurveTwocryptoOptimized) on-chain views", () => {
  for (const c of ngCases.twocrypto as NgCase[]) {
    describe(`${c.name} @${c.block}`, () => {
      const params: twocryptoOptimized.TwocryptoOptimizedParams = {
        A: BigInt(c.A),
        gamma: BigInt(c.gamma),
        D: BigInt(c.D),
        midFee: BigInt(c.mid_fee),
        outFee: BigInt(c.out_fee),
        feeGamma: BigInt(c.fee_gamma),
        priceScale: BigInt(c.price_scale as string),
        balances: big(c.balances) as [bigint, bigint],
        precisions: big(c.precisions) as [bigint, bigint],
        totalSupply: BigInt(c.totalSupply),
      };

      it("is the supported implementation", () => {
        expect(() =>
          twocryptoOptimized.assertSupportedImplementation(c.version, c.MATH)
        ).not.toThrow();
      });

      it("fee, get_virtual_price and lp_price", () => {
        expect(twocryptoOptimized.fee(params)).toBe(BigInt(c.fee));
        expect(twocryptoOptimized.getVirtualPrice(params)).toBe(BigInt(c.get_virtual_price));
        expect(
          twocryptoOptimized.lpPrice(BigInt(c.virtual_price), BigInt(c.price_oracle as string))
        ).toBe(BigInt(c.lp_price));
      });

      it("get_dy", () => {
        for (const v of c.get_dy) {
          expect(twocryptoOptimized.getDy(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result));
        }
      });

      it("calc_token_amount", () => {
        for (const v of c.calc_token_amount) {
          expect(
            twocryptoOptimized.calcTokenAmount(params, big(v.amounts) as [bigint, bigint], v.deposit)
          ).toBe(BigInt(v.result));
        }
      });

      it("calc_withdraw_one_coin", () => {
        for (const v of c.calc_withdraw_one_coin) {
          expect(twocryptoOptimized.calcWithdrawOneCoin(params, BigInt(v.tokenAmount), v.i)).toBe(
            BigInt(v.result)
          );
        }
      });

      it("newton_D from balances is within the solver tolerance of stored D", () => {
        const D = twocryptoOptimized.newtonD(params.A, params.gamma, twocryptoOptimized.xp(params));
        const diff = D > params.D ? D - params.D : params.D - D;
        // Stored D comes from the last tweak; it equals newton_D of the
        // balances up to that solve's tolerance unless fees accrued since.
        expect(diff * 1000n).toBeLessThan(params.D);
      });
    });
  }

  it("rejects other implementations", () => {
    expect(() => twocryptoOptimized.assertSupportedImplementation("v3.0.0")).toThrow("unsupported");
    expect(() =>
      twocryptoOptimized.assertSupportedImplementation(
        "v2.1.0",
        "0x79839c2D74531A8222C0F555865aAc1834e82e51"
      )
    ).toThrow("unsupported MATH");
  });
});

describe("NG helpers", () => {
  const t = (ngCases.tricrypto as NgCase[])[0];
  const tri: tricryptoNg.TricryptoNgParams = {
    A: BigInt(t.A),
    gamma: BigInt(t.gamma),
    D: BigInt(t.D),
    midFee: BigInt(t.mid_fee),
    outFee: BigInt(t.out_fee),
    feeGamma: BigInt(t.fee_gamma),
    priceScales: big(t.price_scale as string[]) as [bigint, bigint],
    balances: big(t.balances) as [bigint, bigint, bigint],
    precisions: big(t.precisions) as [bigint, bigint, bigint],
    totalSupply: BigInt(t.totalSupply),
  };
  const w = (ngCases.twocrypto as NgCase[])[0];
  const two: twocryptoOptimized.TwocryptoOptimizedParams = {
    A: BigInt(w.A),
    gamma: BigInt(w.gamma),
    D: BigInt(w.D),
    midFee: BigInt(w.mid_fee),
    outFee: BigInt(w.out_fee),
    feeGamma: BigInt(w.fee_gamma),
    priceScale: BigInt(w.price_scale as string),
    balances: big(w.balances) as [bigint, bigint],
    precisions: big(w.precisions) as [bigint, bigint],
    totalSupply: BigInt(w.totalSupply),
  };

  it("tricrypto get_dx inverts get_dy", () => {
    const dy = tri.balances[2] / 1000n;
    const dx = tricryptoNg.getDx(tri, 0, 2, dy);
    expect(tricryptoNg.getDy(tri, 0, 2, dx)).toBeGreaterThanOrEqual(dy - dy / 10n ** 6n);
  });

  it("balanced remove_liquidity pays amount - 1 pro rata, or everything", () => {
    const s = tri.totalSupply!;
    expect(tricryptoNg.calcRemoveLiquidity(tri, s / 10n)).toEqual(
      tri.balances.map((b) => (b * (s / 10n - 1n)) / s)
    );
    expect(tricryptoNg.calcRemoveLiquidity(tri, s)).toEqual(tri.balances);
    const s2 = two.totalSupply!;
    expect(twocryptoOptimized.calcRemoveLiquidity(two, s2 / 10n)).toEqual(
      two.balances.map((b) => (b * (s2 / 10n - 1n)) / s2)
    );
    expect(twocryptoOptimized.calcRemoveLiquidity(two, s2)).toEqual(two.balances);
    expect(twocryptoOptimized.calcRemoveLiquidity(two, 0n)).toEqual([0n, 0n]);
  });

  it("twocrypto fee helpers are consistent with the quotes", () => {
    const dx = two.balances[0] / 100n;
    const fee = twocryptoOptimized.calcFeeGetDy(two, 0, 1, dx);
    expect(fee).toBeGreaterThan(0n);
    const amounts: [bigint, bigint] = [two.balances[0] / 100n, 0n];
    expect(twocryptoOptimized.calcFeeTokenAmount(two, amounts, true)).toBeGreaterThan(1n);
    // The views charge the fee at pre-withdrawal xp; the pool at adjusted xp
    const pool = twocryptoOptimized.calcWithdrawOneCoin(two, two.totalSupply! / 20n, 0);
    const views = twocryptoOptimized.calcWithdrawOneCoinViews(two, two.totalSupply! / 20n, 0);
    expect(pool).not.toBe(views);
  });

  it("ramping pools re-solve D from the balances", () => {
    const ramping = { ...two, D: 1n, isRamping: true };
    const D = twocryptoOptimized.newtonD(two.A, two.gamma, twocryptoOptimized.xp(two));
    expect(twocryptoOptimized.getDy(ramping, 0, 1, 10n ** 18n)).toBe(
      twocryptoOptimized.getDy({ ...two, D }, 0, 1, 10n ** 18n)
    );
  });

  it("validates inputs", () => {
    expect(() => twocryptoOptimized.getDy(two, 0, 0, 1n)).toThrow("coin index out of range");
    expect(() => twocryptoOptimized.getDy(two, 0, 1, 0n)).toThrow("do not exchange 0 coins");
    expect(() => twocryptoOptimized.calcWithdrawOneCoin(two, two.totalSupply! + 1n, 0)).toThrow(
      "more than supply"
    );
    expect(() => twocryptoOptimized.getVirtualPrice({ ...two, totalSupply: undefined })).toThrow(
      "totalSupply is required"
    );
    expect(() =>
      twocryptoOptimized.calcTokenAmount(two, [two.balances[0] + 1n, 0n], false)
    ).toThrow("exceeds pool balance");
    expect(() => twocryptoOptimized.newtonD(1n, two.gamma, [10n ** 18n, 10n ** 18n])).toThrow(
      "unsafe values A"
    );
  });
});

describe("Tricrypto-NG lp_price", () => {
  it("matches chain when the stored oracle equals the price_oracle view (TriCRV)", () => {
    const c = (ngCases.tricrypto as NgCase[]).find((x) => x.name === "TriCRV")!;
    const oracle = big(c.price_oracle as string[]) as [bigint, bigint];
    expect(tricryptoNg.lpPrice(BigInt(c.virtual_price), oracle)).toBe(BigInt(c.lp_price));
  });
});
