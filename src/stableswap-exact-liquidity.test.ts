/**
 * Fixture replay of StableSwap liquidity views against on-chain values at
 * pinned blocks (legacy 3pool / FRAXBP, factory plain, StableSwap-NG).
 * Every value must match to the wei.
 */
import { describe, it, expect } from "vitest";
import * as stableswapExact from "./stableswap-exact";
import liquidityCases from "./__fixtures__/stableswap-liquidity-cases.json";
import poolCases from "./__fixtures__/curve-pool-cases.json";

interface LiquidityCase {
  name: string;
  pool: string;
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
  get_virtual_price: string;
  calc_token_amount: { amounts: string[]; isDeposit: boolean; result: string }[];
  calc_withdraw_one_coin: { burnAmount: string; i: number; result: string }[];
  add_liquidity?: { amounts: string[]; minted: string; fees: string[]; totalSupplyAfter: string };
}

const big = (xs: string[]) => xs.map((x) => BigInt(x));

function toParams(c: LiquidityCase): stableswapExact.StableLiquidityParams {
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

describe("stableswapExact liquidity: on-chain views", () => {
  for (const c of liquidityCases.cases as LiquidityCase[]) {
    describe(`${c.name} (${c.variant}) @${c.block}`, () => {
      const params = toParams(c);

      it("get_virtual_price", () => {
        expect(stableswapExact.getVirtualPriceExact(params)).toBe(BigInt(c.get_virtual_price));
      });

      it("calc_token_amount", () => {
        expect(c.calc_token_amount.length).toBeGreaterThan(0);
        for (const v of c.calc_token_amount) {
          expect(
            stableswapExact.calcTokenAmountExact(params, big(v.amounts), v.isDeposit)
          ).toBe(BigInt(v.result));
        }
      });

      it("calc_withdraw_one_coin", () => {
        for (const v of c.calc_withdraw_one_coin) {
          expect(
            stableswapExact.calcWithdrawOneCoinExact(params, BigInt(v.burnAmount), v.i)[0]
          ).toBe(BigInt(v.result));
        }
      });

      if (c.variant !== "legacy") {
        it("add_liquidity mints what calc_token_amount quotes", () => {
          for (const v of c.calc_token_amount.filter((x) => x.isDeposit)) {
            expect(stableswapExact.calcAddLiquidityExact(params, big(v.amounts)).lpAmount).toBe(
              BigInt(v.result)
            );
          }
        });

        it("remove_liquidity_imbalance burns calc_token_amount + 1", () => {
          for (const v of c.calc_token_amount.filter((x) => !x.isDeposit)) {
            expect(
              stableswapExact.calcRemoveLiquidityImbalanceExact(params, big(v.amounts)).lpAmount
            ).toBe(BigInt(v.result) + 1n);
          }
        });
      }

      if (c.add_liquidity) {
        const tx = c.add_liquidity;
        it("reproduces the add_liquidity tx: mint, fees and supply", () => {
          const r = stableswapExact.calcAddLiquidityExact(params, big(tx.amounts));
          expect(r.lpAmount).toBe(BigInt(tx.minted));
          expect(r.fees).toEqual(big(tx.fees));
          expect(r.totalSupply).toBe(BigInt(tx.totalSupplyAfter));
          // Legacy calc_token_amount omits the fee and over-quotes the mint
          expect(stableswapExact.calcTokenAmountExact(params, big(tx.amounts), true)).toBeGreaterThan(
            r.lpAmount
          );
        });
      }
    });
  }
});

describe("stableswapExact liquidity: calc_withdraw_one_coin fixture rows", () => {
  const offpeg: Record<string, bigint> = {
    // offpeg_fee_multiplier() at the row's block
    "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85": 200000000000n,
    "0x13e12bb0e6a2f1a3d6901a59a9d585e89a6243e1": 50000000000n,
  };
  const rows = (
    poolCases.cases as {
      name: string;
      block: number;
      pool: string;
      family: string;
      decimals: number[];
      balances: string[];
      totalSupply: string;
      fee: string;
      A: string;
      A_precise?: string;
      stored_rates?: string[];
      withdraw: string[];
    }[]
  ).filter((r) => r.family !== "crypto");

  it("covers every stable row", () => {
    expect(rows.length).toBe(5);
  });

  for (const r of rows) {
    it(`${r.name} @${r.block}`, () => {
      const legacy = !r.A_precise;
      const params: stableswapExact.StableLiquidityParams = {
        variant: r.family === "stable-ng" ? "ng" : legacy ? "legacy" : "plain",
        balances: big(r.balances),
        rates: r.stored_rates
          ? big(r.stored_rates)
          : stableswapExact.computeRates(r.decimals),
        A: BigInt(r.A),
        ampPrecise: BigInt(r.A_precise ?? r.A),
        ampPrecision: legacy ? 1n : 100n,
        fee: BigInt(r.fee),
        offpegFeeMultiplier: offpeg[r.pool] ?? 0n,
        totalSupply: BigInt(r.totalSupply),
      };
      for (let i = 0; i < r.withdraw.length; i++) {
        expect(stableswapExact.calcWithdrawOneCoinExact(params, 10n ** 18n, i)[0]).toBe(
          BigInt(r.withdraw[i])
        );
      }
    });
  }
});

describe("stableswapExact liquidity: behaviour", () => {
  const base = toParams((liquidityCases.cases as LiquidityCase[])[0]);

  it("balanced remove_liquidity is pro rata, rounded down", () => {
    const out = stableswapExact.calcRemoveLiquidityExact(base, base.totalSupply / 10n);
    expect(out).toEqual(base.balances.map((b) => (b * (base.totalSupply / 10n)) / base.totalSupply));
    expect(() => stableswapExact.calcRemoveLiquidityExact(base, base.totalSupply + 1n)).toThrow(
      "exceeds totalSupply"
    );
  });

  it("first deposit mints D1 without fees", () => {
    const empty = { ...base, balances: [0n, 0n], totalSupply: 0n };
    const r = stableswapExact.calcAddLiquidityExact(empty, [10n ** 21n, 10n ** 9n]);
    expect(r.lpAmount).toBe(
      stableswapExact.getDVariant([10n ** 21n, 10n ** 21n], 150000n, "legacy")
    );
    expect(r.fees).toEqual([0n, 0n]);
  });

  it("the legacy and NG D loops round differently but agree to 1 wei per iteration", () => {
    const xp = [1793298582683232706678995n, 201720921207n * 10n ** 12n];
    const legacy = stableswapExact.getDVariant(xp, 150000n, "legacy");
    const ng = stableswapExact.getDVariant(xp, 150000n, "ng");
    expect(ng).toBe(stableswapExact.getD(xp, 150000n, 2));
    const diff = legacy > ng ? legacy - ng : ng - legacy;
    expect(diff).toBeLessThan(10n);
  });

  it("validates inputs", () => {
    expect(() => stableswapExact.calcAddLiquidityExact(base, [1n])).toThrow("amounts length");
    expect(() => stableswapExact.calcAddLiquidityExact(base, [0n, 0n])).toThrow("D1 must exceed D0");
    expect(() => stableswapExact.calcTokenAmountExact(base, [base.balances[0] + 1n, 0n], false)).toThrow(
      "exceeds pool balance"
    );
    expect(() => stableswapExact.calcWithdrawOneCoinExact(base, 1n, 2)).toThrow("out of bounds");
    expect(() => stableswapExact.calcWithdrawOneCoinExact(base, base.totalSupply + 1n, 0)).toThrow(
      "exceeds totalSupply"
    );
    expect(() => stableswapExact.getVirtualPriceExact({ ...base, totalSupply: 0n })).toThrow(
      "totalSupply cannot be zero"
    );
    expect(() => stableswapExact.getDVariant([1n], 1n, "ng")).toThrow("at least 2 coins");
    expect(() => stableswapExact.getYDVariant(100n, 3, [1n, 1n], 2n)).toThrow("out of bounds");
  });
});
