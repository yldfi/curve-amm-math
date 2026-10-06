/**
 * calcExchangeExact against real swaps that were the only pool event in
 * their block: amount out and the pool's balances() after the block.
 */
import { describe, it, expect } from "vitest";
import * as stableswapExact from "./stableswap-exact";
import data from "./__fixtures__/exchange-cases.json";

// stETH transfers round shares, moving the pool's balanceOf by 1-2 wei
const REBASING_TOLERANCE: Record<string, number[]> = { plain2balances: [2, 0] };

describe("calcExchangeExact vs on-chain swaps", () => {
  for (const s of data.cases) {
    it(`${s.name} @${s.block} (${s.i} → ${s.j})`, () => {
      const b = s.before;
      const A = BigInt(b.A);
      const params: stableswapExact.StableLiquidityParams = {
        variant: s.variant as stableswapExact.StableSwapVariant,
        balances: b.balances.map((x) => BigInt(x)),
        rates: stableswapExact.computeRates(s.decimals),
        A,
        ampPrecise: b.A_precise ? BigInt(b.A_precise) : A,
        ampPrecision: b.A_precise ? 100n : 1n,
        fee: BigInt(b.fee),
        offpegFeeMultiplier: 0n,
        totalSupply: 1n,
        adminFee: BigInt(b.admin_fee),
      };
      const r = stableswapExact.calcExchangeExact(params, s.i, s.j, BigInt(s.dx));
      expect(r.dy).toBe(BigInt(s.dy));
      const tol = REBASING_TOLERANCE[s.name] ?? [];
      r.balances.forEach((v, k) => {
        const diff = v - BigInt(s.after.balances[k]);
        const abs = diff < 0n ? -diff : diff;
        expect(abs).toBeLessThanOrEqual(BigInt(tol[k] ?? 0));
      });
    });
  }

  it("3pool's exchange can pay 1 wei different from its get_dy view", () => {
    const s = data.cases.find((c) => c.name === "3pool" && c.block === 26133163)!;
    const params: stableswapExact.StableLiquidityParams = {
      variant: "legacy",
      balances: s.before.balances.map((x) => BigInt(x)),
      rates: stableswapExact.computeRates(s.decimals),
      A: BigInt(s.before.A),
      ampPrecision: 1n,
      fee: BigInt(s.before.fee),
      offpegFeeMultiplier: 0n,
      totalSupply: 1n,
    };
    const quote = stableswapExact.getDyVariant(params, s.i, s.j, BigInt(s.dx));
    expect(quote).toBe(BigInt(s.dy) + 1n);
    expect(() =>
      stableswapExact.calcExchangeExact({ ...params, variant: "aave" }, 0, 1, 1n)
    ).toThrow("aave pools are not supported");
  });
});
