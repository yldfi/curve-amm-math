/**
 * Fixture replay against tricrypto2 and tricrypto v1 views at pinned blocks
 * (legacy-tricrypto-cases.json). Every value must match to the wei.
 */
import { describe, it, expect } from "vitest";
import * as cryptoswap from "./cryptoswap";
import * as tricryptoLegacy from "./tricrypto-legacy";
import data from "./__fixtures__/legacy-tricrypto-cases.json";

const big = (xs: string[]) => xs.map((x) => BigInt(x));

function stateOf(c: (typeof data.cases)[number]): tricryptoLegacy.TricryptoLegacyState {
  const variant = c.name as tricryptoLegacy.TricryptoLegacyVariant;
  return {
    variant,
    params: {
      A: variant === "tricrypto-v1" ? BigInt(c.A_precise!) * 100n : BigInt(c.A),
      gamma: BigInt(c.gamma),
      D: BigInt(c.D),
      midFee: BigInt(c.mid_fee),
      outFee: BigInt(c.out_fee),
      feeGamma: BigInt(c.fee_gamma),
      priceScales: big(c.price_scale) as [bigint, bigint],
      balances: big(c.balances) as [bigint, bigint, bigint],
      precisions: big(c.precisions) as [bigint, bigint, bigint],
      futureAGammaTime: BigInt(c.future_A_gamma_time),
    },
    totalSupply: BigInt(c.totalSupply),
  };
}

describe("legacy tricrypto views at pinned blocks", () => {
  it("covers both pools at five blocks", () => {
    expect(data.cases.map((c) => `${c.name}@${c.block}`)).toHaveLength(10);
    expect(new Set(data.cases.map((c) => c.pool))).toEqual(
      new Set([tricryptoLegacy.TRICRYPTO2_POOL_ADDRESS, tricryptoLegacy.TRICRYPTO_V1_POOL_ADDRESS])
    );
  });

  for (const c of data.cases) {
    describe(`${c.name} @${c.block}`, () => {
      const state = stateOf(c);

      it("get_dy (all pairs, 1 coin to 50% of the balance)", () => {
        expect(c.get_dy).toHaveLength(24);
        for (const v of c.get_dy) {
          expect(tricryptoLegacy.getDy(state, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result!));
        }
      });

      it("calc_withdraw_one_coin (1e18 to 50% of the supply)", () => {
        expect(c.calc_withdraw_one_coin).toHaveLength(12);
        for (const v of c.calc_withdraw_one_coin) {
          expect(tricryptoLegacy.calcWithdrawOneCoin(state, BigInt(v.tokenAmount), v.i)).toBe(
            BigInt(v.result!)
          );
        }
      });

      it("get_virtual_price", () => {
        expect(tricryptoLegacy.getVirtualPrice(state)).toBe(BigInt(c.get_virtual_price));
      });

      it("getDx is the smallest input that yields the on-chain get_dy", () => {
        for (const v of c.get_dy) {
          const dy = BigInt(v.result!);
          const dx = tricryptoLegacy.getDx(state, v.i, v.j, dy);
          expect(dx).toBeGreaterThan(0n);
          expect(dx).toBeLessThanOrEqual(BigInt(v.dx));
          expect(tricryptoLegacy.getDy(state, v.i, v.j, dx)).toBeGreaterThanOrEqual(dy);
          expect(tricryptoLegacy.getDy(state, v.i, v.j, dx - 1n)).toBeLessThan(dy);
        }
      });
    });
  }
});

describe("tricrypto v1 calc_withdraw_one_coin ignores future_A_gamma_time", () => {
  const c = data.cases.find((x) => x.name === "tricrypto-v1")!;
  const state = stateOf(c);
  // stop_ramp_A_gamma leaves future_A_gamma_time non-zero; v1 still reads D()
  const ramped = { ...state, params: { ...state.params, futureAGammaTime: 1_700_000_000n } };

  it("still matches the view", () => {
    for (const v of c.calc_withdraw_one_coin) {
      expect(tricryptoLegacy.calcWithdrawOneCoin(ramped, BigInt(v.tokenAmount), v.i)).toBe(
        BigInt(v.result!)
      );
    }
  });

  it("uses the stored D when it differs from newton_D(balances)", () => {
    // At the fixture blocks D() equals newton_D(balances); move a balance so they differ
    const b = state.params.balances;
    const drift = (p: typeof state.params) => ({
      ...p,
      balances: [b[0] + b[0] / 100n, b[1], b[2]] as [bigint, bigint, bigint],
    });
    const stored = { ...state, params: drift(state.params) };
    const rampedDrift = { ...ramped, params: drift(ramped.params) };
    const amount = state.totalSupply / 100n;
    const expected = cryptoswap.calcRemoveLiquidityOneCoin3(
      { ...stored.params, futureAGammaTime: 0n }, amount, 0, state.totalSupply
    ).dy;
    const recomputed = cryptoswap.calcRemoveLiquidityOneCoin3(
      rampedDrift.params, amount, 0, state.totalSupply
    ).dy;
    expect(recomputed).not.toBe(expected);
    expect(tricryptoLegacy.calcWithdrawOneCoin(rampedDrift, amount, 0)).toBe(expected);
  });
});
