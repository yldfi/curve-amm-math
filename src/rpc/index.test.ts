/**
 * Unit tests for RPC utilities
 *
 * Tests pure functions directly and mocks network calls for integration-style tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SELECTORS,
  encodeUint256,
  encodeInt256,
  buildGetDyCalldata,
  buildGetDyFactoryCalldata,
  buildGetDxCalldata,
  buildBalancesCalldata,
  buildPriceScaleCalldata,
  buildBandsXCalldata,
  buildBandsYCalldata,
  buildPOracleUpCalldata,
  buildPreviewRedeemCalldata,
  buildCoinsCalldata,
  computePrecisions,
  normalizeBalances,
  batchRpcRawCalls,
  batchRpcCalls,
  getPoolCoins,
  getTokenDecimals,
  getPoolBalances,
  getStableSwapParams,
  getCryptoSwapParams,
  getYieldBasisVirtualPoolParams,
  getTricryptoParams,
  getOnChainDy,
  getOnChainDx,
  previewRedeem,
  getStoredRates,
  getNCoins,
  getExactStableSwapParams,
  getBlockNumber,
  getTriCrvParams,
  getLlamaLendAmmParams,
  getTricryptoLegacyState,
} from "./index";
import * as tricryptoLegacy from "../tricrypto-legacy";
import legacyCases from "../__fixtures__/legacy-tricrypto-cases.json";

function encodeWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodeAddress(address: string): string {
  return "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
}

function encodeSignedWord(value: bigint): string {
  return BigInt.asUintN(256, value).toString(16).padStart(64, "0");
}

// ============================================================================
// Pure Function Tests (no mocking required)
// ============================================================================

describe("SELECTORS", () => {
  it("should have correct function selectors", () => {
    // Verify a few well-known selectors
    expect(SELECTORS.DECIMALS).toBe("0x313ce567"); // decimals()
    expect(SELECTORS.A).toBe("0xf446c1d0"); // A()
    expect(SELECTORS.FEE).toBe("0xddca3f43"); // fee()
    expect(SELECTORS.BALANCES).toBe("0x4903b0d1"); // balances(uint256)
  });

  it("should have all expected selectors", () => {
    const expectedSelectors = [
      "GET_DY_INT128",
      "GET_DY_UINT256",
      "BALANCES",
      "A",
      "A_PRECISE",
      "FEE",
      "OFFPEG_FEE_MULTIPLIER",
      "COINS",
      "GAMMA",
      "D",
      "MID_FEE",
      "OUT_FEE",
      "FEE_GAMMA",
      "PRICE_SCALE",
      "PRICE_SCALE_I",
      "DECIMALS",
      "PREVIEW_REDEEM",
      "CONVERT_TO_ASSETS",
      "STORED_RATES",
      "N_COINS",
      "TOTAL_SUPPLY",
      "YB_AMM",
      "YB_POOL",
      "YB_GET_STATE",
      "GET_DX_UINT256",
      "ACTIVE_BAND",
      "MIN_BAND",
      "MAX_BAND",
      "BANDS_X",
      "BANDS_Y",
      "PRICE_ORACLE",
      "P_ORACLE_UP",
    ];

    for (const selector of expectedSelectors) {
      expect(SELECTORS).toHaveProperty(selector);
      expect((SELECTORS as Record<string, string>)[selector]).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });
});

describe("encodeUint256", () => {
  it("should encode zero", () => {
    expect(encodeUint256(0n)).toBe("0".repeat(64));
  });

  it("should encode 1", () => {
    expect(encodeUint256(1n)).toBe("0".repeat(63) + "1");
  });

  it("should encode large numbers", () => {
    const value = 10n ** 18n;
    const result = encodeUint256(value);
    expect(result).toHaveLength(64);
    expect(BigInt("0x" + result)).toBe(value);
  });

  it("should accept string input", () => {
    expect(encodeUint256("123")).toBe(encodeUint256(123n));
  });

  it("should accept number input", () => {
    expect(encodeUint256(123)).toBe(encodeUint256(123n));
  });

  it("should handle max uint256", () => {
    const maxUint256 = 2n ** 256n - 1n;
    const result = encodeUint256(maxUint256);
    expect(result).toHaveLength(64);
    expect(result).toBe("f".repeat(64));
  });
});

describe("encodeInt256", () => {
  it("should encode positive signed values", () => {
    expect(encodeInt256(1)).toBe("0".repeat(63) + "1");
  });

  it("should encode negative signed values as two's-complement", () => {
    expect(encodeInt256(-1)).toBe("f".repeat(64));
    expect(encodeInt256(-2)).toBe("f".repeat(63) + "e");
  });
});

describe("buildGetDyCalldata", () => {
  it("should build correct calldata for int128 indices", () => {
    const data = buildGetDyCalldata(0, 1, 1000n);
    // Should be: selector + i + j + dx
    expect(data).toMatch(/^0x5e0d443f/); // GET_DY_INT128 selector
    expect(data).toHaveLength(2 + 8 + 64 * 3); // 0x + selector + 3 params
  });

  it("should encode indices and amount correctly", () => {
    const data = buildGetDyCalldata(0, 1, 10n ** 18n);
    expect(data.slice(0, 10)).toBe(SELECTORS.GET_DY_INT128);
    // i = 0
    expect(data.slice(10, 74)).toBe("0".repeat(64));
    // j = 1
    expect(data.slice(74, 138)).toBe("0".repeat(63) + "1");
  });
});

describe("buildGetDyFactoryCalldata", () => {
  it("should build correct calldata for uint256 indices", () => {
    const data = buildGetDyFactoryCalldata(0, 1, 1000n);
    expect(data).toMatch(/^0x556d6e9f/); // GET_DY_UINT256 selector
    expect(data).toHaveLength(2 + 8 + 64 * 3); // 0x + selector + 3 params
  });
});

describe("buildGetDxCalldata", () => {
  it("should build correct calldata for uint256 get_dx", () => {
    const data = buildGetDxCalldata(0, 1, 1000n);
    expect(data).toMatch(/^0x37ed3a7a/);
    expect(data).toHaveLength(2 + 8 + 64 * 3);
  });
});

describe("buildBalancesCalldata", () => {
  it("should build correct calldata for balance query", () => {
    const data = buildBalancesCalldata(0);
    expect(data).toBe(SELECTORS.BALANCES + encodeUint256(0));
  });

  it("should handle different indices", () => {
    const data1 = buildBalancesCalldata(1);
    const data2 = buildBalancesCalldata(2);
    expect(data1).not.toBe(data2);
    expect(data1).toContain(encodeUint256(1));
    expect(data2).toContain(encodeUint256(2));
  });
});

describe("buildPriceScaleCalldata", () => {
  it("should build correct calldata for price_scale query", () => {
    const data = buildPriceScaleCalldata(0);
    expect(data).toBe(SELECTORS.PRICE_SCALE_I + encodeUint256(0));
  });
});

describe("LlamaLend calldata builders", () => {
  it("should build calldata for signed band lookups", () => {
    expect(buildBandsXCalldata(-1)).toBe(SELECTORS.BANDS_X + "f".repeat(64));
    expect(buildBandsYCalldata(-2)).toBe(
      SELECTORS.BANDS_Y + "f".repeat(63) + "e"
    );
    expect(buildPOracleUpCalldata(3)).toBe(
      SELECTORS.P_ORACLE_UP + encodeUint256(3)
    );
  });
});

describe("buildPreviewRedeemCalldata", () => {
  it("should build correct calldata for previewRedeem", () => {
    const shares = 10n ** 18n;
    const data = buildPreviewRedeemCalldata(shares);
    expect(data).toBe(SELECTORS.PREVIEW_REDEEM + encodeUint256(shares));
  });
});

describe("buildCoinsCalldata", () => {
  it("should build correct calldata for coins query", () => {
    const data = buildCoinsCalldata(0);
    expect(data).toBe(SELECTORS.COINS + encodeUint256(0));
  });
});

describe("computePrecisions", () => {
  it("should compute precisions for 18-decimal tokens", () => {
    const precisions = computePrecisions([18, 18]);
    expect(precisions).toEqual([1n, 1n]);
  });

  it("should compute precisions for 6-decimal tokens", () => {
    const precisions = computePrecisions([6, 6]);
    expect(precisions).toEqual([10n ** 12n, 10n ** 12n]);
  });

  it("should compute precisions for mixed decimals", () => {
    // DAI (18), USDC (6), USDT (6)
    const precisions = computePrecisions([18, 6, 6]);
    expect(precisions).toEqual([1n, 10n ** 12n, 10n ** 12n]);
  });

  it("should handle 8-decimal tokens (WBTC)", () => {
    const precisions = computePrecisions([8]);
    expect(precisions).toEqual([10n ** 10n]);
  });

  it("should throw for decimals > 18", () => {
    expect(() => computePrecisions([20])).toThrow("decimals[0] = 20 exceeds maximum of 18");
    expect(() => computePrecisions([18, 19])).toThrow("decimals[1] = 19 exceeds maximum of 18");
  });

  it("should throw for negative decimals", () => {
    expect(() => computePrecisions([-1])).toThrow("decimals[0] = -1 cannot be negative");
    expect(() => computePrecisions([6, -2])).toThrow("decimals[1] = -2 cannot be negative");
  });

  it("should handle edge case of 0 decimals", () => {
    const precisions = computePrecisions([0]);
    expect(precisions).toEqual([10n ** 18n]);
  });
});

describe("normalizeBalances", () => {
  it("should normalize 6-decimal balances to 18 decimals", () => {
    const balances = [1000000n]; // 1 USDC (6 decimals)
    const precisions = [10n ** 12n];
    const normalized = normalizeBalances(balances, precisions);
    expect(normalized).toEqual([10n ** 18n]); // 1 token in 18 decimals
  });

  it("should not change 18-decimal balances", () => {
    const balances = [10n ** 18n];
    const precisions = [1n];
    const normalized = normalizeBalances(balances, precisions);
    expect(normalized).toEqual([10n ** 18n]);
  });

  it("should normalize multiple balances", () => {
    const balances = [10n ** 18n, 10n ** 6n, 10n ** 6n]; // DAI, USDC, USDT
    const precisions = computePrecisions([18, 6, 6]);
    const normalized = normalizeBalances(balances, precisions);
    expect(normalized).toEqual([10n ** 18n, 10n ** 18n, 10n ** 18n]);
  });
});

// ============================================================================
// Mocked Network Tests
// ============================================================================

describe("batchRpcRawCalls", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns raw ABI data without bigint coercion", async () => {
    const tupleResult = "0x" + encodeWord(1n) + encodeWord(2n) + encodeWord(3n);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: tupleResult },
          { id: 1, result: "0x0" },
        ]),
    });

    const result = await batchRpcRawCalls("http://localhost:8545", [
      { to: "0x1", data: "0x1234" },
      { to: "0x2", data: "0x5678" },
    ]);

    expect(result).toEqual([tupleResult, "0x0"]);
  });
});

describe("batchRpcCalls", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return empty array for empty calls", async () => {
    const result = await batchRpcCalls("http://localhost:8545", []);
    expect(result).toEqual([]);
  });

  it("should batch multiple calls and return results", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x1" },
          { id: 1, result: "0x2" },
        ]),
    });

    const result = await batchRpcCalls("http://localhost:8545", [
      { to: "0x1", data: "0x1234" },
      { to: "0x2", data: "0x5678" },
    ]);

    expect(result).toEqual([1n, 2n]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("should handle null results", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x" },
          { id: 1, result: null },
        ]),
    });

    const result = await batchRpcCalls("http://localhost:8545", [
      { to: "0x1", data: "0x1234" },
      { to: "0x2", data: "0x5678" },
    ]);

    expect(result).toEqual([null, null]);
  });

  it("should fall back to individual calls for non-array batch responses", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ error: "batch requests are not supported" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 0, result: "0x2a" }),
      });

    const result = await batchRpcCalls("http://localhost:8545", [
      { to: "0x1", data: "0x1234" },
    ]);

    expect(result).toEqual([42n]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("should throw on HTTP error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    await expect(
      batchRpcCalls("http://localhost:8545", [{ to: "0x1", data: "0x1234" }])
    ).rejects.toThrow("RPC request failed: HTTP 500");
  });

  it("should throw on invalid JSON", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("Invalid JSON")),
    });

    await expect(
      batchRpcCalls("http://localhost:8545", [{ to: "0x1", data: "0x1234" }])
    ).rejects.toThrow("Invalid JSON response");
  });

  it("should sort results by id", async () => {
    // Return results out of order
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 1, result: "0x2" },
          { id: 0, result: "0x1" },
        ]),
    });

    const result = await batchRpcCalls("http://localhost:8545", [
      { to: "0x1", data: "0x1234" },
      { to: "0x2", data: "0x5678" },
    ]);

    expect(result).toEqual([1n, 2n]);
  });

  it("should timeout after specified duration", async () => {
    // Create a fetch that never resolves
    global.fetch = vi.fn().mockImplementation(() => {
      return new Promise((_, reject) => {
        // Simulate AbortError when controller.abort() is called
        setTimeout(() => {
          const error = new Error("AbortError");
          error.name = "AbortError";
          reject(error);
        }, 50);
      });
    });

    await expect(
      batchRpcCalls("http://localhost:8545", [{ to: "0x1", data: "0x1234" }], { timeout: 50 })
    ).rejects.toThrow("timed out after 50ms");
  });

  it("should use default timeout of 30000ms", async () => {
    // Verify fetch is called with signal
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 0, result: "0x1" }]),
    });

    await batchRpcCalls("http://localhost:8545", [{ to: "0x1", data: "0x1234" }]);

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:8545",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("should encode blockTag on batched and fallback calls", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ error: "batch requests are not supported" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 0, result: "0x2a" }),
      });

    const result = await batchRpcCalls(
      "http://localhost:8545",
      [{ to: "0x1", data: "0x1234" }],
      { blockTag: 123n }
    );

    expect(result).toEqual([42n]);
    const batchBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
    );
    const fallbackBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body
    );
    expect(batchBody[0].params[1]).toBe("0x7b");
    expect(fallbackBody.params[1]).toBe("0x7b");
  });
});

describe("getBlockNumber", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch the current block number", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1, result: "0x7b" }),
    });

    await expect(getBlockNumber("http://localhost:8545")).resolves.toBe(123n);
  });
});

describe("getYieldBasisVirtualPoolParams", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches and decodes YieldBasis virtual pool params", async () => {
    const virtualPoolAddress = "0x" + "1".repeat(40);
    const ammAddress = "0x" + "a".repeat(40);
    const poolAddress = "0x" + "b".repeat(40);

    const collateral = 5000n * 10n ** 18n;
    const debt = 500000n * 10n ** 18n;
    const x0 = 1100000n * 10n ** 18n;
    const fee = 10n ** 15n;
    const stableBalance = 1000000n * 10n ** 18n;
    const assetBalance = 500n * 10n ** 18n;
    const totalSupply = 10000n * 10n ** 18n;

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 0, result: encodeAddress(ammAddress) },
            { id: 1, result: encodeAddress(poolAddress) },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              id: 0,
              result:
                "0x" +
                encodeWord(collateral) +
                encodeWord(debt) +
                encodeWord(x0),
            },
            { id: 1, result: "0x" + encodeWord(fee) },
            { id: 2, result: "0x" + encodeWord(stableBalance) },
            { id: 3, result: "0x" + encodeWord(assetBalance) },
            { id: 4, result: "0x" + encodeWord(totalSupply) },
          ]),
      });

    const params = await getYieldBasisVirtualPoolParams(
      "http://localhost:8545",
      virtualPoolAddress
    );

    expect(params).toEqual({
      virtualPoolAddress,
      ammAddress,
      poolAddress,
      ammState: { collateral, debt, x0 },
      poolBalances: [stableBalance, assetBalance],
      poolTotalSupply: totalSupply,
      ammFee: fee,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("getPoolCoins", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch and decode coin addresses", async () => {
    const address1 = "0x" + "1".repeat(40);
    const address2 = "0x" + "2".repeat(40);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x" + "0".repeat(24) + "1".repeat(40) },
          { id: 1, result: "0x" + "0".repeat(24) + "2".repeat(40) },
        ]),
    });

    const coins = await getPoolCoins("http://localhost:8545", "0xpool", 2);
    expect(coins).toEqual([address1, address2]);
  });

  it("should return zero address for null results", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: null },
          { id: 1, result: "0x" },
        ]),
    });

    const coins = await getPoolCoins("http://localhost:8545", "0xpool", 2);
    expect(coins).toEqual([
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
    ]);
  });
});

describe("getTokenDecimals", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch token decimals", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x12" }, // 18
          { id: 1, result: "0x6" }, // 6
        ]),
    });

    const decimals = await getTokenDecimals("http://localhost:8545", [
      "0xtoken1",
      "0xtoken2",
    ]);
    expect(decimals).toEqual([18, 6]);
  });

  it("should default to 18 for null results", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: null },
          { id: 1, result: "0x6" },
        ]),
    });

    const decimals = await getTokenDecimals("http://localhost:8545", [
      "0xtoken1",
      "0xtoken2",
    ]);
    expect(decimals).toEqual([18, 6]);
  });
});

describe("getPoolBalances", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch pool balances", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x" + (10n ** 18n).toString(16) },
          { id: 1, result: "0x" + (10n ** 6n).toString(16) },
        ]),
    });

    const balances = await getPoolBalances("http://localhost:8545", "0xpool", 2);
    expect(balances).toEqual([10n ** 18n, 10n ** 6n]);
  });

  it("should default to 0 for null results", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: null },
          { id: 1, result: "0x" + (10n ** 6n).toString(16) },
        ]),
    });

    const balances = await getPoolBalances("http://localhost:8545", "0xpool", 2);
    expect(balances).toEqual([0n, 10n ** 6n]);
  });
});

describe("getStableSwapParams", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch and compute StableSwap params", async () => {
    const balance1 = 1000000n * 10n ** 18n;
    const balance2 = 1000000n * 10n ** 6n;
    const A = 100n;
    const fee = 4000000n; // 0.04%
    const offpegFee = 0n;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x" + balance1.toString(16) },
          { id: 1, result: "0x" + balance2.toString(16) },
          { id: 2, result: "0x" + A.toString(16) },
          { id: 3, result: "0x" + fee.toString(16) },
          { id: 4, result: "0x" + offpegFee.toString(16) },
        ]),
    });

    const params = await getStableSwapParams("http://localhost:8545", "0xpool", 2);

    expect(params.balances).toEqual([balance1, balance2]);
    expect(params.A).toBe(A);
    expect(params.fee).toBe(fee);
    expect(params.offpegFeeMultiplier).toBe(offpegFee);
    expect(params.nCoins).toBe(2);
    // Ann = A * A_PRECISION * N_COINS
    expect(params.Ann).toBe(A * 100n * 2n);
  });

  it("should normalize balances when option is set", async () => {
    const balance1 = 1000000n * 10n ** 18n; // 1M tokens in 18 dec
    const balance2 = 1000000n * 10n ** 6n; // 1M tokens in 6 dec
    const A = 100n;
    const fee = 4000000n;
    const offpegFee = 0n;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x" + balance1.toString(16) },
          { id: 1, result: "0x" + balance2.toString(16) },
          { id: 2, result: "0x" + A.toString(16) },
          { id: 3, result: "0x" + fee.toString(16) },
          { id: 4, result: "0x" + offpegFee.toString(16) },
        ]),
    });

    const params = await getStableSwapParams("http://localhost:8545", "0xpool", 2, {
      normalize: [18, 6],
    });

    // Both should be normalized to 18 decimals now
    expect(params.balances[0]).toBe(balance1); // Already 18 dec
    expect(params.balances[1]).toBe(balance2 * 10n ** 12n); // 6 dec -> 18 dec
    expect(params.rawBalances).toEqual([balance1, balance2]);
    expect(params.decimals).toEqual([18, 6]);
    expect(params.precisions).toEqual([1n, 10n ** 12n]);
  });
});

describe("getCryptoSwapParams", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch CryptoSwap params", async () => {
    const balance1 = 10n ** 18n;
    const balance2 = 10n ** 18n;
    const A = 400000n;
    const gamma = 10n ** 15n;
    const D = 10n ** 24n;
    const midFee = 4000000n;
    const outFee = 40000000n;
    const feeGamma = 10n ** 16n;
    const priceScale = 10n ** 18n;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x" + balance1.toString(16) },
          { id: 1, result: "0x" + balance2.toString(16) },
          { id: 2, result: "0x" + A.toString(16) },
          { id: 3, result: "0x" + gamma.toString(16) },
          { id: 4, result: "0x" + D.toString(16) },
          { id: 5, result: "0x" + midFee.toString(16) },
          { id: 6, result: "0x" + outFee.toString(16) },
          { id: 7, result: "0x" + feeGamma.toString(16) },
          { id: 8, result: "0x" + priceScale.toString(16) },
        ]),
    });

    const params = await getCryptoSwapParams("http://localhost:8545", "0xpool");

    expect(params.A).toBe(A);
    expect(params.gamma).toBe(gamma);
    expect(params.D).toBe(D);
    expect(params.midFee).toBe(midFee);
    expect(params.outFee).toBe(outFee);
    expect(params.feeGamma).toBe(feeGamma);
    expect(params.priceScale).toBe(priceScale);
    expect(params.balances).toEqual([balance1, balance2]);
    expect(params.precisions).toEqual([1n, 1n]); // Default
  });

  it("should use provided precisions", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve(
          Array(9)
            .fill(null)
            .map((_, i) => ({ id: i, result: "0x1" }))
        ),
    });

    const precisions: [bigint, bigint] = [10n ** 12n, 1n];
    const params = await getCryptoSwapParams(
      "http://localhost:8545",
      "0xpool",
      { precisions }
    );

    expect(params.precisions).toEqual(precisions);
  });
});

describe("getTricryptoParams", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch Tricrypto params with 3 balances and 2 price scales", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x" + (10n ** 18n).toString(16) }, // balance0
          { id: 1, result: "0x" + (10n ** 18n).toString(16) }, // balance1
          { id: 2, result: "0x" + (10n ** 18n).toString(16) }, // balance2
          { id: 3, result: "0x" + (400000n).toString(16) }, // A
          { id: 4, result: "0x" + (10n ** 15n).toString(16) }, // gamma
          { id: 5, result: "0x" + (10n ** 24n).toString(16) }, // D
          { id: 6, result: "0x" + (4000000n).toString(16) }, // midFee
          { id: 7, result: "0x" + (40000000n).toString(16) }, // outFee
          { id: 8, result: "0x" + (10n ** 16n).toString(16) }, // feeGamma
          { id: 9, result: "0x" + (10n ** 18n).toString(16) }, // priceScale0
          { id: 10, result: "0x" + (10n ** 18n).toString(16) }, // priceScale1
        ]),
    });

    const params = await getTricryptoParams("http://localhost:8545", "0xpool");

    expect(params.balances).toHaveLength(3);
    expect(params.priceScales).toHaveLength(2);
    expect(params.precisions).toEqual([1n, 1n, 1n]); // Default
  });
});

describe("getTriCrvParams", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch classic 3pool params with triCRV rates", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 0, result: "0x" + (1_000_000n * 10n ** 18n).toString(16) },
          { id: 1, result: "0x" + (1_000_000n * 10n ** 6n).toString(16) },
          { id: 2, result: "0x" + (1_000_000n * 10n ** 6n).toString(16) },
          { id: 3, result: "0x" + (2000n).toString(16) },
          { id: 4, result: "0x" + (1_000_000n).toString(16) },
          { id: 5, result: "0x" + (0n).toString(16) },
        ]),
    });

    const params = await getTriCrvParams("http://localhost:8545");

    expect(params.nCoins).toBe(3);
    expect(params.balances).toEqual([
      1_000_000n * 10n ** 18n,
      1_000_000n * 10n ** 6n,
      1_000_000n * 10n ** 6n,
    ]);
    expect(params.rates).toEqual([10n ** 18n, 10n ** 30n, 10n ** 30n]);
    expect(params.A).toBe(2000n);
  });
});

describe("getLlamaLendAmmParams", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch signed bands and precision-scaled LLAMMA params", async () => {
    const amm = "0x1111111111111111111111111111111111111111";
    const borrowed = "0x2222222222222222222222222222222222222222";
    const collateral = "0x3333333333333333333333333333333333333333";

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 0, result: "0x" + encodeWord(100n) },
            { id: 1, result: "0x" + encodeWord(6n * 10n ** 15n) },
            { id: 2, result: "0x" + encodeSignedWord(-1n) },
            { id: 3, result: "0x" + encodeSignedWord(-2n) },
            { id: 4, result: "0x" + encodeSignedWord(0n) },
            { id: 5, result: "0x" + encodeWord(2000n * 10n ** 18n) },
            { id: 6, result: encodeAddress(borrowed) },
            { id: 7, result: encodeAddress(collateral) },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 0, result: "0x" + encodeWord(18n) },
            { id: 1, result: "0x" + encodeWord(6n) },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 0, result: "0x" + encodeWord(2010n * 10n ** 18n) },
            { id: 1, result: "0x" + encodeWord(12n * 10n ** 18n) },
            { id: 2, result: "0x" + encodeWord(0n) },
            { id: 3, result: "0x" + encodeWord(8n * 10n ** 18n) },
            { id: 4, result: "0x" + encodeWord(5n * 10n ** 18n) },
            { id: 5, result: "0x" + encodeWord(0n) },
            { id: 6, result: "0x" + encodeWord(9n * 10n ** 18n) },
          ]),
      });

    const params = await getLlamaLendAmmParams(
      "http://localhost:8545",
      amm
    );

    expect(params.activeBand).toBe(-1);
    expect(params.minBand).toBe(-2);
    expect(params.maxBand).toBe(0);
    expect(params.pOracleUp).toBe(2010n * 10n ** 18n);
    expect(params.coins).toEqual([borrowed, collateral]);
    expect(params.decimals).toEqual([18, 6]);
    expect(params.borrowedPrecision).toBe(1n);
    expect(params.collateralPrecision).toBe(10n ** 12n);
    expect(params.fetchedBands).toEqual([-2, -1, 0]);
    expect((params.bandsX as Record<number, bigint>)[-2]).toBe(12n * 10n ** 18n);
    expect((params.bandsY as Record<number, bigint>)[-1]).toBe(5n * 10n ** 18n);
  });

  it("should enforce the band fetch safety cap", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 0, result: "0x" + encodeWord(100n) },
            { id: 1, result: "0x" + encodeWord(6n * 10n ** 15n) },
            { id: 2, result: "0x" + encodeSignedWord(0n) },
            { id: 3, result: "0x" + encodeSignedWord(0n) },
            { id: 4, result: "0x" + encodeSignedWord(10n) },
            { id: 5, result: "0x" + encodeWord(2000n * 10n ** 18n) },
            { id: 6, result: encodeAddress("0x2222222222222222222222222222222222222222") },
            { id: 7, result: encodeAddress("0x3333333333333333333333333333333333333333") },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 0, result: "0x" + encodeWord(18n) },
            { id: 1, result: "0x" + encodeWord(18n) },
          ]),
      });

    await expect(
      getLlamaLendAmmParams("http://localhost:8545", "0xamm", {
        maxBandFetch: 2,
      })
    ).rejects.toThrow("refusing to fetch 11 bands");
  });
});

describe("getOnChainDy", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return dy result", async () => {
    const dy = 999n * 10n ** 18n;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 0, result: "0x" + dy.toString(16) }]),
    });

    const result = await getOnChainDy(
      "http://localhost:8545",
      "0xpool",
      0,
      1,
      10n ** 18n
    );

    expect(result).toBe(dy);
  });

  it("should use factory selector when specified", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 0, result: "0x1" }]),
    });

    await getOnChainDy("http://localhost:8545", "0xpool", 0, 1, 10n ** 18n, true);

    // Check that the factory selector was used
    const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body[0].params[0].data).toMatch(/^0x556d6e9f/); // GET_DY_UINT256
  });

  it("should return null for empty result", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 0, result: "0x" }]),
    });

    const result = await getOnChainDy(
      "http://localhost:8545",
      "0xpool",
      0,
      1,
      10n ** 18n
    );

    expect(result).toBeNull();
  });
});

describe("getOnChainDx", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return dx result", async () => {
    const dx = 1001n * 10n ** 18n;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 0, result: "0x" + dx.toString(16) }]),
    });

    const result = await getOnChainDx(
      "http://localhost:8545",
      "0xpool",
      0,
      1,
      10n ** 18n
    );

    expect(result).toBe(dx);
  });
});

describe("previewRedeem", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return preview redeem result", async () => {
    const assets = 10n ** 18n;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 0, result: "0x" + assets.toString(16) }]),
    });

    const result = await previewRedeem(
      "http://localhost:8545",
      "0xvault",
      10n ** 18n
    );

    expect(result).toBe(assets);
  });

  it("should throw on null result", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 0, result: null }]),
    });

    await expect(
      previewRedeem("http://localhost:8545", "0xvault", 10n ** 18n)
    ).rejects.toThrow("Failed to preview redeem");
  });
});

describe("getStoredRates", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should decode static array of rates", async () => {
    const rate1 = 10n ** 18n;
    const rate2 = 10n ** 18n;
    // Static array encoding: just concatenated values
    const resultData =
      "0x" +
      rate1.toString(16).padStart(64, "0") +
      rate2.toString(16).padStart(64, "0");

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: resultData }),
    });

    const rates = await getStoredRates("http://localhost:8545", "0xpool");

    expect(rates).toEqual([rate1, rate2]);
  });

  it("should decode dynamic array of rates", async () => {
    // Dynamic array: offset (32) + length (2) + elements
    const offset = 32n;
    const length = 2n;
    const rate1 = 10n ** 18n;
    const rate2 = 10n ** 18n;

    const resultData =
      "0x" +
      offset.toString(16).padStart(64, "0") + // offset to array data
      length.toString(16).padStart(64, "0") + // array length
      rate1.toString(16).padStart(64, "0") + // element 0
      rate2.toString(16).padStart(64, "0"); // element 1

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: resultData }),
    });

    const rates = await getStoredRates("http://localhost:8545", "0xpool");

    expect(rates).toEqual([rate1, rate2]);
  });

  it("should throw on empty result", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: "0x" }),
    });

    await expect(
      getStoredRates("http://localhost:8545", "0xpool")
    ).rejects.toThrow("Failed to fetch stored_rates");
  });
});

describe("getNCoins", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return number of coins", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 0, result: "0x2" }]),
    });

    const nCoins = await getNCoins("http://localhost:8545", "0xpool");
    expect(nCoins).toBe(2);
  });

  it("should throw on null result", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 0, result: null }]),
    });

    await expect(getNCoins("http://localhost:8545", "0xpool")).rejects.toThrow(
      "Failed to fetch N_COINS"
    );
  });
});

describe("getExactStableSwapParams", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fetch exact params with stored_rates", async () => {
    const balance1 = 10n ** 24n;
    const balance2 = 10n ** 24n;
    const A = 100n;
    const fee = 4000000n;
    const offpegFee = 0n;
    const rate = 10n ** 18n;

    // First call gets N_COINS and stored_rates
    // Second call gets balances, A, fee, offpeg
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        // N_COINS and stored_rates calls (parallel)
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: 0, result: "0x2" }, // N_COINS
            ]),
        });
      }
      // Subsequent batched calls
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 0, result: "0x" + balance1.toString(16) },
            { id: 1, result: "0x" + balance2.toString(16) },
            { id: 2, result: "0x" + A.toString(16) },
            { id: 3, result: "0x" + fee.toString(16) },
            { id: 4, result: "0x" + offpegFee.toString(16) },
          ]),
      });
    });

    // Mock stored_rates separately
    const storedRatesResult =
      "0x" +
      rate.toString(16).padStart(64, "0") +
      rate.toString(16).padStart(64, "0");

    global.fetch = vi.fn().mockImplementation((_, options) => {
      const body = JSON.parse(options.body);
      if (!Array.isArray(body)) {
        // Single call for stored_rates
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: storedRatesResult }),
        });
      }
      if (body[0]?.params?.[0]?.data === "0x29357750") {
        // N_COINS
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ id: 0, result: "0x2" }]),
        });
      }
      // Balances + params
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 0, result: "0x" + balance1.toString(16) },
            { id: 1, result: "0x" + balance2.toString(16) },
            { id: 2, result: "0x" + A.toString(16) },
            { id: 3, result: "0x" + fee.toString(16) },
            { id: 4, result: "0x" + offpegFee.toString(16) },
          ]),
      });
    });

    const params = await getExactStableSwapParams("http://localhost:8545", "0xpool");

    expect(params.nCoins).toBe(2);
    expect(params.A).toBe(A);
    expect(params.fee).toBe(fee);
    expect(params.rates).toHaveLength(2);
    expect(params.balances).toHaveLength(2);
  });
});

describe("pinned-block param readers", () => {
  const originalFetch = global.fetch;
  const word = "0x" + "1".padStart(64, "0");
  let tags: string[];

  beforeEach(() => {
    tags = [];
    global.fetch = vi.fn().mockImplementation((_, options) => {
      const body = JSON.parse(options.body);
      const requests = Array.isArray(body) ? body : [body];
      tags.push(...requests.map((r: { params: unknown[] }) => r.params[1] as string));
      const results = requests.map((r: { id: number }) => ({ id: r.id, result: word }));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(Array.isArray(body) ? results : { result: word + "1".padStart(64, "0") }),
      });
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reads every view at the given blockTag", async () => {
    await getStableSwapParams("http://localhost:8545", "0xpool", 2, {
      blockTag: 26236847,
      normalize: true,
    });
    await getCryptoSwapParams("http://localhost:8545", "0xpool", { blockTag: 26236847 });
    await getTricryptoParams("http://localhost:8545", "0xpool", { blockTag: 26236847 });
    await getTriCrvParams("http://localhost:8545", "0xpool", { blockTag: 26236847 });
    await getExactStableSwapParams("http://localhost:8545", "0xpool", { blockTag: 26236847 });

    expect(tags.length).toBeGreaterThan(30);
    expect(new Set(tags)).toEqual(new Set(["0x" + (26236847).toString(16)]));
  });

  it("defaults to latest", async () => {
    await getExactStableSwapParams("http://localhost:8545", "0xpool");
    expect(new Set(tags)).toEqual(new Set(["latest"]));
  });
});

describe("getTricryptoLegacyState", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  type Case = (typeof legacyCases.cases)[number];

  // Answers eth_call from a fixture state, as the pool, LP token and coins would
  function fakeChain(c: Case, seenBlockTags: string[], omit?: string) {
    const pool = c.pool;
    const word = (x: string | bigint) => "0x" + encodeWord(BigInt(x));
    const answers = new Map<string, string>();
    const at = (to: string, data: string, value: string | bigint) =>
      answers.set(`${to.toLowerCase()}:${data}`, word(value));
    [0, 1, 2].forEach((k) => at(pool, buildBalancesCalldata(k), c.balances[k]));
    [0, 1].forEach((k) => at(pool, buildPriceScaleCalldata(k), c.price_scale[k]));
    [0, 1, 2].forEach((k) => at(pool, buildCoinsCalldata(k), c.coins[k]));
    at(pool, SELECTORS.A, c.A);
    if (c.A_precise !== null) at(pool, SELECTORS.A_PRECISE, c.A_precise);
    at(pool, SELECTORS.GAMMA, c.gamma);
    at(pool, SELECTORS.D, c.D);
    at(pool, SELECTORS.MID_FEE, c.mid_fee);
    at(pool, SELECTORS.OUT_FEE, c.out_fee);
    at(pool, SELECTORS.FEE_GAMMA, c.fee_gamma);
    at(pool, "0xf9ed9597", c.future_A_gamma_time);
    at(pool, "0xfc0c546a", c.token);
    at(c.token, SELECTORS.TOTAL_SUPPLY, c.totalSupply);
    c.coins.forEach((coin, k) => at(coin, SELECTORS.DECIMALS, BigInt(c.decimals[k])));
    if (omit) answers.delete(`${pool}:${omit}`);

    return vi.fn().mockImplementation((_url: string, init: { body: string }) => {
      const batch = JSON.parse(init.body) as {
        id: number;
        params: [{ to: string; data: string }, string];
      }[];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            batch.map(({ id, params: [call, blockTag] }) => {
              seenBlockTags.push(blockTag);
              const result = answers.get(`${call.to.toLowerCase()}:${call.data}`);
              return result
                ? { jsonrpc: "2.0", id, result }
                : { jsonrpc: "2.0", id, error: { code: -32000, message: "execution reverted" } };
            })
          ),
      });
    });
  }

  for (const c of legacyCases.cases.filter((x) => x.block === 23000000)) {
    it(`${c.name}: reads the state the views were computed from`, async () => {
      const seen: string[] = [];
      global.fetch = fakeChain(c, seen);
      const state = await getTricryptoLegacyState("http://localhost:8545", c.pool, {
        blockTag: c.block,
      });

      expect(seen.every((t) => t === "0x" + c.block.toString(16))).toBe(true);
      expect(state.variant).toBe(c.name);
      expect(state.totalSupply).toBe(BigInt(c.totalSupply));
      expect(state.params).toEqual({
        A: c.A_precise !== null ? BigInt(c.A_precise) * 100n : BigInt(c.A),
        gamma: BigInt(c.gamma),
        D: BigInt(c.D),
        midFee: BigInt(c.mid_fee),
        outFee: BigInt(c.out_fee),
        feeGamma: BigInt(c.fee_gamma),
        priceScales: c.price_scale.map(BigInt),
        balances: c.balances.map(BigInt),
        precisions: c.precisions.map(BigInt),
        futureAGammaTime: BigInt(c.future_A_gamma_time),
      });
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

  it("throws when a required view fails instead of assuming a value", async () => {
    const c = legacyCases.cases.find((x) => x.name === "tricrypto2")!;
    global.fetch = fakeChain(c, [], SELECTORS.D);
    await expect(getTricryptoLegacyState("http://localhost:8545", c.pool)).rejects.toThrow(
      "getTricryptoLegacyState: D() failed"
    );
  });

  it("does not mistake tricrypto v1 for tricrypto2 when A_precise() errors", async () => {
    const c = legacyCases.cases.find((x) => x.name === "tricrypto-v1" && x.block === 23000000)!;
    global.fetch = fakeChain(c, [], SELECTORS.A_PRECISE);
    await expect(getTricryptoLegacyState("http://localhost:8545", c.pool)).rejects.toThrow(
      "getTricryptoLegacyState: A_precise() failed"
    );
  });

  it("honours an explicit variant", async () => {
    const c = legacyCases.cases.find((x) => x.name === "tricrypto-v1" && x.block === 23000000)!;
    global.fetch = fakeChain(c, []);
    const state = await getTricryptoLegacyState("http://localhost:8545", c.pool, {
      variant: "tricrypto2",
    });
    expect(state.variant).toBe("tricrypto2");
    expect(state.params.A).toBe(BigInt(c.A));
  });
});
