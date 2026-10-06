/**
 * Fixture replay of Twocrypto pools on StableswapMath (v3.0.0 and v2.1.0d)
 * against on-chain views at a pinned block. Every value must match to the wei.
 */
import { describe, it, expect } from "vitest";
import * as twocryptoStableswap from "./twocrypto-stableswap";
import cases from "./__fixtures__/twocrypto-stableswap-cases.json";

interface Case {
  name: string;
  pool: string;
  version: string;
  MATH: string;
  POLICY: string;
  blockTimestamp: string;
  A: string;
  gamma: string;
  D: string;
  mid_fee: string;
  out_fee: string;
  fee_gamma: string;
  fee: string;
  totalSupply: string;
  get_virtual_price: string;
  lp_price: string;
  price_scale: string;
  price_oracle: string;
  last_timestamp: string;
  future_A_gamma_time: string;
  donation_shares: string | null;
  donation_protection_expiry_ts: string | null;
  donation_protection_period: string | null;
  donation_shares_max_ratio: string | null;
  balances: string[];
  precisions: string[];
  get_dy: { i: number; j: number; dx: string; result: string }[];
  calc_token_amount: { amounts: string[]; deposit: boolean; result: string }[];
  calc_withdraw_one_coin: { tokenAmount: string; i: number; result: string }[];
  calc_withdraw_fixed_out: { tokenAmount: string; i: number; amount_i: string; result: string }[];
}

const big = (xs: readonly string[]) => xs.map((x) => BigInt(x));

function toParams(c: Case): twocryptoStableswap.TwocryptoStableswapParams {
  twocryptoStableswap.assertSupportedImplementation(c.version, c.MATH);
  return {
    version: c.version,
    policy: c.version === "v3.0.0" ? c.POLICY : undefined,
    A: BigInt(c.A),
    gamma: BigInt(c.gamma),
    D: BigInt(c.D),
    midFee: BigInt(c.mid_fee),
    outFee: BigInt(c.out_fee),
    feeGamma: BigInt(c.fee_gamma),
    priceScale: BigInt(c.price_scale),
    balances: big(c.balances) as [bigint, bigint],
    precisions: big(c.precisions) as [bigint, bigint],
    totalSupply: BigInt(c.totalSupply),
    isRamping: BigInt(c.future_A_gamma_time) > BigInt(c.last_timestamp),
    donation: c.donation_shares
      ? {
          shares: BigInt(c.donation_shares),
          protectionExpiryTs: BigInt(c.donation_protection_expiry_ts!),
          protectionPeriod: BigInt(c.donation_protection_period!),
          sharesMaxRatio: BigInt(c.donation_shares_max_ratio!),
          blockTimestamp: BigInt(c.blockTimestamp),
        }
      : undefined,
  };
}

describe("Twocrypto (StableswapMath) on-chain views", () => {
  for (const c of cases.cases as Case[]) {
    describe(`${c.name} ${c.version}`, () => {
      const params = toParams(c);

      it("fee, get_virtual_price and lp_price", () => {
        expect(twocryptoStableswap.fee(params)).toBe(BigInt(c.fee));
        expect(twocryptoStableswap.getVirtualPrice(params)).toBe(BigInt(c.get_virtual_price));
        expect(twocryptoStableswap.lpPrice(params, BigInt(c.price_oracle))).toBe(BigInt(c.lp_price));
      });

      it("get_dy", () => {
        for (const v of c.get_dy) {
          expect(twocryptoStableswap.getDy(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result));
        }
      });

      it("calc_token_amount", () => {
        for (const v of c.calc_token_amount) {
          expect(
            twocryptoStableswap.calcTokenAmount(params, big(v.amounts) as [bigint, bigint], v.deposit)
          ).toBe(BigInt(v.result));
        }
      });

      it("calc_withdraw_one_coin and calc_withdraw_fixed_out", () => {
        for (const v of c.calc_withdraw_one_coin) {
          expect(twocryptoStableswap.calcWithdrawOneCoin(params, BigInt(v.tokenAmount), v.i)).toBe(
            BigInt(v.result)
          );
        }
        for (const v of c.calc_withdraw_fixed_out) {
          expect(
            twocryptoStableswap.calcWithdrawFixedOut(params, BigInt(v.tokenAmount), v.i, BigInt(v.amount_i))
          ).toBe(BigInt(v.result));
        }
      });

      it("newton_D of the balances is within 0.1% of stored D", () => {
        const D = twocryptoStableswap.newtonD(params.A, twocryptoStableswap.xp(params));
        const diff = D > params.D ? D - params.D : params.D - D;
        expect(diff * 1000n).toBeLessThan(params.D);
      });
    });
  }
});

describe("Twocrypto (StableswapMath) behaviour", () => {
  const params = toParams((cases.cases as Case[])[1]);

  it("rejects other implementations", () => {
    expect(() => twocryptoStableswap.assertSupportedImplementation("v2.1.0")).toThrow("unsupported");
    expect(() =>
      twocryptoStableswap.assertSupportedImplementation(
        "v3.0.0",
        "0x79839c2D74531A8222C0F555865aAc1834e82e51"
      )
    ).toThrow("unsupported MATH");
  });

  it("v3.0.0 fails closed on a missing or unknown POLICY", () => {
    expect(() => twocryptoStableswap.fee({ ...params, policy: undefined })).toThrow("need `policy`");
    expect(() =>
      twocryptoStableswap.fee({ ...params, policy: "0x1111111111111111111111111111111111111111" })
    ).toThrow("unknown fee POLICY");
    expect(
      twocryptoStableswap.fee({ ...params, policy: twocryptoStableswap.ZERO_FEE_POLICIES[0] })
    ).toBe(twocryptoStableswap.fee(params));
  });

  it("a POLICY fee replaces the dynamic fee (clamped) on v3.0.0", () => {
    const base = twocryptoStableswap.fee(params);
    expect(twocryptoStableswap.fee({ ...params, policyFee: () => 0n })).toBe(base);
    expect(twocryptoStableswap.fee({ ...params, policyFee: () => 12345678n })).toBe(12345678n);
    expect(twocryptoStableswap.fee({ ...params, policyFee: () => 1n })).toBe(100000n);
  });

  it("the LP spam fee applies to deposits while donation protection is active", () => {
    const amounts: [bigint, bigint] = [params.balances[0] / 100n, 0n];
    const ts = 1_800_000_000n;
    const active = {
      ...params,
      donation: {
        shares: params.totalSupply / 10n,
        protectionExpiryTs: ts + 3600n,
        protectionPeriod: 3600n,
        sharesMaxRatio: 10n ** 17n,
        blockTimestamp: ts,
      },
    };
    const expired = { ...active, donation: { ...active.donation, blockTimestamp: ts + 7200n } };
    expect(twocryptoStableswap.calcTokenAmount(active, amounts, true)).toBeLessThan(
      twocryptoStableswap.calcTokenAmount(expired, amounts, true)
    );
    expect(twocryptoStableswap.calcTokenAmount({ ...params, donation: undefined }, amounts, true)).toBe(
      twocryptoStableswap.calcTokenAmount(expired, amounts, true)
    );
  });

  it("ramping pools re-solve D from the balances", () => {
    const D = twocryptoStableswap.newtonD(params.A, twocryptoStableswap.xp(params));
    expect(twocryptoStableswap.getDy({ ...params, D: 1n, isRamping: true }, 0, 1, 10n ** 18n)).toBe(
      twocryptoStableswap.getDy({ ...params, D }, 0, 1, 10n ** 18n)
    );
  });

  it("balanced remove_liquidity and price oracle", () => {
    const s = params.totalSupply;
    expect(twocryptoStableswap.calcRemoveLiquidity(params, s / 4n)).toEqual(
      params.balances.map((b) => (b * (s / 4n)) / s)
    );
    const po = {
      cachedPriceOracle: 2n * 10n ** 18n,
      priceScale: 2n * 10n ** 18n,
      lastPrices: 3n * 10n ** 18n,
      lastTimestamp: 100n,
      maTime: 600n,
      blockTimestamp: 100n,
    };
    expect(twocryptoStableswap.priceOracle(po)).toBe(po.cachedPriceOracle);
    const later = twocryptoStableswap.priceOracle({ ...po, blockTimestamp: 100000n });
    expect(later).toBeGreaterThan(po.cachedPriceOracle);
    expect(later).toBeLessThanOrEqual(po.lastPrices);
  });

  it("validates inputs", () => {
    expect(() => twocryptoStableswap.getDy(params, 1, 1, 1n)).toThrow("coin index out of range");
    expect(() => twocryptoStableswap.calcWithdrawOneCoin(params, params.totalSupply + 1n, 0)).toThrow("!amount");
    expect(() => twocryptoStableswap.calcWithdrawOneCoin(params, 1n, 2)).toThrow("coin out of range");
    expect(() => twocryptoStableswap.newtonD(params.A, [10n ** 22n, 10n ** 17n])).toThrow("!balance");
    expect(() =>
      twocryptoStableswap.calcTokenAmount(params, [params.balances[0] + 1n, 0n], false)
    ).toThrow("exceeds pool balance");
  });
});

describe("Twocrypto (StableswapMath) with donation protection active", () => {
  const c = cases.donationActive as unknown as Case;
  const params = toParams(c);

  it("protection is active at the fixture block", () => {
    expect(BigInt(c.donation_protection_expiry_ts!)).toBeGreaterThan(BigInt(c.blockTimestamp));
  });

  it("every on-chain view matches, deposits only with the LP spam fee", () => {
    expect(twocryptoStableswap.fee(params)).toBe(BigInt(c.fee));
    for (const v of c.get_dy) {
      expect(twocryptoStableswap.getDy(params, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result));
    }
    for (const v of c.calc_token_amount) {
      const amounts = big(v.amounts) as [bigint, bigint];
      expect(twocryptoStableswap.calcTokenAmount(params, amounts, v.deposit)).toBe(BigInt(v.result));
      const withoutDonation = twocryptoStableswap.calcTokenAmount(
        { ...params, donation: undefined },
        amounts,
        v.deposit
      );
      if (v.deposit) expect(withoutDonation).toBeGreaterThan(BigInt(v.result));
      else expect(withoutDonation).toBe(BigInt(v.result));
    }
    for (const v of c.calc_withdraw_one_coin) {
      expect(twocryptoStableswap.calcWithdrawOneCoin(params, BigInt(v.tokenAmount), v.i)).toBe(BigInt(v.result));
    }
  });
});
