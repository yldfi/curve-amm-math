/**
 * Fixture replay of metapools against on-chain views at a pinned block, and
 * of a factory-zap add_liquidity tx. Every value must match to the wei.
 */
import { describe, it, expect } from "vitest";
import * as stableswapExact from "./stableswap-exact";
import * as metapool from "./metapool";
import metaCases from "./__fixtures__/metapool-cases.json";
import liquidityCases from "./__fixtures__/stableswap-liquidity-cases.json";
import zapTx from "./__fixtures__/metapool-zap-tx-26119731.json";

const big = (xs: readonly string[]) => xs.map((x) => BigInt(x));

interface LiquidityCase {
  name: string;
  block: number;
  variant: string;
  balances: string[];
  rates: string[];
  A: string;
  ampPrecise: string;
  ampPrecision: string;
  fee: string;
  offpeg_fee_multiplier: string;
  totalSupply: string;
}
function liquidityParams(name: string): stableswapExact.StableLiquidityParams {
  const c = (liquidityCases.cases as LiquidityCase[]).find((x) => x.name === name && x.block === 26132000)!;
  return {
    variant: c.variant as stableswapExact.StableSwapVariant,
    balances: big(c.balances),
    rates: big(c.rates),
    A: BigInt(c.A),
    ampPrecise: BigInt(c.ampPrecise),
    ampPrecision: BigInt(c.ampPrecision),
    fee: BigInt(c.fee),
    offpegFeeMultiplier: BigInt(c.offpeg_fee_multiplier),
    totalSupply: BigInt(c.totalSupply),
  };
}

const threePool = liquidityParams("3pool");
const ngBase = liquidityParams("USDC/USDT-ng");
const fraxbp: stableswapExact.StableLiquidityParams = {
  variant: "legacy",
  balances: big(metaCases.fraxbp.balances),
  rates: [10n ** 18n, 10n ** 30n],
  A: BigInt(metaCases.fraxbp.A),
  ampPrecise: BigInt(metaCases.fraxbp.A_precise),
  ampPrecision: 100n,
  fee: BigInt(metaCases.fraxbp.fee),
  offpegFeeMultiplier: 0n,
  totalSupply: BigInt(metaCases.fraxbp.totalSupply),
};
const BASES: Record<string, stableswapExact.StableLiquidityParams> = {
  "3pool": threePool,
  fraxbp,
  "usdc-usdt-ng": ngBase,
};

describe("base pool get_dy (rounding order per family)", () => {
  it("3pool scales before charging the fee", () => {
    for (const v of metaCases.threepool_get_dy) {
      expect(stableswapExact.getDyVariant(threePool, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.r));
    }
  });
  it("FRAXBP charges the fee first", () => {
    for (const v of metaCases.fraxbp.get_dy) {
      expect(stableswapExact.getDyVariant(fraxbp, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.r));
    }
    expect(stableswapExact.getVirtualPriceExact(fraxbp)).toBe(BigInt(metaCases.fraxbp.vp));
  });
});

interface MetaCase {
  name: string;
  base: string;
  blockTimestamp: string;
  balances: string[];
  A: string;
  A_precise: string | null;
  fee: string;
  offpeg_fee_multiplier: string | null;
  totalSupply: string;
  get_virtual_price: string;
  base_virtual_price: string | null;
  base_cache_updated: string | null;
  stored_rates?: string[] | null;
  coin0_decimals: number;
  cta: { amounts: string[]; dep: boolean; r: string }[];
  cwo: { amt: string; i: number; r: string }[];
  get_dy: { i: number; j: number; dx: string; r: string }[];
  get_dy_underlying: { i: number; j: number; dx: string; r: string }[];
  zap?: {
    calc_token_amount: { amounts: string[]; dep: boolean; r: string }[];
    calc_withdraw_one_coin: { amt: string; i: number; r: string }[];
    get_dy_underlying_basebase: { i: number; j: number; dx: string; r: string }[];
  };
}

describe("metapools: pool-level and underlying views", () => {
  for (const c of metaCases.cases as MetaCase[]) {
    describe(c.name, () => {
      const base = BASES[c.base];
      let baseVp = stableswapExact.getVirtualPriceExact(base);
      // old main-registry metapools cache the base virtual price for 10 minutes
      if (c.base_virtual_price && BigInt(c.base_cache_updated!) + 600n >= BigInt(c.blockTimestamp)) {
        baseVp = BigInt(c.base_virtual_price);
      }
      const ng = !!c.stored_rates;
      const meta: stableswapExact.StableLiquidityParams = {
        variant: ng ? "ng" : "legacy",
        balances: big(c.balances),
        rates: ng ? big(c.stored_rates!) : [10n ** BigInt(36 - c.coin0_decimals), baseVp],
        A: BigInt(c.A),
        ampPrecise: BigInt(c.A_precise ?? c.A),
        ampPrecision: c.A_precise ? 100n : 1n,
        fee: BigInt(c.fee),
        offpegFeeMultiplier: c.offpeg_fee_multiplier ? BigInt(c.offpeg_fee_multiplier) : 0n,
        totalSupply: BigInt(c.totalSupply),
      };
      const params = { meta, base };

      it("get_virtual_price, calc_token_amount, calc_withdraw_one_coin, get_dy", () => {
        expect(stableswapExact.getVirtualPriceExact(meta)).toBe(BigInt(c.get_virtual_price));
        for (const v of c.cta) {
          expect(stableswapExact.calcTokenAmountExact(meta, big(v.amounts), v.dep)).toBe(BigInt(v.r));
        }
        for (const v of c.cwo) {
          expect(stableswapExact.calcWithdrawOneCoinExact(meta, BigInt(v.amt), v.i)[0]).toBe(BigInt(v.r));
        }
        for (const v of c.get_dy) {
          expect(stableswapExact.getDyVariant(meta, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.r));
        }
      });

      it("get_dy_underlying", () => {
        for (const v of c.get_dy_underlying) {
          expect(metapool.getDyUnderlying(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.r));
        }
      });

      if (c.zap) {
        const zap = c.zap;
        it("factory zap calc_token_amount / calc_withdraw_one_coin", () => {
          for (const v of zap.calc_token_amount) {
            expect(metapool.calcTokenAmountUnderlying(params, big(v.amounts), v.dep)).toBe(BigInt(v.r));
          }
          for (const v of zap.calc_withdraw_one_coin) {
            expect(metapool.calcWithdrawOneCoinUnderlying(params, BigInt(v.amt), v.i)).toBe(BigInt(v.r));
          }
          for (const v of zap.get_dy_underlying_basebase) {
            expect(metapool.getDyUnderlying(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.r));
          }
        });
      }
    });
  }
});

describe("factory zap add_liquidity tx 0x48ae5207…", () => {
  it("reproduces the base and metapool mints (3pool admin_fee = 100%)", () => {
    const base: stableswapExact.StableLiquidityParams = {
      variant: "legacy",
      balances: big(zapTx.base.balances),
      rates: stableswapExact.computeRates([18, 6, 6]),
      A: BigInt(zapTx.base.A),
      ampPrecise: BigInt(zapTx.base.A),
      ampPrecision: 1n,
      fee: BigInt(zapTx.base.fee),
      offpegFeeMultiplier: 0n,
      totalSupply: BigInt(zapTx.base.totalSupply),
      adminFee: 10n ** 10n,
    };
    const meta: stableswapExact.StableLiquidityParams = {
      variant: "legacy",
      balances: big(zapTx.meta.balances),
      rates: [10n ** BigInt(36 - zapTx.meta.coin0_decimals), stableswapExact.getVirtualPriceExact(base)],
      A: BigInt(zapTx.meta.A),
      ampPrecise: BigInt(zapTx.meta.A_precise),
      ampPrecision: 100n,
      fee: BigInt(zapTx.meta.fee),
      offpegFeeMultiplier: 0n,
      totalSupply: BigInt(zapTx.meta.totalSupply),
    };
    const amounts = big(zapTx.result.amounts);
    const b = stableswapExact.calcAddLiquidityExact(base, amounts.slice(1));
    expect(b.lpAmount).toBe(BigInt(zapTx.result.baseMinted));
    expect(b.fees).toEqual(big(zapTx.result.baseFees));
    expect(metapool.calcAddLiquidityUnderlying({ meta, base }, amounts)).toBe(
      BigInt(zapTx.result.metaMinted)
    );
    // With 3pool's real admin fee the base virtual price moves only by the
    // admin-fee rounding; with a wrong 50% default the mint would differ.
    expect(
      metapool.calcAddLiquidityUnderlying({ meta, base: { ...base, adminFee: 5n * 10n ** 9n } }, amounts)
    ).not.toBe(BigInt(zapTx.result.metaMinted));
  });

  it("validates inputs", () => {
    const params = { meta: { ...threePool, balances: [1n, 1n], rates: [10n ** 18n, 10n ** 18n] }, base: threePool };
    expect(() => metapool.getDyUnderlying(params, 0, 0, 1n)).toThrow("invalid indices");
    expect(() => metapool.calcTokenAmountUnderlying(params, [1n], true)).toThrow("every base coin");
    expect(() => metapool.calcWithdrawOneCoinUnderlying(params, 1n, 9)).toThrow("out of bounds");
    expect(() => metapool.calcAddLiquidityUnderlying(params, [1n], true)).toThrow("every base coin");
  });
});
