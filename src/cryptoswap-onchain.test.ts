/**
 * Fixture replay against on-chain CurveCryptoSwap2 (2-coin) and tricrypto2
 * (3-coin) views at pinned blocks. Every value must match to the wei.
 *
 * - curve-pool-cases.json: `withdraw[i]` is the on-chain
 *   `calc_withdraw_one_coin(1e18, i)` at `block`.
 * - cryptoswap-v1-tx-26108142.json: pool state and views before tx
 *   0xd4b4a8f9…, plus the LP minted and coin withdrawn by that tx.
 */
import { describe, it, expect } from "vitest";
import * as cryptoswap from "./cryptoswap";
import poolCases from "./__fixtures__/curve-pool-cases.json";
import txCase from "./__fixtures__/cryptoswap-v1-tx-26108142.json";
import tricrypto2Case from "./__fixtures__/tricrypto2-26132000.json";
import extraCases from "./__fixtures__/classic-crypto-extra-cases.json";

interface PoolCase {
  name: string;
  block: number;
  pool: string;
  family: string;
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
}

// Classic (non-NG) crypto pools in the fixture set. Tricrypto-NG pools
// (0xf5f5b976…, 0x4ebdf703…, 0x86bf09ac…) use different math.
const CLASSIC_CRYPTO_POOLS = new Set([
  "0xd51a44d3fae010294c616388b506acda1bfaae46", // tricrypto2
  "0xc15f285679a1ef2d25f53d4cbd0265e1d02f2a92", // FXN/ETH
  "0xc26b89a667578ec7b3f11b2f98d6fd15c07c54ba", // YFI/ETH
  "0xb576491f1e6e5e62f1d8f26062ee822b40b0e0d4", // CVX/ETH
  "0x342d1c4aa76ea6f5e5871b7f11a019a0eb713a4f", // CLEV/ETH
  "0xf2f12b364f614925ab8e2c8bfc606edb9282ba09", // CTR/ETH
  "0x72725c0c879489986d213a9a6d2116de45624c1c", // lpxCVX/CVX
]);

const big = (xs: string[]) => xs.map((x) => BigInt(x));

function poolParams(c: PoolCase) {
  const precisions = c.decimals.map((d) => 10n ** BigInt(18 - d));
  return {
    A: BigInt(c.A),
    gamma: BigInt(c.gamma!),
    D: BigInt(c.D!),
    midFee: BigInt(c.mid_fee!),
    outFee: BigInt(c.out_fee!),
    feeGamma: BigInt(c.fee_gamma!),
    precisions,
  };
}

describe("CryptoSwap on-chain fixtures", () => {
  const cases = (poolCases.cases as PoolCase[]).filter((c) =>
    CLASSIC_CRYPTO_POOLS.has(c.pool)
  );

  it("covers every classic crypto fixture row", () => {
    expect(cases.length).toBe(10);
  });

  for (const c of cases) {
    it(`${c.name} @${c.block}: calc_withdraw_one_coin and fee match chain`, () => {
      const base = poolParams(c);
      const supply = BigInt(c.totalSupply);
      const balances = big(c.balances);
      const priceScales = big(c.price_scale!);
      for (let i = 0; i < balances.length; i++) {
        let dy: bigint;
        let xp: bigint[];
        if (balances.length === 2) {
          const params: cryptoswap.TwocryptoParams = {
            ...base,
            priceScale: priceScales[0],
            balances: balances as [bigint, bigint],
            precisions: base.precisions as [bigint, bigint],
          };
          dy = cryptoswap.calcWithdrawOneCoin(params, 10n ** 18n, i, supply);
          xp = cryptoswap.scaleBalances(params.balances, params.precisions!, params.priceScale);
        } else {
          const params: cryptoswap.TricryptoParams = {
            ...base,
            priceScales: priceScales as [bigint, bigint],
            balances: balances as [bigint, bigint, bigint],
            precisions: base.precisions as [bigint, bigint, bigint],
          };
          dy = cryptoswap.calcWithdrawOneCoin3(params, 10n ** 18n, i, supply);
          xp = cryptoswap.scaleBalances3(params.balances, params.precisions!, params.priceScales);
        }
        expect(dy).toBe(BigInt(c.withdraw[i]));
        expect(cryptoswap.dynamicFee(xp, base.feeGamma, base.midFee, base.outFee)).toBe(
          BigInt(c.fee)
        );
      }
    });
  }
});

describe("CryptoSwap acceptance: cvxCRV/crvFRAX tx 26108142", () => {
  const s = txCase.state;
  const params: cryptoswap.TwocryptoParams = {
    A: BigInt(s.A),
    gamma: BigInt(s.gamma),
    D: BigInt(s.D),
    midFee: BigInt(s.midFee),
    outFee: BigInt(s.outFee),
    feeGamma: BigInt(s.feeGamma),
    priceScale: BigInt(s.priceScale),
    balances: big(s.balances) as [bigint, bigint],
    precisions: [1n, 1n],
    futureAGammaTime: BigInt(s.futureAGammaTime),
  };
  const supply = BigInt(s.totalSupply);
  const xp = cryptoswap.scaleBalances(params.balances, [1n, 1n], params.priceScale);

  it("newtonD reproduces the stored D from the balances", () => {
    expect(cryptoswap.newtonD(params.A, params.gamma, xp)).toBe(params.D);
    expect(cryptoswap.calcD(params.A, params.gamma, xp)).toBe(params.D);
  });

  it("fee, get_virtual_price and lp_price match chain", () => {
    expect(cryptoswap.dynamicFee(xp, params.feeGamma, params.midFee, params.outFee)).toBe(
      BigInt(txCase.views.fee)
    );
    expect(cryptoswap.getVirtualPrice(params, supply)).toBe(
      BigInt(txCase.views.get_virtual_price)
    );
    expect(
      cryptoswap.lpPriceFromOracle(BigInt(s.virtualPrice), BigInt(s.priceOracle))
    ).toBe(BigInt(txCase.views.lp_price));
  });

  it("calc_token_amount matches chain", () => {
    for (const v of txCase.views.calc_token_amount) {
      expect(
        cryptoswap.calcTokenAmount(params, big(v.amounts) as [bigint, bigint], supply)
      ).toBe(BigInt(v.result));
    }
  });

  it("calc_withdraw_one_coin matches chain", () => {
    for (const v of txCase.views.calc_withdraw_one_coin) {
      expect(
        cryptoswap.calcWithdrawOneCoin(params, BigInt(v.tokenAmount), v.i, supply)
      ).toBe(BigInt(v.result));
    }
  });

  it("get_dy matches chain", () => {
    for (const v of txCase.views.get_dy) {
      expect(cryptoswap.getDy(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result));
    }
  });

  it("reproduces the tx: add_liquidity mint, then remove_liquidity_one_coin", () => {
    const r = txCase.txResult;
    const amounts = big(r.addLiquidity.amounts) as [bigint, bigint];
    const add = cryptoswap.calcAddLiquidity(params, amounts, supply);
    expect(add.lpMinted).toBe(BigInt(r.addLiquidity.minted));

    // add_liquidity's tweak_price claimed admin fees (mint_relative to the
    // fee receiver) and stored D = newton_D(xp) at an unchanged price_scale.
    const balances: [bigint, bigint] = [
      params.balances[0] + amounts[0],
      params.balances[1] + amounts[1],
    ];
    const after: cryptoswap.TwocryptoParams = {
      ...params,
      balances,
      D: cryptoswap.newtonD(params.A, params.gamma, add.xp),
    };
    const supplyAfter = add.totalSupply + BigInt(r.adminFeeClaimDuringAdd);
    const out = cryptoswap.calcRemoveLiquidityOneCoin(
      after,
      BigInt(r.removeLiquidityOneCoin.tokenAmount),
      r.removeLiquidityOneCoin.i,
      supplyAfter
    );
    expect(out.dy).toBe(BigInt(r.removeLiquidityOneCoin.dy));
  });
});

describe("newtonD (issue #8)", () => {
  // Issue #8 reference: 2833488545042678934584005 from a port that starts at
  // the generic N-coin geometric mean. CurveCryptoSwap2 uses the collapsed
  // 2-coin iteration, so its start (and converged D) differs below newton_D's
  // 1e-14 convergence tolerance; the fixtures above pin the exact value.
  it("returns the invariant, not the sum, for an imbalanced pool", () => {
    const D = cryptoswap.calcD(400000n, 145000000000000n, [2n * 10n ** 24n, 10n ** 24n]);
    expect(D).toBe(2833488545042678933929730n);
    const ref = 2833488545042678934584005n;
    const diff = D > ref ? D - ref : ref - D;
    expect(diff * 10n ** 14n).toBeLessThan(ref);
  });

  it("throws on balances the contract rejects", () => {
    expect(() =>
      cryptoswap.newtonD(400000n, 145000000000000n, [10n ** 24n, 10n ** 19n])
    ).toThrow("unsafe values");
  });
});

describe("tricrypto2 state-changing paths agree with the views", () => {
  const c = (poolCases.cases as PoolCase[]).find(
    (r) => r.pool === "0xd51a44d3fae010294c616388b506acda1bfaae46"
  )!;
  const base = poolParams(c);
  const params: cryptoswap.TricryptoParams = {
    ...base,
    priceScales: big(c.price_scale!) as [bigint, bigint],
    balances: big(c.balances) as [bigint, bigint, bigint],
    precisions: base.precisions as [bigint, bigint, bigint],
  };
  const supply = BigInt(c.totalSupply);
  const xp = cryptoswap.scaleBalances3(params.balances, params.precisions!, params.priceScales);
  // The views recompute D; the stored D is what add_liquidity starts from
  const synced = { ...params, D: cryptoswap.newtonD(params.A, params.gamma, xp) };

  it("add_liquidity mints what calc_token_amount(deposit) quotes", () => {
    const amounts: [bigint, bigint, bigint] = [10_000n * 10n ** 6n, 0n, 5n * 10n ** 18n];
    const add = cryptoswap.calcAddLiquidity3(synced, amounts, supply);
    expect(add.lpMinted).toBe(cryptoswap.calcTokenAmount3(synced, amounts, supply, true));
    expect(add.totalSupply).toBe(supply + add.lpMinted);
    expect(add.lpFee).toBeGreaterThan(0n);
  });

  it("withdrawal calc_token_amount burns more LP than the pro-rata share", () => {
    const amounts: [bigint, bigint, bigint] = [10_000n * 10n ** 6n, 0n, 0n];
    const burned = cryptoswap.calcTokenAmount3(synced, amounts, supply, false);
    expect(burned).toBeGreaterThan(0n);
    expect(() =>
      cryptoswap.calcTokenAmount3(synced, [params.balances[0] + 1n, 0n, 0n], supply, false)
    ).toThrow("withdrawal exceeds pool balance");
  });

  it("remove_liquidity_one_coin equals calc_withdraw_one_coin at the same D", () => {
    for (let i = 0; i < 3; i++) {
      const r = cryptoswap.calcRemoveLiquidityOneCoin3(synced, 10n ** 18n, i, supply);
      expect(r.dy).toBe(BigInt(c.withdraw[i]));
      expect(r.D).toBeLessThan(r.D0);
    }
    expect(() => cryptoswap.calcRemoveLiquidityOneCoin3(synced, 10n ** 18n, 3, supply)).toThrow(
      "index out of bounds"
    );
    expect(() => cryptoswap.calcRemoveLiquidityOneCoin3(synced, 0n, 0, supply)).toThrow(
      "tokenAmount cannot be zero"
    );
    expect(() => cryptoswap.calcRemoveLiquidityOneCoin3(synced, supply + 1n, 0, supply)).toThrow(
      "tokenAmount exceeds totalSupply"
    );
  });

  it("first deposit mints xcp(D)", () => {
    const empty = { ...params, D: 0n, balances: [0n, 0n, 0n] as [bigint, bigint, bigint] };
    const amounts = params.balances;
    const add = cryptoswap.calcAddLiquidity3(empty, amounts, 0n);
    expect(add.lpMinted).toBe(cryptoswap.getXcp3(add.D, params.priceScales));
    expect(cryptoswap.calcTokenAmount3(empty, amounts, 0n)).toBe(add.lpMinted);
    expect(() => cryptoswap.calcAddLiquidity3(params, [0n, 0n, 0n], supply)).toThrow(
      "no coins to add"
    );
  });

  it("ramping pools recompute D from the balances", () => {
    const ramping = { ...params, D: 1n, futureAGammaTime: 1n };
    const amounts: [bigint, bigint, bigint] = [0n, 10n ** 8n, 0n];
    expect(cryptoswap.calcAddLiquidity3(ramping, amounts, supply).lpMinted).toBe(
      cryptoswap.calcAddLiquidity3(synced, amounts, supply).lpMinted
    );
    expect(cryptoswap.calcRemoveLiquidityOneCoin3(ramping, 10n ** 18n, 2, supply).dy).toBe(
      BigInt(c.withdraw[2])
    );
  });
});

describe("CurveCryptoSwap2 helpers", () => {
  const s = txCase.state;
  const params: cryptoswap.TwocryptoParams = {
    A: BigInt(s.A),
    gamma: BigInt(s.gamma),
    D: BigInt(s.D),
    midFee: BigInt(s.midFee),
    outFee: BigInt(s.outFee),
    feeGamma: BigInt(s.feeGamma),
    priceScale: BigInt(s.priceScale),
    balances: big(s.balances) as [bigint, bigint],
    precisions: [1n, 1n],
  };
  const supply = BigInt(s.totalSupply);

  it("ramping pools recompute D in get_dy, calc_token_amount and withdrawals", () => {
    const ramping = { ...params, D: 1n, futureAGammaTime: 1n };
    expect(cryptoswap.getDy(ramping, 0, 1, 10n ** 21n)).toBe(cryptoswap.getDy(params, 0, 1, 10n ** 21n));
    const amounts: [bigint, bigint] = [0n, 10n ** 19n];
    expect(cryptoswap.calcTokenAmount(ramping, amounts, supply)).toBe(
      cryptoswap.calcTokenAmount(params, amounts, supply)
    );
    expect(cryptoswap.calcRemoveLiquidityOneCoin(ramping, 10n ** 18n, 1, supply).dy).toBe(
      cryptoswap.calcWithdrawOneCoin(params, 10n ** 18n, 1, supply)
    );
  });

  it("first deposit mints xcp(D)", () => {
    const empty = { ...params, D: 0n, balances: [0n, 0n] as [bigint, bigint] };
    const add = cryptoswap.calcAddLiquidity(empty, params.balances, 0n);
    expect(add.lpMinted).toBe(cryptoswap.getXcp(add.D, params.priceScale));
    expect(cryptoswap.calcTokenAmount(empty, params.balances, 0n)).toBe(add.lpMinted);
  });

  it("validates withdrawal inputs", () => {
    expect(() => cryptoswap.calcRemoveLiquidityOneCoin(params, 10n ** 18n, 2, supply)).toThrow(
      "index out of bounds"
    );
    expect(() => cryptoswap.calcRemoveLiquidityOneCoin(params, 0n, 0, supply)).toThrow(
      "tokenAmount cannot be zero"
    );
    expect(() => cryptoswap.calcWithdrawOneCoin(params, supply + 1n, 0, supply)).toThrow(
      "tokenAmount exceeds totalSupply"
    );
    expect(() => cryptoswap.calcTokenFee([0n, 0n], [1n, 1n], 1n, 1n, 1n)).toThrow(
      "amounts sum to zero"
    );
  });

  it("sqrtInt and geometricMean edge cases", () => {
    expect(cryptoswap.sqrtInt(0n)).toBe(0n);
    expect(cryptoswap.sqrtInt(4n * 10n ** 18n)).toBe(2n * 10n ** 18n);
    expect(cryptoswap.geometricMean([4n * 10n ** 18n, 10n ** 18n])).toBe(2n * 10n ** 18n);
    expect(() => cryptoswap.geometricMean([0n, 0n])).toThrow("zero value");
    expect(() => cryptoswap.newtonD(400000n, 145000000000000n, [1n, 1n, 1n, 1n])).toThrow(
      "2 or 3 coins"
    );
    expect(() => cryptoswap.newtonD(400000n, 145000000000000n, [10n ** 8n, 10n ** 8n])).toThrow(
      "unsafe values x[0]"
    );
  });
});

describe("tricrypto2 views at block 26132000", () => {
  const c = tricrypto2Case;
  const params: cryptoswap.TricryptoParams = {
    A: BigInt(c.A),
    gamma: BigInt(c.gamma),
    D: BigInt(c.D),
    midFee: BigInt(c.mid_fee),
    outFee: BigInt(c.out_fee),
    feeGamma: BigInt(c.fee_gamma),
    priceScales: big(c.price_scale) as [bigint, bigint],
    balances: big(c.balances) as [bigint, bigint, bigint],
    precisions: big(c.precisions) as [bigint, bigint, bigint],
  };
  const supply = BigInt(c.totalSupply);
  const xp = cryptoswap.scaleBalances3(params.balances, params.precisions!, params.priceScales);

  it("fee and get_virtual_price", () => {
    expect(cryptoswap.dynamicFee(xp, params.feeGamma, params.midFee, params.outFee)).toBe(
      BigInt(c.fee)
    );
    expect(cryptoswap.getVirtualPrice3(params, supply)).toBe(BigInt(c.get_virtual_price));
  });

  it("get_dy", () => {
    for (const v of c.get_dy) {
      expect(cryptoswap.getDy3(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result));
    }
  });

  it("calc_token_amount (deposit and withdrawal)", () => {
    for (const v of c.calc_token_amount) {
      expect(
        cryptoswap.calcTokenAmount3(
          params,
          big(v.amounts) as [bigint, bigint, bigint],
          supply,
          v.deposit
        )
      ).toBe(BigInt(v.result));
    }
  });

  it("calc_withdraw_one_coin", () => {
    for (const v of c.calc_withdraw_one_coin) {
      expect(cryptoswap.calcWithdrawOneCoin3(params, BigInt(v.tokenAmount), v.i, supply)).toBe(
        BigInt(v.result)
      );
    }
  });
});

describe("other classic crypto pools (EURS/USDC, T/ETH, tricrypto v1)", () => {
  for (const c of extraCases.cases as {
    name: string;
    n: number;
    A: string;
    A_precise?: string;
    gamma: string;
    D: string;
    mid_fee: string;
    out_fee: string;
    fee_gamma: string;
    get_virtual_price: string;
    balances: string[];
    price_scale: string[];
    totalSupply: string;
    decimals: number[];
    cwo: { amt: string; i: number; r: string }[];
  }[]) {
    it(c.name, () => {
      const precisions = c.decimals.map((d) => 10n ** BigInt(18 - d));
      // tricrypto v1's math uses A_MULTIPLIER = 100 with A_precise()
      const A = c.A_precise ? BigInt(c.A_precise) * 100n : BigInt(c.A);
      const base = {
        A,
        gamma: BigInt(c.gamma),
        D: BigInt(c.D),
        midFee: BigInt(c.mid_fee),
        outFee: BigInt(c.out_fee),
        feeGamma: BigInt(c.fee_gamma),
      };
      const supply = BigInt(c.totalSupply);
      for (const w of c.cwo) {
        let dy: bigint;
        if (c.n === 2) {
          const p: cryptoswap.TwocryptoParams = {
            ...base,
            priceScale: BigInt(c.price_scale[0]),
            balances: big(c.balances) as [bigint, bigint],
            precisions: precisions as [bigint, bigint],
          };
          dy = cryptoswap.calcWithdrawOneCoin(p, BigInt(w.amt), w.i, supply);
          expect(cryptoswap.getVirtualPrice(p, supply)).toBe(BigInt(c.get_virtual_price));
        } else {
          const p: cryptoswap.TricryptoParams = {
            ...base,
            priceScales: big(c.price_scale) as [bigint, bigint],
            balances: big(c.balances) as [bigint, bigint, bigint],
            precisions: precisions as [bigint, bigint, bigint],
          };
          // tricrypto v1's calc_withdraw_one_coin starts from the stored D
          dy = cryptoswap.calcRemoveLiquidityOneCoin3(p, BigInt(w.amt), w.i, supply).dy;
          expect(cryptoswap.getVirtualPrice3(p, supply)).toBe(BigInt(c.get_virtual_price));
        }
        expect(dy).toBe(BigInt(w.r));
      }
    });
  }
});
