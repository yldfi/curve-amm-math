/**
 * Lending and rate-token pools replayed at blocks when they were active
 * (compound rates accruing, yearn v1 live, aave live), and the old deposit
 * zaps' calc_withdraw_one_coin. Every value must match to the wei.
 */
import { describe, it, expect } from "vitest";
import * as stableswapExact from "./stableswap-exact";
import * as lendingZap from "./lending-zap";
import data from "./__fixtures__/lending-pools-historical.json";

interface HistCase {
  name: string;
  block: number;
  kind: string;
  useLending: boolean[] | null;
  decimals: number[];
  underlying_decimals?: number[];
  balances: string[];
  A: string;
  A_precise: string | null;
  fee: string;
  offpeg_fee_multiplier: string | null;
  totalSupply: string;
  get_virtual_price: string;
  tokens?: ({ exchangeRateStored: string; supplyRatePerBlock: string; accrualBlockNumber: string } | null)[];
  pricePerFullShare?: (string | null)[];
  getExchangeRate?: string;
  ratio?: string;
  stored_rates?: string[];
  cta: { amounts: string[]; dep: string };
  cta_w: { amounts: string[]; r: string };
  get_dy: { i: number; j: number; dx: string; r: string }[];
  cwo: { amt: string; i: number; r: string | null }[];
  zap_cwo?: { amt: string; i: number; r: string }[];
}

const big = (xs: readonly string[]) => xs.map((x) => BigInt(x));
// yearn-era pools and the rETH / aETH pools compute get_dy without the -1
const NO_SUBTRACT_ONE = new Set(["y", "busd", "reth", "aeth"]);

describe("lending and rate-token pools at active blocks", () => {
  for (const c of data.cases as HistCase[]) {
    describe(`${c.name} @${c.block}`, () => {
      const pmU = (c.underlying_decimals ?? c.decimals).map((d) => 10n ** BigInt(18 - d));
      let rates = stableswapExact.computeRates(c.decimals);
      if (c.tokens) {
        rates = rates.map((v, k) =>
          c.tokens![k]
            ? stableswapExact.compoundRate(
                BigInt(c.tokens![k]!.exchangeRateStored),
                BigInt(c.tokens![k]!.supplyRatePerBlock),
                BigInt(c.tokens![k]!.accrualBlockNumber),
                BigInt(c.block),
                pmU[k]
              )
            : v
        );
      }
      if (c.pricePerFullShare) {
        rates = rates.map((v, k) =>
          c.pricePerFullShare![k] ? stableswapExact.yearnRate(BigInt(c.pricePerFullShare![k]!), pmU[k]) : v
        );
      }
      if (c.getExchangeRate) rates = [10n ** 18n, BigInt(c.getExchangeRate)];
      if (c.ratio) rates = [10n ** 18n, stableswapExact.ankrAethRate(BigInt(c.ratio))];
      if (c.stored_rates) rates = big(c.stored_rates);
      const A = BigInt(c.A);
      const params: stableswapExact.StableLiquidityParams = {
        variant: c.kind === "aave" ? "aave" : "legacy",
        balances: big(c.balances),
        rates,
        A,
        ampPrecise: c.A_precise ? BigInt(c.A_precise) : A,
        ampPrecision: c.A_precise ? 100n : 1n,
        fee: BigInt(c.fee),
        offpegFeeMultiplier: c.offpeg_fee_multiplier ? BigInt(c.offpeg_fee_multiplier) : 0n,
        totalSupply: BigInt(c.totalSupply),
        getDySubtractOne: NO_SUBTRACT_ONE.has(c.name) ? false : undefined,
      };

      it("pool views", () => {
        expect(stableswapExact.getVirtualPriceExact(params)).toBe(BigInt(c.get_virtual_price));
        expect(stableswapExact.calcTokenAmountExact(params, big(c.cta.amounts), true)).toBe(BigInt(c.cta.dep));
        expect(stableswapExact.calcTokenAmountExact(params, big(c.cta_w.amounts), false)).toBe(BigInt(c.cta_w.r));
        for (const v of c.get_dy) {
          expect(stableswapExact.getDyVariant(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.r));
        }
        for (const v of c.cwo) {
          if (v.r === null) continue;
          expect(stableswapExact.calcWithdrawOneCoinExact(params, BigInt(v.amt), v.i)[0]).toBe(BigInt(v.r));
        }
      });

      if (c.zap_cwo) {
        it("deposit zap calc_withdraw_one_coin", () => {
          const zap: lendingZap.LendingZapParams = {
            balances: big(c.balances),
            A,
            fee: BigInt(c.fee),
            totalSupply: BigInt(c.totalSupply),
            precisionMul: pmU,
            useLending: c.useLending!,
            rates: c.useLending!.map((l, k) =>
              !l
                ? 10n ** 18n
                : c.pricePerFullShare
                  ? BigInt(c.pricePerFullShare[k]!)
                  : BigInt(c.tokens![k]!.exchangeRateStored)
            ),
          };
          for (const v of c.zap_cwo!) {
            expect(lendingZap.calcWithdrawOneCoin(zap, BigInt(v.amt), v.i)).toBe(BigInt(v.r));
          }
          const out = lendingZap.removeLiquidityOneCoinWrapped(zap, BigInt(c.zap_cwo![0].amt), 0, zap.rates);
          expect(out.dy).toBe(BigInt(c.zap_cwo![0].r));
          expect(out.wrappedAmount).toBe(
            c.useLending![0] ? (out.dy * 10n ** 18n) / zap.rates[0] : out.dy
          );
        });
      }
    });
  }

  it("validates inputs", () => {
    const zap: lendingZap.LendingZapParams = {
      balances: [1n, 1n],
      A: 100n,
      fee: 0n,
      totalSupply: 0n,
      precisionMul: [1n, 1n],
      useLending: [false, false],
      rates: [0n, 0n],
    };
    expect(() => lendingZap.calcWithdrawOneCoin(zap, 1n, 2)).toThrow("out of bounds");
    expect(() => lendingZap.calcWithdrawOneCoin(zap, 1n, 0)).toThrow("totalSupply cannot be zero");
    expect(() => lendingZap.calcWithdrawOneCoin({ ...zap, totalSupply: 1n }, 2n, 0)).toThrow("exceeds totalSupply");
  });
});
