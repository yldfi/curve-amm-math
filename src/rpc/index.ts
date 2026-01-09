/**
 * Curve RPC Utilities
 *
 * Optional helpers for fetching pool parameters via JSON-RPC.
 * These require a fetch-compatible environment and RPC endpoint.
 *
 * @example
 * ```typescript
 * import { rpc } from 'curve-amm-math/rpc';
 *
 * const params = await rpc.getStableSwapParams(
 *   'https://eth.llamarpc.com',
 *   '0xc50e...'  // Pool address
 * );
 *
 * // Use with math functions
 * import { stableswap } from 'curve-amm-math';
 * const dy = stableswap.getDy(0, 1, 10n * 10n**18n, params.balances, params.Ann, params.fee, params.offpegFeeMultiplier);
 * ```
 */

import type { StableSwapPoolParams } from "../stableswap";
import type { CryptoSwapParams, TricryptoParams } from "../cryptoswap";
import { A_PRECISION } from "../stableswap";

// Function selectors (4-byte function signatures)
export const SELECTORS = {
  // StableSwap pool functions
  GET_DY_INT128: "0x5e0d443f", // get_dy(int128,int128,uint256)
  GET_DY_UINT256: "0x556d6e9f", // get_dy(uint256,uint256,uint256)
  BALANCES: "0x4903b0d1", // balances(uint256)
  A: "0xf446c1d0", // A()
  A_PRECISE: "0x76a2f0f0", // A_precise()
  FEE: "0xddca3f43", // fee()
  OFFPEG_FEE_MULTIPLIER: "0x8edfdd5f", // offpeg_fee_multiplier()
  COINS: "0xc6610657", // coins(uint256) - returns token address at index

  // CryptoSwap pool functions
  GAMMA: "0xb1373929", // gamma()
  D: "0x0f529ba2", // D()
  MID_FEE: "0x92526c0c", // mid_fee()
  OUT_FEE: "0xee8de675", // out_fee()
  FEE_GAMMA: "0x72d4f0e2", // fee_gamma()
  PRICE_SCALE: "0xb9e8c9fd", // price_scale() for 2-coin
  PRICE_SCALE_I: "0xa3f7cdd5", // price_scale(uint256) for N>2 coins

  // ERC20 token functions
  DECIMALS: "0x313ce567", // decimals() - returns token decimals

  // ERC4626 vault functions
  PREVIEW_REDEEM: "0x4cdad506", // previewRedeem(uint256)
  CONVERT_TO_ASSETS: "0x07a2d13a", // convertToAssets(uint256)

  // StableSwapNG specific
  STORED_RATES: "0xfd0684b1", // stored_rates() - returns dynamic rates
  N_COINS: "0x29357750", // N_COINS() - returns number of coins
} as const;

interface RpcCall {
  to: string;
  data: string;
}

interface RpcBatchResult {
  id: number;
  result?: string;
  error?: { message: string };
}

/**
 * Encode a uint256 parameter for calldata
 */
export function encodeUint256(value: bigint | string | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

/**
 * Options for batch RPC calls
 */
export interface BatchRpcOptions {
  /**
   * If true, throw an error if any RPC call fails or returns null.
   * Default: false (returns null for failed calls)
   */
  strict?: boolean;
  /**
   * Timeout in milliseconds for the RPC request.
   * Default: 30000 (30 seconds)
   */
  timeout?: number;
}

/**
 * Execute multiple eth_call requests in a single HTTP request
 * Reduces latency by batching RPC calls
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param calls - Array of { to, data } call objects
 * @param options - Optional settings (strict mode, etc.)
 * @returns Array of bigint results (null if call failed and not in strict mode)
 * @throws Error if strict mode is enabled and any call fails
 */
export async function batchRpcCalls(
  rpcUrl: string,
  calls: RpcCall[],
  options: BatchRpcOptions = {}
): Promise<(bigint | null)[]> {
  if (calls.length === 0) return [];

  const batch = calls.map((call, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, "latest"],
  }));

  // Set up timeout with AbortController
  const timeout = options.timeout ?? 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`RPC request timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  // Check HTTP status before parsing JSON
  if (!response.ok) {
    throw new Error(
      `RPC request failed: HTTP ${response.status} ${response.statusText}`
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error(`RPC request failed: Invalid JSON response from ${rpcUrl}`);
  }

  // Handle case where response is not an array
  if (!Array.isArray(json)) {
    if (options.strict) {
      throw new Error("RPC batch response is not an array");
    }
    return calls.map(() => null);
  }

  const results = json as RpcBatchResult[];
  results.sort((a, b) => a.id - b.id);

  const parsed = results.map((r, idx) => {
    if (r.error) {
      if (options.strict) {
        throw new Error(`RPC call ${idx} failed: ${r.error.message} (to: ${calls[idx].to})`);
      }
      return null;
    }
    if (r.result && r.result !== "0x" && r.result !== "0x0") {
      return BigInt(r.result);
    }
    if (options.strict) {
      throw new Error(`RPC call ${idx} returned empty result (to: ${calls[idx].to})`);
    }
    return null;
  });

  return parsed;
}

/**
 * Build calldata for get_dy (int128 indices - old-style pools)
 */
export function buildGetDyCalldata(i: number, j: number, dx: bigint | string): string {
  return SELECTORS.GET_DY_INT128 + encodeUint256(i) + encodeUint256(j) + encodeUint256(dx);
}

/**
 * Build calldata for get_dy (uint256 indices - factory pools)
 */
export function buildGetDyFactoryCalldata(i: number, j: number, dx: bigint | string): string {
  return SELECTORS.GET_DY_UINT256 + encodeUint256(i) + encodeUint256(j) + encodeUint256(dx);
}

/**
 * Build calldata for balances(uint256)
 */
export function buildBalancesCalldata(index: number): string {
  return SELECTORS.BALANCES + encodeUint256(index);
}

/**
 * Build calldata for price_scale(uint256)
 */
export function buildPriceScaleCalldata(index: number): string {
  return SELECTORS.PRICE_SCALE_I + encodeUint256(index);
}

/**
 * Build calldata for previewRedeem(uint256)
 */
export function buildPreviewRedeemCalldata(shares: bigint | string): string {
  return SELECTORS.PREVIEW_REDEEM + encodeUint256(shares);
}

/**
 * Build calldata for coins(uint256)
 */
export function buildCoinsCalldata(index: number): string {
  return SELECTORS.COINS + encodeUint256(index);
}

/**
 * Fetch token addresses from a Curve pool
 */
export async function getPoolCoins(
  rpcUrl: string,
  poolAddress: string,
  numCoins: number = 2
): Promise<string[]> {
  const calls = Array.from({ length: numCoins }, (_, i) => ({
    to: poolAddress,
    data: buildCoinsCalldata(i),
  }));

  const results = await batchRpcCalls(rpcUrl, calls);
  return results.map((r) => {
    if (r === null) return "0x0000000000000000000000000000000000000000";
    // Convert bigint to address (last 20 bytes)
    return "0x" + r.toString(16).padStart(40, "0");
  });
}

/**
 * Fetch decimals for multiple token addresses
 */
export async function getTokenDecimals(
  rpcUrl: string,
  tokenAddresses: string[]
): Promise<number[]> {
  const calls = tokenAddresses.map((addr) => ({
    to: addr,
    data: SELECTORS.DECIMALS,
  }));

  const results = await batchRpcCalls(rpcUrl, calls);
  return results.map((r) => (r !== null ? Number(r) : 18)); // Default to 18 if fetch fails
}

/**
 * Compute precision multipliers from token decimals
 * precision[i] = 10^(18 - decimals[i])
 * @throws Error if any decimal is > 18 (would require negative exponent)
 */
export function computePrecisions(decimals: number[]): bigint[] {
  return decimals.map((d, i) => {
    if (d > 18) {
      throw new Error(
        `computePrecisions: decimals[${i}] = ${d} exceeds maximum of 18`
      );
    }
    if (d < 0) {
      throw new Error(
        `computePrecisions: decimals[${i}] = ${d} cannot be negative`
      );
    }
    return 10n ** BigInt(18 - d);
  });
}

/**
 * Normalize balances to 18 decimals using precisions
 * normalizedBalance[i] = balance[i] * precision[i]
 */
export function normalizeBalances(balances: bigint[], precisions: bigint[]): bigint[] {
  return balances.map((b, i) => b * precisions[i]);
}

/**
 * Fetch pool balances
 */
export async function getPoolBalances(
  rpcUrl: string,
  poolAddress: string,
  numCoins: number = 2
): Promise<bigint[]> {
  const calls = Array.from({ length: numCoins }, (_, i) => ({
    to: poolAddress,
    data: buildBalancesCalldata(i),
  }));

  const results = await batchRpcCalls(rpcUrl, calls);
  return results.map((r) => r ?? 0n);
}

/**
 * Options for fetching StableSwap parameters
 */
export interface StableSwapFetchOptions {
  /**
   * If true, automatically fetch token decimals and normalize balances to 18 decimals.
   * If an array of decimals is provided, use those instead of fetching.
   * Default: false (returns raw balances)
   */
  normalize?: boolean | number[];
  /**
   * If true, throw an error if any RPC call fails or returns invalid data.
   * Default: false (returns 0n for failed calls)
   */
  strict?: boolean;
}

/**
 * Fetch StableSwap pool parameters in a single batched call
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param poolAddress - Pool contract address
 * @param numCoins - Number of coins in pool (default 2)
 * @param options - Fetch options (normalize balances, strict mode, etc.)
 * @returns Pool parameters for off-chain calculations
 * @throws Error if strict mode is enabled and any RPC call fails
 */
export async function getStableSwapParams(
  rpcUrl: string,
  poolAddress: string,
  numCoins: number = 2,
  options: StableSwapFetchOptions = {}
): Promise<StableSwapPoolParams> {
  const calls: RpcCall[] = [];

  // Balance calls
  for (let i = 0; i < numCoins; i++) {
    calls.push({ to: poolAddress, data: buildBalancesCalldata(i) });
  }

  // A, fee, offpeg_fee_multiplier
  calls.push(
    { to: poolAddress, data: SELECTORS.A },
    { to: poolAddress, data: SELECTORS.FEE },
    { to: poolAddress, data: SELECTORS.OFFPEG_FEE_MULTIPLIER }
  );

  const results = await batchRpcCalls(rpcUrl, calls, { strict: options.strict });

  const rawBalances = results.slice(0, numCoins).map((r) => r ?? 0n);
  const A = results[numCoins] ?? 0n;
  const fee = results[numCoins + 1] ?? 0n;
  const offpegFeeMultiplier = results[numCoins + 2] ?? 0n;

  // Strict mode validation for required fields
  if (options.strict) {
    if (A === 0n) {
      throw new Error(`getStableSwapParams: A parameter is 0 for pool ${poolAddress}`);
    }
    if (fee === 0n) {
      throw new Error(`getStableSwapParams: fee is 0 for pool ${poolAddress}`);
    }
  }

  // Compute Ann = A * A_PRECISION * N_COINS
  const Ann = A * A_PRECISION * BigInt(numCoins);

  // Handle normalization
  let balances = rawBalances;
  let decimals: number[] | undefined;
  let precisions: bigint[] | undefined;

  if (options.normalize) {
    // Get decimals - either from options or fetch from chain
    if (Array.isArray(options.normalize)) {
      decimals = options.normalize;
    } else {
      // Fetch token addresses then decimals
      const coins = await getPoolCoins(rpcUrl, poolAddress, numCoins);
      decimals = await getTokenDecimals(rpcUrl, coins);
    }

    // Compute precisions and normalize balances
    precisions = computePrecisions(decimals);
    balances = normalizeBalances(rawBalances, precisions);
  }

  return {
    balances,
    A,
    Ann,
    fee,
    offpegFeeMultiplier,
    nCoins: numCoins,
    ...(precisions && { precisions }),
    ...(decimals && { decimals }),
    ...(options.normalize && { rawBalances }),
  };
}

/**
 * Options for fetching CryptoSwap parameters
 */
export interface CryptoSwapFetchOptions {
  /**
   * Token precisions (default [1n, 1n] for 18-decimal tokens)
   */
  precisions?: [bigint, bigint];
  /**
   * If true, throw an error if any RPC call fails or returns invalid data.
   * Default: false (returns 0n for failed calls)
   */
  strict?: boolean;
}

/**
 * Fetch CryptoSwap (Twocrypto) pool parameters in a single batched call
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param poolAddress - Pool contract address
 * @param options - Fetch options (precisions, strict mode)
 * @returns Pool parameters for off-chain calculations
 * @throws Error if strict mode is enabled and any RPC call fails
 */
export async function getCryptoSwapParams(
  rpcUrl: string,
  poolAddress: string,
  options: CryptoSwapFetchOptions = {}
): Promise<CryptoSwapParams> {
  const calls: RpcCall[] = [
    // Balances
    { to: poolAddress, data: buildBalancesCalldata(0) },
    { to: poolAddress, data: buildBalancesCalldata(1) },
    // Core params
    { to: poolAddress, data: SELECTORS.A },
    { to: poolAddress, data: SELECTORS.GAMMA },
    { to: poolAddress, data: SELECTORS.D },
    { to: poolAddress, data: SELECTORS.MID_FEE },
    { to: poolAddress, data: SELECTORS.OUT_FEE },
    { to: poolAddress, data: SELECTORS.FEE_GAMMA },
    { to: poolAddress, data: SELECTORS.PRICE_SCALE },
  ];

  const results = await batchRpcCalls(rpcUrl, calls, { strict: options.strict });

  const A = results[2] ?? 0n;
  const gamma = results[3] ?? 0n;
  const D = results[4] ?? 0n;

  // Strict mode validation for required fields
  if (options.strict) {
    if (A === 0n) {
      throw new Error(`getCryptoSwapParams: A parameter is 0 for pool ${poolAddress}`);
    }
    if (gamma === 0n) {
      throw new Error(`getCryptoSwapParams: gamma is 0 for pool ${poolAddress}`);
    }
    if (D === 0n) {
      throw new Error(`getCryptoSwapParams: D invariant is 0 for pool ${poolAddress}`);
    }
  }

  return {
    A,
    gamma,
    D,
    midFee: results[5] ?? 0n,
    outFee: results[6] ?? 0n,
    feeGamma: results[7] ?? 0n,
    priceScale: results[8] ?? 10n ** 18n,
    balances: [results[0] ?? 0n, results[1] ?? 0n],
    precisions: options.precisions ?? [1n, 1n],
  };
}

/**
 * Options for fetching Tricrypto parameters
 */
export interface TricryptoFetchOptions {
  /**
   * Token precisions (default [1n, 1n, 1n] for 18-decimal tokens)
   */
  precisions?: [bigint, bigint, bigint];
  /**
   * If true, throw an error if any RPC call fails or returns invalid data.
   * Default: false (returns 0n for failed calls)
   */
  strict?: boolean;
}

/**
 * Fetch Tricrypto (3-coin) pool parameters in a single batched call
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param poolAddress - Pool contract address
 * @param options - Fetch options (precisions, strict mode)
 * @returns Pool parameters for off-chain calculations
 * @throws Error if strict mode is enabled and any RPC call fails
 */
export async function getTricryptoParams(
  rpcUrl: string,
  poolAddress: string,
  options: TricryptoFetchOptions = {}
): Promise<TricryptoParams> {
  const calls: RpcCall[] = [
    // Balances (3 coins)
    { to: poolAddress, data: buildBalancesCalldata(0) },
    { to: poolAddress, data: buildBalancesCalldata(1) },
    { to: poolAddress, data: buildBalancesCalldata(2) },
    // Core params
    { to: poolAddress, data: SELECTORS.A },
    { to: poolAddress, data: SELECTORS.GAMMA },
    { to: poolAddress, data: SELECTORS.D },
    { to: poolAddress, data: SELECTORS.MID_FEE },
    { to: poolAddress, data: SELECTORS.OUT_FEE },
    { to: poolAddress, data: SELECTORS.FEE_GAMMA },
    // Price scales (2 for 3 coins: tokens 1 and 2 relative to token 0)
    { to: poolAddress, data: buildPriceScaleCalldata(0) },
    { to: poolAddress, data: buildPriceScaleCalldata(1) },
  ];

  const results = await batchRpcCalls(rpcUrl, calls, { strict: options.strict });

  const A = results[3] ?? 0n;
  const gamma = results[4] ?? 0n;
  const D = results[5] ?? 0n;

  // Strict mode validation for required fields
  if (options.strict) {
    if (A === 0n) {
      throw new Error(`getTricryptoParams: A parameter is 0 for pool ${poolAddress}`);
    }
    if (gamma === 0n) {
      throw new Error(`getTricryptoParams: gamma is 0 for pool ${poolAddress}`);
    }
    if (D === 0n) {
      throw new Error(`getTricryptoParams: D invariant is 0 for pool ${poolAddress}`);
    }
  }

  return {
    A,
    gamma,
    D,
    midFee: results[6] ?? 0n,
    outFee: results[7] ?? 0n,
    feeGamma: results[8] ?? 0n,
    priceScales: [results[9] ?? 10n ** 18n, results[10] ?? 10n ** 18n],
    balances: [results[0] ?? 0n, results[1] ?? 0n, results[2] ?? 0n],
    precisions: options.precisions ?? [1n, 1n, 1n],
  };
}

/**
 * Get on-chain get_dy result for comparison/verification
 */
export async function getOnChainDy(
  rpcUrl: string,
  poolAddress: string,
  i: number,
  j: number,
  dx: bigint | string,
  useFactorySelector: boolean = false
): Promise<bigint | null> {
  const data = useFactorySelector
    ? buildGetDyFactoryCalldata(i, j, dx)
    : buildGetDyCalldata(i, j, dx);

  const [result] = await batchRpcCalls(rpcUrl, [{ to: poolAddress, data }]);
  return result;
}

/**
 * Preview redeem from an ERC4626 vault
 */
export async function previewRedeem(
  rpcUrl: string,
  vaultAddress: string,
  shares: bigint | string
): Promise<bigint> {
  const [result] = await batchRpcCalls(rpcUrl, [
    { to: vaultAddress, data: buildPreviewRedeemCalldata(shares) },
  ]);

  if (result === null) {
    throw new Error(`Failed to preview redeem for vault ${vaultAddress}`);
  }

  return result;
}

// ============================================================================
// StableSwapNG Exact Precision Helpers
// ============================================================================

/**
 * Decode an array of uint256 from ABI-encoded data
 * Handles both static (uint256[N]) and dynamic (uint256[]) array encodings
 *
 * Static arrays: elements are concatenated directly
 * Dynamic arrays: offset (32 bytes) + length (32 bytes at offset) + elements
 */
function decodeUint256Array(hexData: string): bigint[] {
  // Remove 0x prefix if present
  const data = hexData.startsWith("0x") ? hexData.slice(2) : hexData;

  if (data.length < 64) {
    return []; // Need at least one 32-byte element
  }

  // Check if this looks like a dynamic array (first 32 bytes is a small offset value)
  const firstWord = BigInt("0x" + data.slice(0, 64));

  // Dynamic arrays typically have offset 0x20 (32) or 0x40 (64)
  // If first word is a small value (< 256) and points to valid data, treat as dynamic
  const isDynamic =
    firstWord <= 256n &&
    data.length >= Number(firstWord) * 2 + 64 && // offset * 2 (hex chars) + length slot
    firstWord > 0n;

  if (isDynamic) {
    // Dynamic array: offset + length + elements
    const offset = Number(firstWord) * 2; // Convert bytes to hex char offset
    if (offset + 64 > data.length) {
      // Invalid offset, fall back to static
      return decodeStaticArray(data);
    }
    const length = parseInt(data.slice(offset, offset + 64), 16);

    // Sanity check: length should be reasonable (< 100 for most pools)
    if (length > 100 || offset + 64 + length * 64 > data.length) {
      // Invalid length, fall back to static
      return decodeStaticArray(data);
    }

    const result: bigint[] = [];
    for (let i = 0; i < length; i++) {
      const start = offset + 64 + i * 64;
      const end = start + 64;
      if (end <= data.length) {
        result.push(BigInt("0x" + data.slice(start, end)));
      }
    }
    return result;
  }

  // Static array: just concatenated elements
  return decodeStaticArray(data);
}

/**
 * Decode a static array of uint256 (just concatenated 32-byte elements)
 */
function decodeStaticArray(data: string): bigint[] {
  const result: bigint[] = [];
  const numElements = Math.floor(data.length / 64);

  for (let i = 0; i < numElements; i++) {
    const start = i * 64;
    const end = start + 64;
    result.push(BigInt("0x" + data.slice(start, end)));
  }

  return result;
}

/**
 * Fetch stored_rates() from a StableSwapNG pool
 *
 * stored_rates() returns the current rate multipliers for all tokens,
 * including dynamic rates for oracle tokens and ERC4626 tokens.
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param poolAddress - Pool contract address
 * @returns Array of rate multipliers (10^36 precision base, adjusted for oracles)
 */
export async function getStoredRates(
  rpcUrl: string,
  poolAddress: string
): Promise<bigint[]> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: poolAddress, data: SELECTORS.STORED_RATES }, "latest"],
    }),
  });

  const json = (await response.json()) as { result?: string; error?: { message: string } };

  if (!json.result || json.result === "0x") {
    throw new Error(`Failed to fetch stored_rates from ${poolAddress}`);
  }

  return decodeUint256Array(json.result);
}

/**
 * Fetch N_COINS from a StableSwapNG pool
 */
export async function getNCoins(
  rpcUrl: string,
  poolAddress: string
): Promise<number> {
  const [result] = await batchRpcCalls(rpcUrl, [
    { to: poolAddress, data: SELECTORS.N_COINS },
  ]);

  if (result === null) {
    throw new Error(`Failed to fetch N_COINS from ${poolAddress}`);
  }

  return Number(result);
}

/**
 * Parameters for exact precision StableSwapNG calculations
 */
export interface ExactStableSwapParams {
  /** Raw balances in native token decimals */
  balances: bigint[];
  /** Rate multipliers from stored_rates() */
  rates: bigint[];
  /** Raw A parameter (NOT multiplied by A_PRECISION) */
  A: bigint;
  /** Fee (1e10 precision) */
  fee: bigint;
  /** Off-peg fee multiplier (1e10 precision) */
  offpegFeeMultiplier: bigint;
  /** Number of coins */
  nCoins: number;
}

/**
 * Fetch all parameters needed for exact precision calculations from a StableSwapNG pool
 *
 * This function fetches stored_rates() which includes dynamic rates for oracle
 * and ERC4626 tokens, providing exact precision matching with on-chain.
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param poolAddress - Pool contract address
 * @returns Parameters for exact precision calculations
 */
export async function getExactStableSwapParams(
  rpcUrl: string,
  poolAddress: string
): Promise<ExactStableSwapParams> {
  // First, get N_COINS and stored_rates (which includes dynamic rates)
  const [nCoins, rates] = await Promise.all([
    getNCoins(rpcUrl, poolAddress).catch(() => null),
    getStoredRates(rpcUrl, poolAddress).catch(() => null),
  ]);

  // Determine number of coins
  const numCoins = nCoins ?? rates?.length ?? 2;

  // Build batch calls for balances and other params
  const calls: RpcCall[] = [];

  // Balance calls
  for (let i = 0; i < numCoins; i++) {
    calls.push({ to: poolAddress, data: buildBalancesCalldata(i) });
  }

  // A, fee, offpeg_fee_multiplier
  calls.push(
    { to: poolAddress, data: SELECTORS.A },
    { to: poolAddress, data: SELECTORS.FEE },
    { to: poolAddress, data: SELECTORS.OFFPEG_FEE_MULTIPLIER }
  );

  const results = await batchRpcCalls(rpcUrl, calls);

  const balances = results.slice(0, numCoins).map((r) => r ?? 0n);
  const A = results[numCoins] ?? 0n;
  const fee = results[numCoins + 1] ?? 0n;
  const offpegFeeMultiplier = results[numCoins + 2] ?? 0n;

  // If we couldn't get stored_rates, fall back to computing from decimals
  let finalRates = rates;
  if (!finalRates) {
    const coins = await getPoolCoins(rpcUrl, poolAddress, numCoins);
    const decimals = await getTokenDecimals(rpcUrl, coins);
    finalRates = decimals.map((d) => 10n ** BigInt(36 - d));
  }

  return {
    balances,
    rates: finalRates,
    A,
    fee,
    offpegFeeMultiplier,
    nCoins: numCoins,
  };
}
