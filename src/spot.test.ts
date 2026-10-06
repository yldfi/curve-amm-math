/**
 * Spot-rate and pool-spot value tests: the fee-free marginal rate must equal
 * the limit of a fee-free get_dy secant, and the pool-spot value must bound
 * calc_withdraw_one_coin from above (fixtures and random pools).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as spot from "./spot";
import * as cryptoswap from "./cryptoswap";
import * as stableswapExact from "./stableswap-exact";
import * as tricryptoNg from "./tricrypto-ng";
import poolCases from "./__fixtures__/curve-pool-cases.json";
import txCase from "./__fixtures__/cryptoswap-v1-tx-26108142.json";

interface PoolCase {
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
  gamma?: string;
  D?: string;
  price_scale?: string[];
  mid_fee?: string;
  out_fee?: string;
  fee_gamma?: string;
  withdraw: string[];
}

const big = (xs: readonly string[]) => xs.map((x) => BigInt(x));
const rel = (a: spot.Ratio, b: spot.Ratio) => {
  // |a - b| / b as a float
  const num = a.n * b.d - b.n * a.d;
  return Math.abs(Number((num * 10n ** 18n) / (a.d * b.n))) / 1e18;
};
const OFFPEG: Record<string, bigint> = {
  "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85": 200000000000n,
  "0x13e12bb0e6a2f1a3d6901a59a9d585e89a6243e1": 50000000000n,
};

function stableParams(r: PoolCase): stableswapExact.StableLiquidityParams {
  const legacy = !r.A_precise;
  return {
    variant: r.family === "stable-ng" ? "ng" : legacy ? "legacy" : "plain",
    balances: big(r.balances),
    rates: r.stored_rates ? big(r.stored_rates) : stableswapExact.computeRates(r.decimals),
    A: BigInt(r.A),
    ampPrecise: BigInt(r.A_precise ?? r.A),
    ampPrecision: legacy ? 1n : 100n,
    fee: BigInt(r.fee),
    offpegFeeMultiplier: OFFPEG[r.pool] ?? 0n,
    totalSupply: BigInt(r.totalSupply),
  };
}

function cryptoState(r: PoolCase): spot.CryptoSpotState {
  return {
    A: BigInt(r.A),
    gamma: BigInt(r.gamma!),
    balances: big(r.balances),
    precisions: r.decimals.map((d) => 10n ** BigInt(18 - d)),
    priceScales: big(r.price_scale!),
  };
}

describe("pool-spot value bounds on-chain calc_withdraw_one_coin", () => {
  for (const r of poolCases.cases as PoolCase[]) {
    it(`${r.name} @${r.block}`, () => {
      const supply = BigInt(r.totalSupply);
      for (let i = 0; i < r.withdraw.length; i++) {
        const ub =
          r.family === "crypto"
            ? spot.cryptoSwapLpSpotValue(cryptoState(r), 10n ** 18n, supply, i)
            : spot.stableSwapLpSpotValue(stableParams(r), 10n ** 18n, i);
        const quote = BigInt(r.withdraw[i]);
        expect(quote).toBeLessThanOrEqual(spot.floorRatio(ub));
        // and close to it: the gap is about half the pool fee (up to 2.8%
        // on TricryptoUSDT) plus curvature
        expect(rel(ratioOf(quote), ub)).toBeLessThan(0.02);
      }
    });
  }
});

function ratioOf(x: bigint): spot.Ratio {
  return spot.ratio(x);
}

describe("marginal rate is the limit of the fee-free secant", () => {
  it("CurveCryptoSwap2 (cvxCRV/crvFRAX)", () => {
    const s = txCase.state;
    const params: cryptoswap.TwocryptoParams = {
      A: BigInt(s.A),
      gamma: BigInt(s.gamma),
      D: BigInt(s.D),
      midFee: 0n,
      outFee: 0n,
      feeGamma: BigInt(s.feeGamma),
      priceScale: BigInt(s.priceScale),
      balances: big(s.balances) as [bigint, bigint],
      precisions: [1n, 1n],
    };
    const state: spot.CryptoSpotState = {
      A: params.A,
      gamma: params.gamma,
      balances: params.balances,
      precisions: [1n, 1n],
      priceScales: [params.priceScale],
    };
    for (const [j, i] of [
      [1, 0],
      [0, 1],
    ]) {
      const rate = spot.cryptoSwapMarginalRate(state, j, i);
      const dx = params.balances[j] / 10n ** 7n;
      const secant = spot.ratio(cryptoswap.getDy(params, j, i, dx), dx);
      // the secant sits below the tangent, by ~ curvature * dx / balance
      expect(spot.ratioLessThan(secant, rate)).toBe(true);
      expect(rel(secant, rate)).toBeLessThan(1e-6);
      // rates in both directions are reciprocal
    }
    const r10 = spot.cryptoSwapMarginalRate(state, 1, 0);
    const r01 = spot.cryptoSwapMarginalRate(state, 0, 1);
    expect(r10.n * r01.n).toBe(r10.d * r01.d);
  });

  it("tricrypto2 with mixed decimals", () => {
    const r = (poolCases.cases as PoolCase[]).find(
      (x) => x.pool === "0xd51a44d3fae010294c616388b506acda1bfaae46"
    )!;
    const precisions = r.decimals.map((d) => 10n ** BigInt(18 - d)) as [bigint, bigint, bigint];
    const params: cryptoswap.TricryptoParams = {
      A: BigInt(r.A),
      gamma: BigInt(r.gamma!),
      D: BigInt(r.D!),
      midFee: 0n,
      outFee: 0n,
      feeGamma: BigInt(r.fee_gamma!),
      priceScales: big(r.price_scale!) as [bigint, bigint],
      balances: big(r.balances) as [bigint, bigint, bigint],
      precisions,
    };
    // get_dy swaps on the stored D; take the gradient on that curve
    const state = { ...cryptoState(r), D: params.D };
    for (const [j, i] of [
      [0, 2],
      [2, 1],
      [1, 0],
    ]) {
      const rate = spot.cryptoSwapMarginalRate(state, j, i);
      // 1e-5 of the balance: small enough for curvature (~1e-5 relative),
      // large enough that rounding the 8-decimal WBTC output is negligible
      const dx = params.balances[j] / 10n ** 5n;
      const secant = spot.ratio(cryptoswap.getDy3(params, j, i, dx), dx);
      expect(spot.ratioLessThan(secant, rate)).toBe(true);
      expect(rel(secant, rate)).toBeLessThan(2e-5);
    }
  });

  it("Tricrypto-NG (same invariant)", () => {
    const r = (poolCases.cases as PoolCase[]).find(
      (x) => x.pool === "0xf5f5b97624542d72a9e06f04804bf81baa15e2b4"
    )!;
    const params: tricryptoNg.TricryptoNgParams = {
      A: BigInt(r.A),
      gamma: BigInt(r.gamma!),
      D: BigInt(r.D!),
      midFee: 0n,
      outFee: 0n,
      feeGamma: BigInt(r.fee_gamma!),
      priceScales: big(r.price_scale!) as [bigint, bigint],
      balances: big(r.balances) as [bigint, bigint, bigint],
      precisions: r.decimals.map((d) => 10n ** BigInt(18 - d)) as [bigint, bigint, bigint],
    };
    // Take the gradient on the stored-D curve the pool swaps on
    const state = { ...cryptoState(r), D: params.D };
    const rate = spot.cryptoSwapMarginalRate(state, 2, 0);
    const dx = params.balances[2] / 10n ** 6n;
    const secant = spot.ratio(tricryptoNg.getDy(params, 2, 0, dx), dx);
    expect(spot.ratioLessThan(secant, rate)).toBe(true);
    expect(rel(secant, rate)).toBeLessThan(1e-5);
  });

  it("StableSwap (exact gradient)", () => {
    const r = (poolCases.cases as PoolCase[]).find((x) => x.name === "3CRV")!;
    const params = { ...stableParams(r), fee: 0n };
    const rate = spot.stableSwapMarginalRate(params, 0, 1);
    const dx = params.balances[0] / 10n ** 7n;
    const secant = spot.ratio(
      stableswapExact.getDyExact(0, 1, dx, { ...params, A: BigInt(r.A) }),
      dx
    );
    expect(spot.ratioLessThan(secant, rate)).toBe(true);
    expect(rel(secant, rate)).toBeLessThan(1e-6);
  });
});

describe("pool-spot value property: calc_withdraw_one_coin <= UB", () => {
  const amount = fc.bigInt(10n ** 21n, 10n ** 27n);

  it("StableSwap (legacy, plain, NG; 2 and 3 coins)", () => {
    fc.assert(
      fc.property(
        fc.array(amount, { minLength: 2, maxLength: 3 }),
        fc.constantFrom<stableswapExact.StableSwapVariant>("legacy", "plain", "ng"),
        fc.bigInt(10n, 5000n),
        fc.bigInt(1n, 1000n),
        fc.nat({ max: 2 }),
        (balances, variant, A, burnBps, iRaw) => {
          const max = balances.reduce((a, b) => (a > b ? a : b));
          const min = balances.reduce((a, b) => (a < b ? a : b));
          fc.pre(max / min < 50n);
          const n = balances.length;
          const i = iRaw % n;
          const supply = balances.reduce((a, b) => a + b);
          const params: stableswapExact.StableLiquidityParams = {
            variant,
            balances,
            rates: balances.map(() => 10n ** 18n),
            A,
            fee: 4000000n,
            offpegFeeMultiplier: variant === "ng" ? 2n * 10n ** 10n : 0n,
            totalSupply: supply,
          };
          const lp = (supply * burnBps) / 10000n;
          const [dy] = stableswapExact.calcWithdrawOneCoinExact(params, lp, i);
          const ub = spot.floorRatio(spot.stableSwapLpSpotValue(params, lp, i));
          expect(dy).toBeLessThanOrEqual(ub);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("CryptoSwap (CurveCryptoSwap2)", () => {
    fc.assert(
      fc.property(
        amount,
        fc.integer({ min: 30, max: 300 }),
        fc.bigInt(10n ** 17n, 10n ** 20n),
        fc.bigInt(1n, 500n),
        fc.nat({ max: 1 }),
        (b0, ratioPct, priceScale, burnBps, i) => {
          // coin 1 value = coin 0 value * ratioPct / 100 at price_scale
          const b1 = (b0 * BigInt(ratioPct) * 10n ** 18n) / 100n / priceScale;
          fc.pre(b1 > 10n ** 12n);
          const balances: [bigint, bigint] = [b0, b1];
          const xp = cryptoswap.scaleBalances(balances, [1n, 1n], priceScale);
          let D: bigint;
          try {
            D = cryptoswap.newtonD(400000n, 145000000000000n, xp);
          } catch {
            return; // outside the contract's safe range
          }
          const supply = cryptoswap.getXcp(D, priceScale);
          const params: cryptoswap.TwocryptoParams = {
            A: 400000n,
            gamma: 145000000000000n,
            D,
            midFee: 26000000n,
            outFee: 45000000n,
            feeGamma: 230000000000000n,
            priceScale,
            balances,
            precisions: [1n, 1n],
          };
          const lp = (supply * burnBps) / 10000n;
          let dy: bigint;
          try {
            dy = cryptoswap.calcWithdrawOneCoin(params, lp, i, supply);
          } catch {
            return;
          }
          const ub = spot.floorRatio(
            spot.cryptoSwapLpSpotValue(
              { A: params.A, gamma: params.gamma, balances, precisions: [1n, 1n], priceScales: [priceScale], D },
              lp,
              supply,
              i
            )
          );
          expect(dy).toBeLessThanOrEqual(ub);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("spot helpers", () => {
  it("rational helpers", () => {
    expect(spot.ratio(6n, -4n)).toEqual({ n: -3n, d: 2n });
    expect(() => spot.ratio(1n, 0n)).toThrow("zero denominator");
    expect(spot.floorRatio(spot.ratio(7n, 2n))).toBe(3n);
    expect(() => spot.floorRatio(spot.ratio(-1n, 2n))).toThrow("negative");
  });

  it("validates inputs", () => {
    const r = (poolCases.cases as PoolCase[]).find((x) => x.name === "FXNETH")!;
    expect(() => spot.cryptoSwapMarginalRate(cryptoState(r), 0, 2)).toThrow("out of bounds");
    expect(spot.cryptoSwapMarginalRate(cryptoState(r), 1, 1)).toEqual({ n: 1n, d: 1n });
    expect(() => spot.lpSpotValueFromRates([1n, 1n], 0, [], 1n, 0n)).toThrow("supply");
    const s = stableParams((poolCases.cases as PoolCase[])[0]);
    expect(() => spot.stableSwapMarginalRate(s, 0, 5)).toThrow("out of bounds");
    expect(() => spot.stableSwapLpSpotValue({ ...s, totalSupply: 0n }, 1n, 0)).toThrow("supply");
  });
});
