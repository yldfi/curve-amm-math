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
import cryptoMetaCases from "./__fixtures__/crypto-metapool-cases.json";
import cvxCrvTx from "./__fixtures__/cryptoswap-v1-tx-26108142.json";
import ngZapTx from "./__fixtures__/ng-metapool-zap-tx-26058305.json";
import cryptoRemoveTx from "./__fixtures__/crypto-metapool-zap-remove-tx-26017270.json";

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

describe("crypto metapools: crypto-meta zap views", () => {
  for (const c of cryptoMetaCases.cases as {
    pool: string;
    base: string;
    A: string;
    gamma: string;
    D: string;
    mid_fee: string;
    out_fee: string;
    fee_gamma: string;
    price_scale: string;
    balances: string[];
    totalSupply: string;
    coin0_decimals: number;
    zap_get_dy: { i: number; j: number; dx: string; r: string }[];
    zap_calc_token_amount: { amounts: string[]; r: string }[];
    zap_calc_withdraw_one_coin: { amt: string; i: number; r: string }[];
  }[]) {
    it(`${c.pool} (${c.base})`, () => {
      const params: metapool.CryptoMetapoolParams = {
        meta: {
          A: BigInt(c.A),
          gamma: BigInt(c.gamma),
          D: BigInt(c.D),
          midFee: BigInt(c.mid_fee),
          outFee: BigInt(c.out_fee),
          feeGamma: BigInt(c.fee_gamma),
          priceScale: BigInt(c.price_scale),
          balances: big(c.balances) as [bigint, bigint],
          precisions: [10n ** BigInt(18 - c.coin0_decimals), 1n],
        },
        metaTotalSupply: BigInt(c.totalSupply),
        base: BASES[c.base],
      };
      for (const v of c.zap_get_dy) {
        expect(metapool.cryptoGetDyUnderlying(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.r));
      }
      for (const v of c.zap_calc_token_amount) {
        expect(metapool.cryptoCalcTokenAmountUnderlying(params, big(v.amounts))).toBe(BigInt(v.r));
      }
      for (const v of c.zap_calc_withdraw_one_coin) {
        expect(metapool.cryptoCalcWithdrawOneCoinUnderlying(params, BigInt(v.amt), v.i)).toBe(BigInt(v.r));
      }
    });
  }

  it("reproduces tx 0xd4b4a8f9…: 46.4069 USDC through the FRAXBP zap mints 54.89 LP", () => {
    const f = (liquidityCases.cases as (LiquidityCase & { pool: string })[]).find(
      (x) => x.name === "FRAXBP" && x.block === 26108141
    )!;
    const s = cvxCrvTx.state;
    const params: metapool.CryptoMetapoolParams = {
      meta: {
        A: BigInt(s.A),
        gamma: BigInt(s.gamma),
        D: BigInt(s.D),
        midFee: BigInt(s.midFee),
        outFee: BigInt(s.outFee),
        feeGamma: BigInt(s.feeGamma),
        priceScale: BigInt(s.priceScale),
        balances: big(s.balances) as [bigint, bigint],
        precisions: [1n, 1n],
      },
      metaTotalSupply: BigInt(s.totalSupply),
      base: {
        variant: "legacy",
        balances: big(f.balances),
        rates: big(f.rates),
        A: BigInt(f.A),
        ampPrecise: BigInt(f.ampPrecise),
        ampPrecision: BigInt(f.ampPrecision),
        fee: BigInt(f.fee),
        offpegFeeMultiplier: 0n,
        totalSupply: BigInt(f.totalSupply),
      },
    };
    expect(metapool.cryptoCalcAddLiquidityUnderlying(params, [0n, 0n, 46406901n])).toBe(
      BigInt(cvxCrvTx.txResult.addLiquidity.minted)
    );
    expect(() => metapool.cryptoGetDyUnderlying(params, 1, 1, 1n)).toThrow("must differ");
    expect(() => metapool.cryptoCalcTokenAmountUnderlying(params, [1n])).toThrow("every base coin");
  });
});

describe("zap transactions through NG and crypto metapools", () => {
  it("tx 0x84848e48…: USDT → NG base → USD1 NG metapool, then back out (after a same-block swap)", () => {
    const P = (c: typeof ngZapTx.base): stableswapExact.StableLiquidityParams => ({
      variant: "ng",
      balances: big(c.balances),
      rates: big(c.stored_rates),
      A: BigInt(c.A),
      ampPrecise: BigInt(c.A_precise),
      ampPrecision: 100n,
      fee: BigInt(c.fee),
      offpegFeeMultiplier: BigInt(c.offpeg_fee_multiplier),
      totalSupply: BigInt(c.totalSupply),
    });
    const base0 = P(ngZapTx.base);
    const meta0 = P(ngZapTx.meta);
    const r = ngZapTx.result;

    // tx index 14 swapped on the base pool first
    const s = ngZapTx.priorSwap;
    const swap = stableswapExact.calcExchangeExact(base0, s.i, s.j, BigInt(s.dx));
    expect(swap.dy).toBe(BigInt(s.dy));
    expect(swap.dy).toBe(stableswapExact.getDyVariant(base0, s.i, s.j, BigInt(s.dx)));

    const base = { ...base0, balances: swap.balances };
    const meta = { ...meta0, rates: [meta0.rates[0], stableswapExact.getVirtualPriceExact(base)] };
    const amounts = big(r.amounts);
    const b = stableswapExact.calcAddLiquidityExact(base, amounts.slice(1));
    expect(b.lpAmount).toBe(BigInt(r.baseMinted));
    expect(metapool.calcAddLiquidityUnderlying({ meta, base }, amounts)).toBe(BigInt(r.metaMinted));

    const baseAfter = { ...base, balances: b.balances, totalSupply: b.totalSupply };
    const vpAfter = stableswapExact.getVirtualPriceExact(baseAfter);
    const m = stableswapExact.calcAddLiquidityExact({ ...meta, rates: [meta.rates[0], vpAfter] }, [0n, b.lpAmount]);
    const metaAfter = { ...meta, rates: [meta.rates[0], vpAfter], balances: m.balances, totalSupply: m.totalSupply };
    const lpOut = stableswapExact.calcWithdrawOneCoinExact(metaAfter, m.lpAmount, 1)[0];
    expect(lpOut).toBe(BigInt(r.metaWithdrawBaseLp));
    expect(stableswapExact.calcWithdrawOneCoinExact(baseAfter, lpOut, 0)[0]).toBe(BigInt(r.baseWithdrawUsdc));
  });

  it("tx 0x37e3e3c7…: crypto-meta zap remove_liquidity_one_coin into USDC", () => {
    const d = cryptoRemoveTx;
    const params: metapool.CryptoMetapoolParams = {
      meta: {
        A: BigInt(d.meta.A),
        gamma: BigInt(d.meta.gamma),
        D: BigInt(d.meta.D),
        midFee: BigInt(d.meta.mid_fee),
        outFee: BigInt(d.meta.out_fee),
        feeGamma: BigInt(d.meta.fee_gamma),
        priceScale: BigInt(d.meta.price_scale),
        balances: big(d.meta.balances) as [bigint, bigint],
        precisions: [10n ** BigInt(18 - d.meta.coin0_decimals), 1n],
      },
      metaTotalSupply: BigInt(d.meta.totalSupply),
      base: {
        variant: "legacy",
        balances: big(d.base.balances),
        rates: [10n ** 18n, 10n ** 30n],
        A: BigInt(d.base.A),
        ampPrecise: BigInt(d.base.A_precise),
        ampPrecision: 100n,
        fee: BigInt(d.base.fee),
        offpegFeeMultiplier: 0n,
        totalSupply: BigInt(d.base.totalSupply),
      },
    };
    expect(
      metapool.cryptoRemoveLiquidityOneCoinUnderlying(params, BigInt(d.result.burn), d.result.i)
    ).toBe(BigInt(d.result.coinOut));
  });
});
