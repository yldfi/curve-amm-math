/**
 * Pools captured mid A/gamma ramp. The ramp flags must make every on-chain
 * view match to the wei, and leaving them out must not (so the ramp paths
 * are really exercised).
 */
import { describe, it, expect } from "vitest";
import * as cryptoswap from "./cryptoswap";
import * as tricryptoNg from "./tricrypto-ng";
import * as stableswapExact from "./stableswap-exact";
import data from "./__fixtures__/ramp-cases.json";

const big = (xs: readonly string[]) => xs.map((x) => BigInt(x));

describe("Tricrypto-NG mid-ramp (isRamping)", () => {
  for (const s of data.tricryptoNg) {
    it(`${s.name} @${s.block}`, () => {
      expect(BigInt(s.future_A_gamma_time!)).toBeGreaterThan(BigInt(s.blockTimestamp));
      const params = (isRamping: boolean): tricryptoNg.TricryptoNgParams => ({
        A: BigInt(s.A),
        gamma: BigInt(s.gamma),
        D: BigInt(s.D),
        midFee: BigInt(s.mid_fee),
        outFee: BigInt(s.out_fee),
        feeGamma: BigInt(s.fee_gamma),
        priceScales: big(s.price_scale) as [bigint, bigint],
        balances: big(s.balances) as [bigint, bigint, bigint],
        precisions: big(s.precisions) as [bigint, bigint, bigint],
        totalSupply: BigInt(s.totalSupply),
        isRamping,
      });
      const p = params(true);
      let differs = false;
      for (const v of s.get_dy) {
        expect(tricryptoNg.getDy(p, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result!));
        differs ||= tricryptoNg.getDy(params(false), v.i, v.j, BigInt(v.dx)) !== BigInt(v.result!);
      }
      for (const v of s.calc_token_amount) {
        expect(tricryptoNg.calcTokenAmount(p, big(v.amounts), v.deposit)).toBe(BigInt(v.result!));
      }
      for (const v of s.calc_withdraw_one_coin) {
        expect(tricryptoNg.calcWithdrawOneCoin(p, BigInt(v.tokenAmount), v.i)).toBe(BigInt(v.result!));
      }
      expect(tricryptoNg.getVirtualPrice(p)).toBe(BigInt(s.get_virtual_price!));
      expect(differs).toBe(true);
    });
  }
});

describe("tricrypto2 mid-ramp", () => {
  for (const s of data.tricrypto2) {
    it(`@${s.block}`, () => {
      expect(BigInt(s.future_A_gamma_time!)).toBeGreaterThan(BigInt(s.blockTimestamp));
      const p: cryptoswap.TricryptoParams = {
        A: BigInt(s.A),
        gamma: BigInt(s.gamma),
        D: BigInt(s.D),
        midFee: BigInt(s.mid_fee),
        outFee: BigInt(s.out_fee),
        feeGamma: BigInt(s.fee_gamma),
        priceScales: big(s.price_scale) as [bigint, bigint],
        balances: big(s.balances) as [bigint, bigint, bigint],
        precisions: big(s.precisions) as [bigint, bigint, bigint],
        futureAGammaTime: BigInt(s.future_A_gamma_time!),
      };
      const supply = BigInt(s.totalSupply);
      for (const v of s.get_dy) expect(cryptoswap.getDy3(p, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result!));
      for (const v of s.calc_token_amount) {
        expect(
          cryptoswap.calcTokenAmount3(p, big(v.amounts) as [bigint, bigint, bigint], supply, v.deposit)
        ).toBe(BigInt(v.result!));
      }
      for (const v of s.calc_withdraw_one_coin) {
        expect(cryptoswap.calcWithdrawOneCoin3(p, BigInt(v.tokenAmount), v.i, supply)).toBe(BigInt(v.result!));
      }
      expect(cryptoswap.getVirtualPrice3(p, supply)).toBe(BigInt(s.get_virtual_price!));
    });
  }
});

describe("CurveCryptoSwap2 mid-ramp (futureAGammaTime)", () => {
  const s = data.cryptoswap2;
  it(`${s.name} @${s.block}`, () => {
    expect(BigInt(s.future_A_gamma_time)).toBeGreaterThan(BigInt(s.blockTimestamp));
    const params = (futureAGammaTime: bigint): cryptoswap.TwocryptoParams => ({
      A: BigInt(s.A),
      gamma: BigInt(s.gamma),
      D: BigInt(s.D),
      midFee: BigInt(s.mid_fee),
      outFee: BigInt(s.out_fee),
      feeGamma: BigInt(s.fee_gamma),
      priceScale: BigInt(s.price_scale),
      balances: big(s.balances) as [bigint, bigint],
      precisions: s.decimals.map((d) => 10n ** BigInt(18 - d)) as [bigint, bigint],
      futureAGammaTime,
    });
    const p = params(BigInt(s.future_A_gamma_time));
    const supply = BigInt(s.totalSupply);
    for (const v of s.get_dy) {
      expect(cryptoswap.getDy(p, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.r));
      expect(cryptoswap.getDy(params(0n), v.i, v.j, BigInt(v.dx))).not.toBe(BigInt(v.r));
    }
    for (const v of s.cta) {
      expect(cryptoswap.calcTokenAmount(p, big(v.amounts) as [bigint, bigint], supply)).toBe(BigInt(v.r));
    }
    for (const v of s.cwo) {
      expect(cryptoswap.calcWithdrawOneCoin(p, BigInt(v.amt), v.i, supply)).toBe(BigInt(v.r));
    }
    expect(cryptoswap.getVirtualPrice(p, supply)).toBe(BigInt(s.get_virtual_price));
  });
});

describe("StableSwap mid A ramp", () => {
  for (const s of data.stable) {
    it(`${s.name} (${s.variant}) @${s.block}`, () => {
      expect(BigInt(s.future_A_time!)).toBeGreaterThan(BigInt(s.blockTimestamp));
      const rates = s.rates ? big(s.rates) : stableswapExact.computeRates(s.decimals);
      const params: stableswapExact.StableLiquidityParams = {
        variant: s.variant as stableswapExact.StableSwapVariant,
        balances: big(s.balances),
        rates,
        A: BigInt(s.A),
        ampPrecise: BigInt(s.A_precise!),
        ampPrecision: 100n,
        fee: BigInt(s.fee),
        offpegFeeMultiplier: s.offpeg_fee_multiplier ? BigInt(s.offpeg_fee_multiplier) : 0n,
        totalSupply: BigInt(s.totalSupply),
      };
      // mid-ramp A_precise is not A * 100
      expect(BigInt(s.A_precise!)).not.toBe(BigInt(s.A) * 100n);
      expect(stableswapExact.getVirtualPriceExact(params)).toBe(BigInt(s.get_virtual_price));
      for (const v of s.calc_token_amount) {
        expect(stableswapExact.calcTokenAmountExact(params, big(v.amounts), v.isDeposit)).toBe(BigInt(v.result!));
      }
      for (const v of s.calc_withdraw_one_coin) {
        expect(stableswapExact.calcWithdrawOneCoinExact(params, BigInt(v.burnAmount), v.i)[0]).toBe(
          BigInt(v.result!)
        );
      }
    });
  }
});
