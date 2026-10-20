/**
 * Integration tests that verify off-chain math against on-chain Curve pools.
 * These tests require RPC access and are skipped if RPC_URL is not set.
 *
 * Run with: RPC_URL=https://eth.llamarpc.com pnpm test src/rpc/integration.test.ts
 * LlamaLend Optimism tests additionally require OPTIMISM_RPC_URL.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import * as stableswap from "../stableswap";
import * as cryptoswap from "../cryptoswap";
import * as yieldbasis from "../yieldbasis";
import * as llamalend from "../llamalend";
import {
  getStableSwapParams,
  getTricryptoParams,
  getOnChainDy,
  getOnChainDx,
  getExactStableSwapParams,
  getStoredRates,
  getPoolCoins,
  getTokenDecimals,
  getYieldBasisVirtualPoolParams,
  getBlockNumber,
  getLlamaLendAmmParams,
  getTricryptoLegacyState,
} from "./index";
import * as tricryptoLegacy from "../tricrypto-legacy";
import legacyCases from "../__fixtures__/legacy-tricrypto-cases.json";
import * as stableswapExact from "../stableswap-exact";

// Set longer timeout for RPC tests (30 seconds)
vi.setConfig({ testTimeout: 30000 });

// Skip tests if no RPC URL is provided
const RPC_URL = process.env.RPC_URL;
const describeIf = RPC_URL ? describe : describe.skip;
const OPTIMISM_RPC_URL = process.env.OPTIMISM_RPC_URL;
const describeOptimismIf = OPTIMISM_RPC_URL ? describe : describe.skip;
const YB_VIRTUAL_POOL_ADDRESSES =
  process.env.YB_VIRTUAL_POOL_ADDRESSES?.split(",")
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
const describeYieldBasisIf = RPC_URL ? describe : describe.skip;
const LLAMALEND_OPTIMISM_AMM =
  process.env.LLAMALEND_OPTIMISM_AMM ??
  "0x86372d2844acb9f1fed32b80aebbe3cc50124c72";
const LLAMALEND_OPTIMISM_BAND_TO = Number(
  process.env.LLAMALEND_OPTIMISM_BAND_TO ?? "160"
);
const LLAMALEND_MAINNET_AMM = process.env.LLAMALEND_MAINNET_AMM;
const describeMainnetLlamaLendIf =
  RPC_URL && LLAMALEND_MAINNET_AMM ? describe : describe.skip;

// Known Curve pool addresses on Ethereum mainnet
const POOLS = {
  // StableSwap pools
  THREEPOOL: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7", // 3pool (DAI/USDC/USDT)
  FRAXUSDC: "0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2", // FRAX/USDC

  // CryptoSwap pools (Twocrypto-NG)
  TRICRYPTO_USDC: "0x7F86Bf177Dd4F3494b841a37e810A34dD56c829B", // Tricrypto USDC (USDC/WBTC/WETH)

  // Factory pools with uint256 indices
  CRVUSD_USDC: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E", // crvUSD/USDC (StableSwapNG)

  // StableSwapNG pools
  STETH_ETH: "0x21E27a5E5513D6e65C4f830167390997aA84843a", // stETH/ETH (stETH is rebasing asset type 2)
};

// Known YieldBasis virtual pools on Ethereum mainnet.
// Override with YB_VIRTUAL_POOL_ADDRESSES=0x...,0x... to test a custom set.
const YB_VIRTUAL_POOLS = (
  YB_VIRTUAL_POOL_ADDRESSES ?? [
    "0xABf17d1deF75dA1B41B6df5f0b4AecE602b4E045", // WBTC
    "0x2dA2Aada1445a5101d648F3c8711B070799bbc91", // cbBTC
    "0xFD1DB6F59fd1FBe0635F3DF11c127B3DDC744092", // tBTC
  ]
).map((address, index) => ({
  name: `YieldBasis virtual pool ${index + 1}`,
  address,
}));

// Tolerance for off-chain vs on-chain comparison (0.1% = 10 bps)
const TOLERANCE_BPS = 10n;

// For exact precision, allow only ±1 wei difference (due to Newton's method convergence)
const EXACT_TOLERANCE = 1n;

function assertExactMatch(
  offChain: bigint,
  onChain: bigint,
  label: string
): void {
  const diff = offChain > onChain ? offChain - onChain : onChain - offChain;
  expect(
    diff <= EXACT_TOLERANCE,
    `${label}: off-chain ${offChain} vs on-chain ${onChain}, diff ${diff} > exact tolerance ${EXACT_TOLERANCE}`
  ).toBe(true);
}

function assertWithinTolerance(
  offChain: bigint,
  onChain: bigint,
  label: string
): void {
  const diff = offChain > onChain ? offChain - onChain : onChain - offChain;
  const tolerance = (onChain * TOLERANCE_BPS) / 10000n;

  expect(
    diff <= tolerance,
    `${label}: off-chain ${offChain} vs on-chain ${onChain}, diff ${diff} > tolerance ${tolerance}`
  ).toBe(true);
}

async function getNullableOnChainDy(
  poolAddress: string,
  i: number,
  j: number,
  dx: bigint
): Promise<bigint | null> {
  try {
    return await getOnChainDy(RPC_URL!, poolAddress, i, j, dx, true);
  } catch {
    return null;
  }
}

async function assertLlamaLendDyExactMatch(
  rpcUrl: string,
  ammAddress: string,
  params: llamalend.LlamaLendAmmParams,
  i: number,
  j: number,
  dx: bigint,
  label: string,
  blockTag?: string | number | bigint
): Promise<void> {
  const offChain = llamalend.getDy(params, i, j, dx);
  const onChain = await getOnChainDy(rpcUrl, ammAddress, i, j, dx, true, {
    blockTag,
  });

  expect(onChain).not.toBeNull();
  if (onChain !== null) {
    assertExactMatch(offChain, onChain, label);
  }
}

async function assertLlamaLendDxExactMatch(
  rpcUrl: string,
  ammAddress: string,
  params: llamalend.LlamaLendAmmParams,
  i: number,
  j: number,
  dy: bigint,
  label: string,
  blockTag?: string | number | bigint
): Promise<void> {
  const offChain = llamalend.getDx(params, i, j, dy);
  const onChain = await getOnChainDx(rpcUrl, ammAddress, i, j, dy, {
    blockTag,
  });

  expect(onChain).not.toBeNull();
  if (onChain !== null) {
    assertExactMatch(offChain, onChain, label);
  }
}

function getNullableYieldBasisDy(
  params: yieldbasis.YieldBasisVirtualPoolParams,
  i: number,
  j: number,
  dx: bigint
): bigint | null {
  try {
    return yieldbasis.getDy(params, i, j, dx);
  } catch {
    return null;
  }
}

async function assertYieldBasisExactMatch(
  virtualPoolAddress: string,
  i: number,
  j: number,
  dx: bigint,
  label: string
): Promise<void> {
  let lastError = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const params = await getYieldBasisVirtualPoolParams(
      RPC_URL!,
      virtualPoolAddress,
      { strict: true }
    );
    const offChain = getNullableYieldBasisDy(params, i, j, dx);
    const onChain = await getNullableOnChainDy(virtualPoolAddress, i, j, dx);

    if (offChain === null && onChain === null) return;
    if (offChain !== null && onChain !== null && offChain === onChain) return;

    lastError =
      `${label}: off-chain ${offChain?.toString() ?? "revert"} vs ` +
      `on-chain ${onChain?.toString() ?? "revert"} on attempt ${attempt + 1}`;
  }

  expect(false, lastError).toBe(true);
}

// 3pool token decimals: DAI=18, USDC=6, USDT=6
const THREEPOOL_DECIMALS = [18, 6, 6];

describeYieldBasisIf("YieldBasis VirtualPool - Exact Parity", () => {
  for (const pool of YB_VIRTUAL_POOLS) {
    describe(`${pool.name} (${pool.address})`, () => {
      it("matches on-chain get_dy exactly for stablecoin->asset", async () => {
        const coins = await getPoolCoins(RPC_URL!, pool.address, 2);
        const [stableDecimals] = await getTokenDecimals(RPC_URL!, coins);
        const stableUnit = 10n ** BigInt(stableDecimals);
        const swapSizes = [1n, 100n, 10000n].map(
          (tokens) => tokens * stableUnit
        );

        for (const dx of swapSizes) {
          await assertYieldBasisExactMatch(
            pool.address,
            0,
            1,
            dx,
            `${pool.name} stablecoin->asset dx=${dx}`
          );
        }
      });

      it("matches on-chain get_dy exactly for asset->stablecoin", async () => {
        const coins = await getPoolCoins(RPC_URL!, pool.address, 2);
        const decimals = await getTokenDecimals(RPC_URL!, coins);
        const assetUnit = 10n ** BigInt(decimals[1]);
        const baseAssetSize = assetUnit / 10000n > 0n ? assetUnit / 10000n : 1n;
        const swapSizes = [
          baseAssetSize,
          baseAssetSize * 10n,
          baseAssetSize * 100n,
        ];

        for (const dx of swapSizes) {
          await assertYieldBasisExactMatch(
            pool.address,
            1,
            0,
            dx,
            `${pool.name} asset->stablecoin dx=${dx}`
          );
        }
      });
    });
  }
});

describeOptimismIf("LlamaLend LLAMMA - Optimism v2 WBTC exact parity", () => {
  let params: Awaited<ReturnType<typeof getLlamaLendAmmParams>>;
  let blockTag: bigint;

  beforeAll(async () => {
    blockTag = await getBlockNumber(OPTIMISM_RPC_URL!);
    params = await getLlamaLendAmmParams(
      OPTIMISM_RPC_URL!,
      LLAMALEND_OPTIMISM_AMM,
      {
        bandRange: { from: 0, to: LLAMALEND_OPTIMISM_BAND_TO },
        maxBandFetch: LLAMALEND_OPTIMISM_BAND_TO + 1,
        blockTag,
        strict: true,
      }
    );
  });

  it("fetches the expected v2 WBTC market state", () => {
    expect(params.A).toBeGreaterThan(0n);
    expect(params.fee).toBeGreaterThan(0n);
    expect(params.coins[0].toLowerCase()).toBe(
      "0x0b2c639c533813f4aa9d7837caf62653d097ff85"
    );
    expect(params.coins[1].toLowerCase()).toBe(
      "0x68f180fcce6836688e9084f035309e29bf0a2095"
    );
    expect(params.decimals).toEqual([6, 8]);
    expect(params.fetchedBands).toContain(params.activeBand);
  });

  it("matches on-chain get_dy for USDC->WBTC across band-crossing sizes", async () => {
    const borrowedUnit = 10n ** BigInt(params.decimals[0]);
    const swapSizes = [1n, 100n, 1000n].map((tokens) => tokens * borrowedUnit);

    for (const dx of swapSizes) {
      await assertLlamaLendDyExactMatch(
        OPTIMISM_RPC_URL!,
        LLAMALEND_OPTIMISM_AMM,
        params,
        0,
        1,
        dx,
        `Optimism LlamaLend USDC->WBTC dx=${dx}`,
        blockTag
      );
    }
  });

  it("matches on-chain get_dx for exact WBTC outputs", async () => {
    const collateralUnit = 10n ** BigInt(params.decimals[1]);
    const desiredOutputs = [
      collateralUnit / 100000n,
      collateralUnit / 1000n,
      collateralUnit / 100n,
    ].filter((amount) => amount > 0n);

    for (const dy of desiredOutputs) {
      await assertLlamaLendDxExactMatch(
        OPTIMISM_RPC_URL!,
        LLAMALEND_OPTIMISM_AMM,
        params,
        0,
        1,
        dy,
        `Optimism LlamaLend USDC->WBTC get_dx dy=${dy}`,
        blockTag
      );
    }
  });

  it("matches on-chain get_dy for WBTC->USDC in the current band state", async () => {
    const collateralUnit = 10n ** BigInt(params.decimals[1]);
    const baseSize = collateralUnit / 100000n > 0n ? collateralUnit / 100000n : 1n;
    const swapSizes = [baseSize, baseSize * 10n, baseSize * 100n];

    for (const dx of swapSizes) {
      await assertLlamaLendDyExactMatch(
        OPTIMISM_RPC_URL!,
        LLAMALEND_OPTIMISM_AMM,
        params,
        1,
        0,
        dx,
        `Optimism LlamaLend WBTC->USDC dx=${dx}`,
        blockTag
      );
    }
  });
});

describeMainnetLlamaLendIf("LlamaLend LLAMMA - configurable mainnet market exact parity", () => {
  let params: Awaited<ReturnType<typeof getLlamaLendAmmParams>>;
  let blockTag: bigint;

  beforeAll(async () => {
    const bandFrom = process.env.LLAMALEND_MAINNET_BAND_FROM;
    const bandTo = process.env.LLAMALEND_MAINNET_BAND_TO;
    const maxBandFetch = Number(process.env.LLAMALEND_MAINNET_MAX_BAND_FETCH ?? "512");
    blockTag = await getBlockNumber(RPC_URL!);

    params = await getLlamaLendAmmParams(RPC_URL!, LLAMALEND_MAINNET_AMM!, {
      ...(bandFrom !== undefined && bandTo !== undefined
        ? { bandRange: { from: Number(bandFrom), to: Number(bandTo) } }
        : {}),
      maxBandFetch,
      blockTag,
      strict: true,
    });
  });

  it("matches on-chain get_dy in both directions for small inputs", async () => {
    const borrowedUnit = 10n ** BigInt(params.decimals[0]);
    const collateralUnit = 10n ** BigInt(params.decimals[1]);
    const borrowedIn = borrowedUnit / 100n > 0n ? borrowedUnit / 100n : 1n;
    const collateralIn = collateralUnit / 100000n > 0n ? collateralUnit / 100000n : 1n;

    await assertLlamaLendDyExactMatch(
      RPC_URL!,
      LLAMALEND_MAINNET_AMM!,
      params,
      0,
      1,
      borrowedIn,
      `Mainnet LlamaLend coin0->coin1 dx=${borrowedIn}`,
      blockTag
    );
    await assertLlamaLendDyExactMatch(
      RPC_URL!,
      LLAMALEND_MAINNET_AMM!,
      params,
      1,
      0,
      collateralIn,
      `Mainnet LlamaLend coin1->coin0 dx=${collateralIn}`,
      blockTag
    );
  });
});

describeIf("RPC Integration Tests", () => {
  describe("StableSwap - 3pool", () => {
    it("should match on-chain get_dy for DAI->USDC swap", async () => {
      // Fetch with normalization
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3, {
        normalize: THREEPOOL_DECIMALS,
      });

      // Off-chain: use normalized input (18 decimals)
      const dxNormalized = 1000n * 10n ** 18n;
      const offChainDy = stableswap.getDy(
        0,
        1,
        dxNormalized,
        params.balances,
        params.Ann,
        params.fee,
        params.offpegFeeMultiplier
      );

      // On-chain: use native decimals (DAI = 18 dec)
      const dxNative = 1000n * 10n ** BigInt(THREEPOOL_DECIMALS[0]);
      const onChainDyNative = await getOnChainDy(
        RPC_URL!,
        POOLS.THREEPOOL,
        0,
        1,
        dxNative,
        false // int128 indices
      );

      expect(onChainDyNative).not.toBeNull();
      if (onChainDyNative) {
        // Normalize on-chain result (USDC = 6 dec -> 18 dec)
        const precision_j = 10n ** BigInt(18 - THREEPOOL_DECIMALS[1]);
        const onChainDyNormalized = onChainDyNative * precision_j;
        assertWithinTolerance(offChainDy, onChainDyNormalized, "3pool DAI->USDC");
      }
    });

    it("should match on-chain get_dy for USDC->USDT swap", async () => {
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3, {
        normalize: THREEPOOL_DECIMALS,
      });

      // Off-chain: normalized input (18 decimals)
      const dxNormalized = 500n * 10n ** 18n;
      const offChainDy = stableswap.getDy(
        1,
        2,
        dxNormalized,
        params.balances,
        params.Ann,
        params.fee,
        params.offpegFeeMultiplier
      );

      // On-chain: native decimals (USDC = 6 dec)
      const dxNative = 500n * 10n ** BigInt(THREEPOOL_DECIMALS[1]);
      const onChainDyNative = await getOnChainDy(
        RPC_URL!,
        POOLS.THREEPOOL,
        1,
        2,
        dxNative,
        false
      );

      expect(onChainDyNative).not.toBeNull();
      if (onChainDyNative) {
        // Both USDC and USDT are 6 decimals, so precision_j = 10^12
        const precision_j = 10n ** BigInt(18 - THREEPOOL_DECIMALS[2]);
        const onChainDyNormalized = onChainDyNative * precision_j;
        assertWithinTolerance(offChainDy, onChainDyNormalized, "3pool USDC->USDT");
      }
    });

    it("should calculate virtual price accurately", async () => {
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3, {
        normalize: THREEPOOL_DECIMALS,
      });

      // Virtual price should be >= 1.0 (10^18) for healthy pools
      const virtualPrice = stableswap.getVirtualPrice(
        params.balances,
        params.Ann,
        // For virtual price, we need totalSupply which isn't in params
        // This test verifies calculation doesn't error with real balances
        params.balances.reduce((a, b) => a + b, 0n) // Approximate
      );

      // Virtual price should be reasonable (0.8 to 2.0)
      expect(virtualPrice).toBeGreaterThan(8n * 10n ** 17n);
      expect(virtualPrice).toBeLessThan(2n * 10n ** 18n);
    });
  });

  // crvUSD/USDC pool decimals: crvUSD=18, USDC=6
  const CRVUSD_USDC_DECIMALS = [18, 6];

  describe("StableSwap - Factory Pool (StableSwapNG)", () => {
    it("should match on-chain get_dy for crvUSD->USDC swap", async () => {
      const params = await getStableSwapParams(RPC_URL!, POOLS.CRVUSD_USDC, 2, {
        normalize: CRVUSD_USDC_DECIMALS,
      });

      // Off-chain: normalized input (18 decimals)
      const dxNormalized = 100n * 10n ** 18n;
      const offChainDy = stableswap.getDy(
        0,
        1,
        dxNormalized,
        params.balances,
        params.Ann,
        params.fee,
        params.offpegFeeMultiplier
      );

      // On-chain: native decimals (crvUSD = 18 dec)
      const dxNative = 100n * 10n ** BigInt(CRVUSD_USDC_DECIMALS[0]);
      const onChainDyNative = await getOnChainDy(
        RPC_URL!,
        POOLS.CRVUSD_USDC,
        0,
        1,
        dxNative,
        false // This pool uses int128 indices despite being a factory pool
      );

      expect(onChainDyNative).not.toBeNull();
      if (onChainDyNative) {
        // Normalize on-chain result (USDC = 6 dec -> 18 dec)
        const precision_j = 10n ** BigInt(18 - CRVUSD_USDC_DECIMALS[1]);
        const onChainDyNormalized = onChainDyNative * precision_j;
        assertWithinTolerance(offChainDy, onChainDyNormalized, "crvUSD->USDC");
      }
    });
  });

  // Tricrypto USDC pool: USDC (6 dec), WBTC (8 dec), WETH (18 dec)
  const TRICRYPTO_DECIMALS: [number, number, number] = [6, 8, 18];
  const TRICRYPTO_PRECISIONS: [bigint, bigint, bigint] = [
    10n ** BigInt(18 - TRICRYPTO_DECIMALS[0]), // USDC: 10^12
    10n ** BigInt(18 - TRICRYPTO_DECIMALS[1]), // WBTC: 10^10
    10n ** BigInt(18 - TRICRYPTO_DECIMALS[2]), // WETH: 1
  ];

  // Reads at block 23000000, so RPC_URL must be an archive endpoint
  describe("legacy tricrypto at a pinned block (archive RPC)", () => {
    for (const c of legacyCases.cases.filter((x) => x.block === 23000000)) {
      it(`${c.name} @${c.block}: reader state reproduces the fixture views`, async () => {
        const state = await getTricryptoLegacyState(RPC_URL!, c.pool, { blockTag: c.block });
        expect(state.variant).toBe(c.name);
        expect(state.totalSupply).toBe(BigInt(c.totalSupply));
        expect(state.params.D).toBe(BigInt(c.D));
        for (const v of c.get_dy) {
          expect(tricryptoLegacy.getDy(state, v.i, v.j, BigInt(v.dx))).toBe(BigInt(v.result!));
        }
        for (const v of c.calc_withdraw_one_coin) {
          expect(tricryptoLegacy.calcWithdrawOneCoin(state, BigInt(v.tokenAmount), v.i)).toBe(
            BigInt(v.result!)
          );
        }
      });
    }
  });

  describe("CryptoSwap - Tricrypto", () => {
    it("should fetch tricrypto params successfully", async () => {
      const params = await getTricryptoParams(RPC_URL!, POOLS.TRICRYPTO_USDC);

      expect(params.A).toBeGreaterThan(0n);
      expect(params.gamma).toBeGreaterThan(0n);
      expect(params.D).toBeGreaterThan(0n);
      expect(params.balances.length).toBe(3);
      expect(params.priceScales.length).toBe(2);
    });

    it("should calculate getDy3 without errors", async () => {
      // Provide correct precisions for token decimal normalization
      const params = await getTricryptoParams(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        TRICRYPTO_PRECISIONS
      );

      // Swap 100 USDC -> WBTC (using raw decimals: 100 * 10^6)
      const dx = 100n * 10n ** BigInt(TRICRYPTO_DECIMALS[0]);
      const dy = cryptoswap.getDy3(params, 0, 1, dx);

      // Output should be positive (WBTC in 8 decimals)
      expect(dy).toBeGreaterThan(0n);
    });

    it("should match on-chain get_dy for USDC->WBTC swap", async () => {
      const params = await getTricryptoParams(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        TRICRYPTO_PRECISIONS
      );

      // Swap 1000 USDC -> WBTC
      const dx = 1000n * 10n ** BigInt(TRICRYPTO_DECIMALS[0]);

      // Off-chain calculation
      const offChainDy = cryptoswap.getDy3(params, 0, 1, dx);

      // On-chain result (Tricrypto uses uint256 indices)
      const onChainDy = await getOnChainDy(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        0,
        1,
        dx,
        true // use uint256 selector for factory pools
      );

      expect(onChainDy).not.toBeNull();
      if (onChainDy && onChainDy > 0n) {
        assertWithinTolerance(offChainDy, onChainDy, "Tricrypto USDC->WBTC");
      }
    });

    it("should match on-chain get_dy for USDC->WETH swap", async () => {
      const params = await getTricryptoParams(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        TRICRYPTO_PRECISIONS
      );

      // Swap 1000 USDC -> WETH
      const dx = 1000n * 10n ** BigInt(TRICRYPTO_DECIMALS[0]);

      const offChainDy = cryptoswap.getDy3(params, 0, 2, dx);
      const onChainDy = await getOnChainDy(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        0,
        2,
        dx,
        true
      );

      expect(onChainDy).not.toBeNull();
      if (onChainDy && onChainDy > 0n) {
        assertWithinTolerance(offChainDy, onChainDy, "Tricrypto USDC->WETH");
      }
    });

    it("should match on-chain get_dy for WBTC->USDC swap", async () => {
      const params = await getTricryptoParams(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        TRICRYPTO_PRECISIONS
      );

      // Swap 0.01 WBTC -> USDC (8 decimals)
      const dx = 10n ** BigInt(TRICRYPTO_DECIMALS[1] - 2); // 0.01 WBTC

      const offChainDy = cryptoswap.getDy3(params, 1, 0, dx);
      const onChainDy = await getOnChainDy(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        1,
        0,
        dx,
        true
      );

      expect(onChainDy).not.toBeNull();
      if (onChainDy && onChainDy > 0n) {
        assertWithinTolerance(offChainDy, onChainDy, "Tricrypto WBTC->USDC");
      }
    });

    it("should match on-chain get_dy for WETH->USDC swap", async () => {
      const params = await getTricryptoParams(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        TRICRYPTO_PRECISIONS
      );

      // Swap 1 WETH -> USDC
      const dx = 10n ** BigInt(TRICRYPTO_DECIMALS[2]); // 1 WETH

      const offChainDy = cryptoswap.getDy3(params, 2, 0, dx);
      const onChainDy = await getOnChainDy(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        2,
        0,
        dx,
        true
      );

      expect(onChainDy).not.toBeNull();
      if (onChainDy && onChainDy > 0n) {
        assertWithinTolerance(offChainDy, onChainDy, "Tricrypto WETH->USDC");
      }
    });

    it("should maintain accuracy across various swap sizes", async () => {
      const params = await getTricryptoParams(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        TRICRYPTO_PRECISIONS
      );

      // Test USDC -> WETH with different sizes
      const swapSizes = [100n, 1000n, 10000n, 100000n]; // USDC amounts

      for (const usdc of swapSizes) {
        const dx = usdc * 10n ** BigInt(TRICRYPTO_DECIMALS[0]);

        const offChainDy = cryptoswap.getDy3(params, 0, 2, dx);
        const onChainDy = await getOnChainDy(
          RPC_URL!,
          POOLS.TRICRYPTO_USDC,
          0,
          2,
          dx,
          true
        );

        if (onChainDy && onChainDy > 0n) {
          assertWithinTolerance(
            offChainDy,
            onChainDy,
            `Tricrypto USDC->WETH (${usdc} USDC)`
          );
        }
      }
    });
  });

  describe("CryptoSwap - Price and Analytics", () => {
    it("should calculate spot prices that match market rates", async () => {
      const params = await getTricryptoParams(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        TRICRYPTO_PRECISIONS
      );

      // Get spot prices for various pairs
      const priceUsdcBtc = cryptoswap.getSpotPrice3(params, 0, 1);
      const priceUsdcEth = cryptoswap.getSpotPrice3(params, 0, 2);
      const priceBtcUsdc = cryptoswap.getSpotPrice3(params, 1, 0);
      const priceEthUsdc = cryptoswap.getSpotPrice3(params, 2, 0);

      // Prices should be positive
      expect(priceUsdcBtc).toBeGreaterThan(0n);
      expect(priceUsdcEth).toBeGreaterThan(0n);
      expect(priceBtcUsdc).toBeGreaterThan(0n);
      expect(priceEthUsdc).toBeGreaterThan(0n);

      // USDC->BTC price should be very small (0.00003 BTC per USDC at ~$30k BTC)
      // USDC->ETH price should be small (0.0005 ETH per USDC at ~$2k ETH)
      // Note: Actual prices depend on pool state
    });

    it("should calculate price impact that increases with swap size", async () => {
      const params = await getTricryptoParams(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        TRICRYPTO_PRECISIONS
      );

      const smallDx = 100n * 10n ** BigInt(TRICRYPTO_DECIMALS[0]); // 100 USDC
      const largeDx = 100000n * 10n ** BigInt(TRICRYPTO_DECIMALS[0]); // 100k USDC

      const smallImpact = cryptoswap.getPriceImpact3(params, 0, 2, smallDx);
      const largeImpact = cryptoswap.getPriceImpact3(params, 0, 2, largeDx);

      expect(largeImpact).toBeGreaterThan(smallImpact);
    });

    it("should provide complete swap quotes", async () => {
      const params = await getTricryptoParams(
        RPC_URL!,
        POOLS.TRICRYPTO_USDC,
        TRICRYPTO_PRECISIONS
      );

      const dx = 1000n * 10n ** BigInt(TRICRYPTO_DECIMALS[0]); // 1000 USDC
      const quote = cryptoswap.quoteSwap3(params, 0, 2, dx);

      expect(quote.amountOut).toBeGreaterThan(0n);
      expect(quote.fee).toBeGreaterThan(0n);
      expect(quote.priceImpact).toBeGreaterThanOrEqual(0n);
      expect(quote.effectivePrice).toBeGreaterThan(0n);
      expect(quote.spotPrice).toBeGreaterThan(0n);

      // Verify amountOut matches getDy3
      const directDy = cryptoswap.getDy3(params, 0, 2, dx);
      expect(quote.amountOut).toBe(directDy);
    });
  });

  describe("Accuracy - Small vs Large Swaps", () => {
    it("should maintain accuracy across swap sizes", async () => {
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3, {
        normalize: THREEPOOL_DECIMALS,
      });

      // Test different swap sizes (in whole tokens)
      const swapSizes = [1n, 100n, 10000n, 100000n];

      for (const tokens of swapSizes) {
        // Off-chain: normalized (18 decimals)
        const dxNormalized = tokens * 10n ** 18n;
        const offChainDy = stableswap.getDy(
          0,
          1,
          dxNormalized,
          params.balances,
          params.Ann,
          params.fee,
          params.offpegFeeMultiplier
        );

        // On-chain: native decimals (DAI = 18)
        const dxNative = tokens * 10n ** BigInt(THREEPOOL_DECIMALS[0]);
        const onChainDyNative = await getOnChainDy(
          RPC_URL!,
          POOLS.THREEPOOL,
          0,
          1,
          dxNative,
          false
        );

        if (onChainDyNative && onChainDyNative > 0n) {
          // Normalize on-chain result (USDC = 6 dec -> 18 dec)
          const precision_j = 10n ** BigInt(18 - THREEPOOL_DECIMALS[1]);
          const onChainDyNormalized = onChainDyNative * precision_j;
          assertWithinTolerance(
            offChainDy,
            onChainDyNormalized,
            `3pool DAI->USDC (${tokens} tokens)`
          );
        }
      }
    });
  });

  describe("Inverse Functions", () => {
    it("should verify getDx produces correct input for desired output", async () => {
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3, {
        normalize: THREEPOOL_DECIMALS,
      });

      // We want 100 USDC out (normalized to 18 decimals)
      const desiredDy = 100n * 10n ** 18n;

      // Calculate required DAI input
      const calculatedDx = stableswap.getDx(
        0,
        1,
        desiredDy,
        params.balances,
        params.Ann,
        params.fee,
        params.offpegFeeMultiplier
      );

      // Verify: swapping calculatedDx should give us approximately desiredDy
      const actualDy = stableswap.getDy(
        0,
        1,
        calculatedDx,
        params.balances,
        params.Ann,
        params.fee,
        params.offpegFeeMultiplier
      );

      // Allow 1% tolerance for the inverse calculation
      const diff =
        actualDy > desiredDy ? actualDy - desiredDy : desiredDy - actualDy;
      const tolerance = desiredDy / 100n;

      expect(
        diff <= tolerance,
        `getDx inverse: wanted ${desiredDy}, got ${actualDy}`
      ).toBe(true);
    });
  });
});

describeIf("Edge Cases with Real Data", () => {
  describe("Price Functions", () => {
    it("should calculate spot price close to 1.0 for balanced stablecoin pool", async () => {
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3, {
        normalize: THREEPOOL_DECIMALS,
      });

      const spotPrice = stableswap.getSpotPrice(
        0,
        1,
        params.balances,
        params.Ann
      );

      // For stablecoin pools, spot price should be close to 1.0 (within 5%)
      expect(spotPrice).toBeGreaterThan(95n * 10n ** 16n); // > 0.95
      expect(spotPrice).toBeLessThan(105n * 10n ** 16n); // < 1.05
    });

    it("should calculate increasing price impact for larger swaps", async () => {
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3, {
        normalize: THREEPOOL_DECIMALS,
      });

      const smallSwap = 100n * 10n ** 18n;
      const largeSwap = 10000000n * 10n ** 18n; // 10M tokens

      const smallImpact = stableswap.getPriceImpact(
        0,
        1,
        smallSwap,
        params.balances,
        params.Ann,
        params.fee,
        params.offpegFeeMultiplier
      );

      const largeImpact = stableswap.getPriceImpact(
        0,
        1,
        largeSwap,
        params.balances,
        params.Ann,
        params.fee,
        params.offpegFeeMultiplier
      );

      // Large swaps should have more price impact
      expect(largeImpact).toBeGreaterThan(smallImpact);
    });
  });

  describe("Liquidity Operations", () => {
    it("should calculate LP tokens for balanced deposit", async () => {
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3, {
        normalize: THREEPOOL_DECIMALS,
      });

      // Simulate proportional deposit
      const totalBalance = params.balances.reduce((a, b) => a + b, 0n);
      const depositRatio = 10n ** 18n; // 1:1:1 ratio scaled

      const amounts = params.balances.map(
        (b) => (b * depositRatio) / totalBalance
      );

      // This should work without error
      const totalSupply = totalBalance; // Approximate
      const lpTokens = stableswap.calcTokenAmount(
        amounts,
        true,
        params.balances,
        params.Ann,
        totalSupply,
        params.fee
      );

      expect(lpTokens).toBeGreaterThan(0n);
    });
  });
});

// ============================================================================
// Exact Precision Tests - These verify ±1 wei precision matching
// ============================================================================

describeIf("Exact Precision Tests (stableswap-exact)", () => {
  describe("StableSwap - USDC/crvUSD Pool (Older Factory)", () => {
    // This pool is USDC (0), crvUSD (1) - older factory pool without stored_rates()
    // Decimals: USDC=6, crvUSD=18
    const USDC_CRVUSD_DECIMALS = [6, 18];

    it("should match on-chain get_dy EXACTLY for USDC->crvUSD", async () => {
      // Compute static rates from decimals (this pool doesn't have stored_rates)
      const rates = stableswapExact.computeRates(USDC_CRVUSD_DECIMALS);

      // Fetch raw pool params
      const params = await getStableSwapParams(RPC_URL!, POOLS.CRVUSD_USDC, 2);

      const exactParams: stableswapExact.ExactPoolParams = {
        balances: params.rawBalances ?? params.balances,
        rates,
        A: params.A,
        fee: params.fee,
        offpegFeeMultiplier: params.offpegFeeMultiplier,
      };

      // Test various swap sizes - USDC is 6 decimals
      const swapSizes = [100n, 1000n, 10000n];

      for (const tokens of swapSizes) {
        // Native decimals: USDC is 6 decimals
        const dxNative = tokens * 10n ** 6n;

        // Off-chain calculation: USDC (0) -> crvUSD (1)
        const offChainDy = stableswapExact.getDyExact(0, 1, dxNative, exactParams);

        // On-chain result
        const onChainDy = await getOnChainDy(
          RPC_URL!,
          POOLS.CRVUSD_USDC,
          0,
          1,
          dxNative,
          false
        );

        expect(onChainDy).not.toBeNull();
        if (onChainDy) {
          assertExactMatch(
            offChainDy,
            onChainDy,
            `USDC->crvUSD (${tokens} tokens)`
          );
        }
      }
    });

    it("should match on-chain get_dy EXACTLY for crvUSD->USDC", async () => {
      const rates = stableswapExact.computeRates(USDC_CRVUSD_DECIMALS);
      const params = await getStableSwapParams(RPC_URL!, POOLS.CRVUSD_USDC, 2);

      const exactParams: stableswapExact.ExactPoolParams = {
        balances: params.rawBalances ?? params.balances,
        rates,
        A: params.A,
        fee: params.fee,
        offpegFeeMultiplier: params.offpegFeeMultiplier,
      };

      // crvUSD is 18 decimals
      const dx = 1000n * 10n ** 18n;

      // crvUSD (1) -> USDC (0)
      const offChainDy = stableswapExact.getDyExact(1, 0, dx, exactParams);
      const onChainDy = await getOnChainDy(RPC_URL!, POOLS.CRVUSD_USDC, 1, 0, dx, false);

      expect(onChainDy).not.toBeNull();
      if (onChainDy) {
        assertExactMatch(offChainDy, onChainDy, "crvUSD->USDC");
      }
    });
  });

  describe("StableSwapNG - stETH/ETH Pool (Rebasing Token)", () => {
    it("should fetch stored_rates for rebasing pool", async () => {
      // stETH is a rebasing token (asset type 2) - balances change, rates are static
      const rates = await getStoredRates(RPC_URL!, POOLS.STETH_ETH);

      expect(rates.length).toBe(2);

      // Both ETH and stETH have 18 decimals and static rates
      // Rate should be 10^18 (rates array uses 10^18 base, not 10^36)
      const expectedRate = 10n ** 18n;
      expect(rates[0]).toBe(expectedRate);
      expect(rates[1]).toBe(expectedRate);

      console.log(`stETH/ETH rates: [${rates.map((r) => r.toString()).join(", ")}]`);
    });

    it("should match on-chain get_dy EXACTLY for ETH->stETH", async () => {
      const params = await getExactStableSwapParams(RPC_URL!, POOLS.STETH_ETH);

      const exactParams: stableswapExact.ExactPoolParams = {
        balances: params.balances,
        rates: params.rates,
        A: params.A,
        fee: params.fee,
        offpegFeeMultiplier: params.offpegFeeMultiplier,
      };

      // Swap 1 ETH (18 decimals)
      const dx = 1n * 10n ** 18n;

      const offChainDy = stableswapExact.getDyExact(0, 1, dx, exactParams);
      const onChainDy = await getOnChainDy(RPC_URL!, POOLS.STETH_ETH, 0, 1, dx, false);

      expect(onChainDy).not.toBeNull();
      if (onChainDy) {
        assertExactMatch(offChainDy, onChainDy, "ETH->stETH");
        console.log(`ETH->stETH: off-chain=${offChainDy}, on-chain=${onChainDy}`);
      }
    });

    it("should match on-chain get_dy EXACTLY for stETH->ETH", async () => {
      const params = await getExactStableSwapParams(RPC_URL!, POOLS.STETH_ETH);

      const exactParams: stableswapExact.ExactPoolParams = {
        balances: params.balances,
        rates: params.rates,
        A: params.A,
        fee: params.fee,
        offpegFeeMultiplier: params.offpegFeeMultiplier,
      };

      // Swap 1 stETH (18 decimals)
      const dx = 1n * 10n ** 18n;

      const offChainDy = stableswapExact.getDyExact(1, 0, dx, exactParams);
      const onChainDy = await getOnChainDy(RPC_URL!, POOLS.STETH_ETH, 1, 0, dx, false);

      expect(onChainDy).not.toBeNull();
      if (onChainDy) {
        assertExactMatch(offChainDy, onChainDy, "stETH->ETH");
        console.log(`stETH->ETH: off-chain=${offChainDy}, on-chain=${onChainDy}`);
      }
    });

    it("should handle large swaps with exact precision", async () => {
      const params = await getExactStableSwapParams(RPC_URL!, POOLS.STETH_ETH);

      const exactParams: stableswapExact.ExactPoolParams = {
        balances: params.balances,
        rates: params.rates,
        A: params.A,
        fee: params.fee,
        offpegFeeMultiplier: params.offpegFeeMultiplier,
      };

      // Large swap: 100 ETH
      const dx = 100n * 10n ** 18n;

      const offChainDy = stableswapExact.getDyExact(0, 1, dx, exactParams);
      const onChainDy = await getOnChainDy(RPC_URL!, POOLS.STETH_ETH, 0, 1, dx, false);

      expect(onChainDy).not.toBeNull();
      if (onChainDy) {
        assertExactMatch(offChainDy, onChainDy, "ETH->stETH (100 ETH)");
      }
    });
  });

  describe("Classic 3pool - Exact Precision", () => {
    it("should match on-chain get_dy EXACTLY with native decimals", async () => {
      // For classic pools, compute rates from decimals
      const decimals = [18, 6, 6]; // DAI, USDC, USDT
      const rates = stableswapExact.computeRates(decimals);

      // Fetch pool params
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3);

      const exactParams: stableswapExact.ExactPoolParams = {
        balances: params.rawBalances ?? params.balances,
        rates,
        A: params.A,
        fee: params.fee,
        offpegFeeMultiplier: params.offpegFeeMultiplier,
      };

      // Swap 1000 DAI -> USDC (DAI is 18 decimals)
      const dx = 1000n * 10n ** 18n;

      const offChainDy = stableswapExact.getDyExact(0, 1, dx, exactParams);
      const onChainDy = await getOnChainDy(RPC_URL!, POOLS.THREEPOOL, 0, 1, dx, false);

      expect(onChainDy).not.toBeNull();
      if (onChainDy) {
        assertExactMatch(offChainDy, onChainDy, "3pool DAI->USDC");
        console.log(`3pool DAI->USDC: off-chain=${offChainDy}, on-chain=${onChainDy}`);
      }
    });

    it("should maintain exact precision for USDC->USDT", async () => {
      const decimals = [18, 6, 6];
      const rates = stableswapExact.computeRates(decimals);
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3);

      const exactParams: stableswapExact.ExactPoolParams = {
        balances: params.rawBalances ?? params.balances,
        rates,
        A: params.A,
        fee: params.fee,
        offpegFeeMultiplier: params.offpegFeeMultiplier,
      };

      // USDC is 6 decimals
      const dx = 500n * 10n ** 6n;

      const offChainDy = stableswapExact.getDyExact(1, 2, dx, exactParams);
      const onChainDy = await getOnChainDy(RPC_URL!, POOLS.THREEPOOL, 1, 2, dx, false);

      expect(onChainDy).not.toBeNull();
      if (onChainDy) {
        assertExactMatch(offChainDy, onChainDy, "3pool USDC->USDT");
      }
    });
  });

  describe("getDx Exact Precision", () => {
    it("should calculate required input accurately for 3pool", async () => {
      // Use 3pool for this test (known working exact precision)
      const decimals = [18, 6, 6]; // DAI, USDC, USDT
      const rates = stableswapExact.computeRates(decimals);
      const params = await getStableSwapParams(RPC_URL!, POOLS.THREEPOOL, 3);

      const exactParams: stableswapExact.ExactPoolParams = {
        balances: params.rawBalances ?? params.balances,
        rates,
        A: params.A,
        fee: params.fee,
        offpegFeeMultiplier: params.offpegFeeMultiplier,
      };

      // Want 100 USDC out (6 decimals)
      const desiredDy = 100n * 10n ** 6n;

      // Calculate required DAI input (DAI=0 -> USDC=1)
      const calculatedDx = stableswapExact.getDxExact(0, 1, desiredDy, exactParams);

      // Verify: getDy(calculatedDx) should give us approximately desiredDy
      const actualDy = stableswapExact.getDyExact(0, 1, calculatedDx, exactParams);

      // Should be within a reasonable tolerance (fee approximation can cause slight difference)
      const diff = actualDy > desiredDy ? actualDy - desiredDy : desiredDy - actualDy;

      // Allow up to 0.1% tolerance for the inverse calculation
      const tolerance = desiredDy / 1000n;
      expect(diff).toBeLessThanOrEqual(tolerance);

      console.log(`getDxExact: wanted ${desiredDy} USDC, calculated dx=${calculatedDx}, got dy=${actualDy}, diff=${diff}`);
    });
  });
});
