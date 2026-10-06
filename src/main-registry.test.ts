/**
 * Fixture replay of main-registry StableSwap pools (plain, lending and
 * rate-token) against on-chain views at block 26132000, to the wei.
 */
import { describe, it, expect } from "vitest";
import * as stableswapExact from "./stableswap-exact";
import data from "./__fixtures__/main-registry-cases.json";

interface MainCase {
  pool: string;
  name: string;
  variant: string;
  decimals: number[];
  balances: string[];
  A: string;
  A_precise: string | null;
  fee: string;
  offpeg_fee_multiplier: string | null;
  totalSupply: string;
  get_virtual_price: string | null;
  cwo: { amt: string; i: number; r: string | null }[];
  cta: { amounts: string[]; dep: string | null };
  get_dy: { dx: string; r: string | null };
  rateInputs?: {
    kind: string;
    tokens?: { exchangeRateStored: string; supplyRatePerBlock: string; accrualBlockNumber: string }[];
    pricePerFullShare?: string[];
    underlyingPrecisionMul?: string[];
    getExchangeRate?: string;
    ratio?: string;
    stored_rates?: string[];
  };
}

function rates(c: MainCase): bigint[] {
  const plain = stableswapExact.computeRates(c.decimals);
  const r = c.rateInputs;
  if (!r) return plain;
  switch (r.kind) {
    case "compound":
      return plain.map((v, i) =>
        i < r.tokens!.length
          ? stableswapExact.compoundRate(
              BigInt(r.tokens![i].exchangeRateStored),
              BigInt(r.tokens![i].supplyRatePerBlock),
              BigInt(r.tokens![i].accrualBlockNumber),
              BigInt(data.block),
              BigInt(r.underlyingPrecisionMul![i])
            )
          : v
      );
    case "yearn":
      return plain.map((v, i) =>
        i < r.pricePerFullShare!.length
          ? stableswapExact.yearnRate(BigInt(r.pricePerFullShare![i]), BigInt(r.underlyingPrecisionMul![i]))
          : v
      );
    case "reth":
      return [10n ** 18n, BigInt(r.getExchangeRate!)];
    case "aeth":
      return [10n ** 18n, stableswapExact.ankrAethRate(BigInt(r.ratio!))];
    case "stored_rates":
      return r.stored_rates!.map((x) => BigInt(x));
    default:
      throw new Error(`unknown rate kind ${r.kind}`);
  }
}

describe("main-registry StableSwap pools", () => {
  for (const c of data.cases as MainCase[]) {
    it(c.name, () => {
      const A = BigInt(c.A);
      const noSubtractOne = c.rateInputs?.kind === "reth" || c.rateInputs?.kind === "aeth";
      const params: stableswapExact.StableLiquidityParams = {
        variant: c.variant as stableswapExact.StableSwapVariant,
        balances: c.balances.map((x) => BigInt(x)),
        rates: rates(c),
        A,
        ampPrecise: c.A_precise ? BigInt(c.A_precise) : A,
        ampPrecision: c.A_precise ? 100n : 1n,
        fee: BigInt(c.fee),
        offpegFeeMultiplier: c.offpeg_fee_multiplier ? BigInt(c.offpeg_fee_multiplier) : 0n,
        totalSupply: BigInt(c.totalSupply),
        getDySubtractOne: noSubtractOne ? false : undefined,
      };
      let checked = 0;
      if (c.get_virtual_price) {
        expect(stableswapExact.getVirtualPriceExact(params)).toBe(BigInt(c.get_virtual_price));
        checked++;
      }
      for (const v of c.cwo) {
        if (v.r === null) continue;
        expect(stableswapExact.calcWithdrawOneCoinExact(params, BigInt(v.amt), v.i)[0]).toBe(BigInt(v.r));
        checked++;
      }
      if (c.cta.dep) {
        expect(stableswapExact.calcTokenAmountExact(params, c.cta.amounts.map((x) => BigInt(x)), true)).toBe(
          BigInt(c.cta.dep)
        );
        checked++;
      }
      if (c.get_dy.r) {
        expect(stableswapExact.getDyVariant(params, 0, 1, BigInt(c.get_dy.dx))).toBe(BigInt(c.get_dy.r));
        checked++;
      }
      expect(checked).toBeGreaterThan(1);
    });
  }

  it("rate helpers", () => {
    expect(stableswapExact.compoundRate(10n ** 18n, 10n ** 9n, 100n, 100n, 1n)).toBe(10n ** 18n);
    expect(stableswapExact.compoundRate(10n ** 18n, 10n ** 9n, 100n, 110n, 10n ** 12n)).toBe(
      (10n ** 18n + 10n ** 10n) * 10n ** 12n
    );
    expect(stableswapExact.yearnRate(2n * 10n ** 18n, 10n ** 12n)).toBe(2n * 10n ** 30n);
    expect(stableswapExact.ankrAethRate(5n * 10n ** 17n)).toBe(2n * 10n ** 18n);
    expect(() => stableswapExact.ankrAethRate(0n)).toThrow("ratio cannot be zero");
  });
});
