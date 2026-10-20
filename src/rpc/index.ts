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
import type { YieldBasisVirtualPoolRpcParams } from "../yieldbasis";
import type { LlamaLendAmmParams } from "../llamalend";
import { A_PRECISION } from "../stableswap";
import { computeRates } from "../stableswap-exact";
import { TRICRV_DECIMALS, TRICRV_POOL_ADDRESS } from "../tricrv";

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

  // ERC20 functions
  TOTAL_SUPPLY: "0x18160ddd", // totalSupply()

  // YieldBasis virtual pool functions
  YB_AMM: "0x44a70686", // AMM()
  YB_POOL: "0x7535d246", // POOL()
  YB_GET_STATE: "0x86b301ad", // get_state() - returns (collateral, debt, x0)

  // LlamaLend LLAMMA functions
  GET_DX_UINT256: "0x37ed3a7a", // get_dx(uint256,uint256,uint256)
  ACTIVE_BAND: "0x8f8654c5", // active_band()
  MIN_BAND: "0xca72a821", // min_band()
  MAX_BAND: "0xaaa615fc", // max_band()
  BANDS_X: "0xebcb0067", // bands_x(int256)
  BANDS_Y: "0x31f7e306", // bands_y(int256)
  PRICE_ORACLE: "0x86fc88d3", // price_oracle()
  P_ORACLE_UP: "0x2eb858e7", // p_oracle_up(int256)
} as const;

/** One eth_call in a batch: target contract and ABI-encoded calldata. */
export interface RpcCall {
  to: string;
  data: string;
}

interface RpcBatchResult {
  id: number;
  result?: string;
  error?: { message: string };
}

interface RpcSingleResult {
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
 * Encode a signed int256 parameter using two's-complement ABI encoding.
 */
export function encodeInt256(value: bigint | string | number): string {
  return BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, "0");
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
  /**
   * Block tag used for eth_call requests. Use a hex block number or tags such
   * as "latest", "safe", or "finalized". Default: "latest".
   */
  blockTag?: string | number | bigint;
}

function encodeBlockTag(blockTag?: string | number | bigint): string {
  if (blockTag === undefined) return "latest";
  if (typeof blockTag === "string") return blockTag;

  const value = BigInt(blockTag);
  if (value < 0n) {
    throw new Error("blockTag: value cannot be negative");
  }
  return "0x" + value.toString(16);
}

async function fetchJsonRpc(
  rpcUrl: string,
  body: unknown,
  timeout: number
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      // Error `cause` needs ES2022 lib; this package targets ES2020.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`RPC request timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(
      `RPC request failed: HTTP ${response.status} ${response.statusText}`
    );
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`RPC request failed: Invalid JSON response from ${rpcUrl}`);
  }
}

async function singleRpcRawCall(
  rpcUrl: string,
  call: RpcCall,
  idx: number,
  options: BatchRpcOptions,
  timeout: number
): Promise<string | null> {
  const json = await fetchJsonRpc(
    rpcUrl,
    {
      jsonrpc: "2.0",
      id: idx,
      method: "eth_call",
      params: [{ to: call.to, data: call.data }, encodeBlockTag(options.blockTag)],
    },
    timeout
  );

  const result = json as RpcSingleResult;
  if (result.error) {
    if (options.strict) {
      throw new Error(`RPC call ${idx} failed: ${result.error.message} (to: ${call.to})`);
    }
    return null;
  }
  if (result.result && result.result !== "0x") return result.result;
  if (options.strict) {
    throw new Error(`RPC call ${idx} returned empty result (to: ${call.to})`);
  }
  return null;
}

/**
 * Execute multiple eth_call requests and return raw ABI-encoded results.
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param calls - Array of { to, data } call objects
 * @param options - Optional settings (strict mode, etc.)
 * @returns Array of raw hex results (null if call failed and not in strict mode)
 * @throws Error if strict mode is enabled and any call fails
 */
export async function batchRpcRawCalls(
  rpcUrl: string,
  calls: RpcCall[],
  options: BatchRpcOptions = {}
): Promise<(string | null)[]> {
  if (calls.length === 0) return [];

  const batch = calls.map((call, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, encodeBlockTag(options.blockTag)],
  }));

  const timeout = options.timeout ?? 30000;
  const json = await fetchJsonRpc(rpcUrl, batch, timeout);

  // Some public RPCs do not support JSON-RPC batch requests. Fall back to
  // individual eth_call requests so optional RPC helpers still work there.
  if (!Array.isArray(json)) {
    return Promise.all(
      calls.map((call, idx) => singleRpcRawCall(rpcUrl, call, idx, options, timeout))
    );
  }

  const results = json as RpcBatchResult[];
  results.sort((a, b) => a.id - b.id);

  return results.map((r, idx) => {
    if (r.error) {
      if (options.strict) {
        throw new Error(`RPC call ${idx} failed: ${r.error.message} (to: ${calls[idx].to})`);
      }
      return null;
    }
    if (r.result && r.result !== "0x") return r.result;
    if (options.strict) {
      throw new Error(`RPC call ${idx} returned empty result (to: ${calls[idx].to})`);
    }
    return null;
  });
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
  const rawResults = await batchRpcRawCalls(rpcUrl, calls, options);

  const parsed = rawResults.map((result, idx) => {
    if (result && result !== "0x" && result !== "0x0") {
      return BigInt(result);
    }
    if (options.strict) {
      throw new Error(`RPC call ${idx} returned empty result (to: ${calls[idx].to})`);
    }
    return null;
  });

  return parsed;
}

/**
 * Fetch the current block number from an RPC endpoint.
 */
export async function getBlockNumber(
  rpcUrl: string,
  options: Pick<BatchRpcOptions, "timeout"> = {}
): Promise<bigint> {
  const timeout = options.timeout ?? 30000;
  const json = await fetchJsonRpc(
    rpcUrl,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    },
    timeout
  );

  const result = json as RpcSingleResult;
  if (result.error) {
    throw new Error(`RPC block number request failed: ${result.error.message}`);
  }
  if (!result.result || result.result === "0x") {
    throw new Error("RPC block number request returned empty result");
  }
  return BigInt(result.result);
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
 * Build calldata for get_dx(uint256,uint256,uint256)
 */
export function buildGetDxCalldata(i: number, j: number, dy: bigint | string): string {
  return SELECTORS.GET_DX_UINT256 + encodeUint256(i) + encodeUint256(j) + encodeUint256(dy);
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
 * Build calldata for bands_x(int256)
 */
export function buildBandsXCalldata(band: number): string {
  return SELECTORS.BANDS_X + encodeInt256(band);
}

/**
 * Build calldata for bands_y(int256)
 */
export function buildBandsYCalldata(band: number): string {
  return SELECTORS.BANDS_Y + encodeInt256(band);
}

/**
 * Build calldata for p_oracle_up(int256)
 */
export function buildPOracleUpCalldata(band: number): string {
  return SELECTORS.P_ORACLE_UP + encodeInt256(band);
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

function bigintToAddress(value: bigint): string {
  return "0x" + value.toString(16).padStart(40, "0").slice(-40);
}

function requireRawResult(
  result: string | null,
  label: string,
  address: string
): string {
  if (result === null) {
    throw new Error(`Failed to fetch ${label} from ${address}`);
  }
  return result;
}

function decodeUint256Word(hexData: string): bigint {
  const data = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  if (data.length === 0) return 0n;
  return BigInt("0x" + data);
}

function decodeInt256Word(hexData: string): number {
  const value = decodeUint256Word(hexData);
  return Number(BigInt.asIntN(256, value));
}

function decodeUint256Tuple(hexData: string, count: number): bigint[] {
  const data = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  const expectedLength = count * 64;
  if (data.length < expectedLength) {
    throw new Error(`Invalid uint256 tuple result: expected ${count} words`);
  }

  const values: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * 64;
    values.push(BigInt("0x" + data.slice(start, start + 64)));
  }
  return values;
}

/**
 * Fetch token addresses from a Curve pool
 */
export async function getPoolCoins(
  rpcUrl: string,
  poolAddress: string,
  numCoins: number = 2,
  options: BatchRpcOptions = {}
): Promise<string[]> {
  const calls = Array.from({ length: numCoins }, (_, i) => ({
    to: poolAddress,
    data: buildCoinsCalldata(i),
  }));

  const results = await batchRpcCalls(rpcUrl, calls, options);
  return results.map((r) => {
    if (r === null) return "0x0000000000000000000000000000000000000000";
    return bigintToAddress(r);
  });
}

/**
 * Fetch decimals for multiple token addresses
 */
export async function getTokenDecimals(
  rpcUrl: string,
  tokenAddresses: string[],
  options: BatchRpcOptions = {}
): Promise<number[]> {
  const calls = tokenAddresses.map((addr) => ({
    to: addr,
    data: SELECTORS.DECIMALS,
  }));

  const results = await batchRpcCalls(rpcUrl, calls, options);
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
  numCoins: number = 2,
  options: BatchRpcOptions = {}
): Promise<bigint[]> {
  const calls = Array.from({ length: numCoins }, (_, i) => ({
    to: poolAddress,
    data: buildBalancesCalldata(i),
  }));

  const results = await batchRpcCalls(rpcUrl, calls, options);
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
      const coins = await getPoolCoins(rpcUrl, poolAddress, numCoins, {
        strict: options.strict,
      });
      decimals = await getTokenDecimals(rpcUrl, coins, {
        strict: options.strict,
      });
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
 * Options for fetching YieldBasis virtual pool parameters
 */
export interface YieldBasisVirtualPoolFetchOptions {
  /**
   * If true, throw an error if any RPC call fails or returns invalid data.
   * Default: false for batch calls, though missing required addresses still throw.
   */
  strict?: boolean;
}

/**
 * Fetch YieldBasis virtual pool parameters in batched JSON-RPC calls.
 *
 * This reads VirtualPool.AMM(), VirtualPool.POOL(), AMM.get_state(),
 * AMM.fee(), backing pool balances, and backing pool totalSupply().
 */
export async function getYieldBasisVirtualPoolParams(
  rpcUrl: string,
  virtualPoolAddress: string,
  options: YieldBasisVirtualPoolFetchOptions = {}
): Promise<YieldBasisVirtualPoolRpcParams> {
  const [ammResult, poolResult] = await batchRpcCalls(
    rpcUrl,
    [
      { to: virtualPoolAddress, data: SELECTORS.YB_AMM },
      { to: virtualPoolAddress, data: SELECTORS.YB_POOL },
    ],
    { strict: options.strict }
  );

  if (ammResult === null) {
    throw new Error(`Failed to fetch AMM address from ${virtualPoolAddress}`);
  }
  if (poolResult === null) {
    throw new Error(`Failed to fetch backing pool address from ${virtualPoolAddress}`);
  }

  const ammAddress = bigintToAddress(ammResult);
  const poolAddress = bigintToAddress(poolResult);

  const rawResults = await batchRpcRawCalls(
    rpcUrl,
    [
      { to: ammAddress, data: SELECTORS.YB_GET_STATE },
      { to: ammAddress, data: SELECTORS.FEE },
      { to: poolAddress, data: buildBalancesCalldata(0) },
      { to: poolAddress, data: buildBalancesCalldata(1) },
      { to: poolAddress, data: SELECTORS.TOTAL_SUPPLY },
    ],
    { strict: options.strict }
  );

  const [collateral, debt, x0] = decodeUint256Tuple(
    requireRawResult(rawResults[0], "AMM.get_state()", ammAddress),
    3
  );
  const ammFee = decodeUint256Word(
    requireRawResult(rawResults[1], "AMM.fee()", ammAddress)
  );
  const stableBalance = decodeUint256Word(
    requireRawResult(rawResults[2], "pool.balances(0)", poolAddress)
  );
  const assetBalance = decodeUint256Word(
    requireRawResult(rawResults[3], "pool.balances(1)", poolAddress)
  );
  const poolTotalSupply = decodeUint256Word(
    requireRawResult(rawResults[4], "pool.totalSupply()", poolAddress)
  );

  return {
    virtualPoolAddress,
    ammAddress,
    poolAddress,
    ammState: { collateral, debt, x0 },
    poolBalances: [stableBalance, assetBalance],
    poolTotalSupply,
    ammFee,
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
  useFactorySelector: boolean = false,
  options: BatchRpcOptions = {}
): Promise<bigint | null> {
  const data = useFactorySelector
    ? buildGetDyFactoryCalldata(i, j, dx)
    : buildGetDyCalldata(i, j, dx);

  const [result] = await batchRpcCalls(rpcUrl, [{ to: poolAddress, data }], options);
  return result;
}

/**
 * Get on-chain get_dx result for comparison/verification.
 */
export async function getOnChainDx(
  rpcUrl: string,
  poolAddress: string,
  i: number,
  j: number,
  dy: bigint | string,
  options: BatchRpcOptions = {}
): Promise<bigint | null> {
  const data = buildGetDxCalldata(i, j, dy);
  const [result] = await batchRpcCalls(rpcUrl, [{ to: poolAddress, data }], options);
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

/**
 * Options for fetching classic 3pool / triCRV parameters.
 */
export interface TriCrvFetchOptions {
  /**
   * If true, throw an error if any RPC call fails or returns invalid data.
   * Default: false.
   */
  strict?: boolean;
}

/**
 * Fetch exact precision parameters for Curve's classic 3pool / triCRV.
 *
 * triCRV is a classic StableSwap pool (DAI/USDC/USDT), not Tricrypto-NG.
 */
export async function getTriCrvParams(
  rpcUrl: string,
  poolAddress: string = TRICRV_POOL_ADDRESS,
  options: TriCrvFetchOptions = {}
): Promise<ExactStableSwapParams> {
  const params = await getStableSwapParams(rpcUrl, poolAddress, 3, {
    strict: options.strict,
  });

  return {
    balances: params.rawBalances ?? params.balances,
    rates: computeRates([...TRICRV_DECIMALS]),
    A: params.A,
    fee: params.fee,
    offpegFeeMultiplier: params.offpegFeeMultiplier,
    nCoins: 3,
  };
}

export interface LlamaLendAmmRpcParams extends LlamaLendAmmParams {
  /** LlamaLend AMM address. */
  ammAddress: string;
  /** Token addresses: [borrowed token, collateral token]. */
  coins: [string, string];
  /** Token decimals: [borrowed token, collateral token]. */
  decimals: [number, number];
  /** Bands included in the returned bandsX/bandsY maps. */
  fetchedBands: number[];
}

/**
 * Options for fetching LlamaLend AMM parameters.
 */
export interface LlamaLendAmmFetchOptions {
  /**
   * Explicit band list to fetch. If omitted, the helper fetches min_band..max_band.
   */
  bands?: number[];
  /**
   * Explicit inclusive band range to fetch. Ignored when `bands` is provided.
   */
  bandRange?: { from: number; to: number };
  /**
   * Safety cap for fetched bands. Default: 256.
   */
  maxBandFetch?: number;
  /**
   * Block tag used for all AMM/token reads. Pin this for exact parity checks.
   * Default: "latest".
   */
  blockTag?: BatchRpcOptions["blockTag"];
  /**
   * If true, throw an error if any RPC call fails or returns invalid data.
   * Default: false.
   */
  strict?: boolean;
}

function buildBandList(
  minBand: number,
  maxBand: number,
  options: LlamaLendAmmFetchOptions
): number[] {
  let bands: number[];
  if (options.bands) {
    bands = [...options.bands];
  } else {
    const from = options.bandRange?.from ?? minBand;
    const to = options.bandRange?.to ?? maxBand;
    if (from > to) {
      throw new Error(`getLlamaLendAmmParams: invalid band range ${from}..${to}`);
    }
    bands = Array.from({ length: to - from + 1 }, (_, idx) => from + idx);
  }

  const maxBandFetch = options.maxBandFetch ?? 256;
  if (bands.length > maxBandFetch) {
    throw new Error(
      `getLlamaLendAmmParams: refusing to fetch ${bands.length} bands; ` +
        `increase maxBandFetch or pass an explicit bands list`
    );
  }

  return bands;
}

/**
 * Fetch Curve LlamaLend LLAMMA parameters for off-chain quotes.
 *
 * The returned band balances are already in the AMM's internal precision-scaled
 * units, and public `llamalend.getDy/getDx` inputs remain native token amounts.
 */
export async function getLlamaLendAmmParams(
  rpcUrl: string,
  ammAddress: string,
  options: LlamaLendAmmFetchOptions = {}
): Promise<LlamaLendAmmRpcParams> {
  const coreResults = await batchRpcRawCalls(
    rpcUrl,
    [
      { to: ammAddress, data: SELECTORS.A },
      { to: ammAddress, data: SELECTORS.FEE },
      { to: ammAddress, data: SELECTORS.ACTIVE_BAND },
      { to: ammAddress, data: SELECTORS.MIN_BAND },
      { to: ammAddress, data: SELECTORS.MAX_BAND },
      { to: ammAddress, data: SELECTORS.PRICE_ORACLE },
      { to: ammAddress, data: buildCoinsCalldata(0) },
      { to: ammAddress, data: buildCoinsCalldata(1) },
    ],
    { strict: options.strict, blockTag: options.blockTag }
  );

  const A = decodeUint256Word(requireRawResult(coreResults[0], "A()", ammAddress));
  const fee = decodeUint256Word(requireRawResult(coreResults[1], "fee()", ammAddress));
  const activeBand = decodeInt256Word(
    requireRawResult(coreResults[2], "active_band()", ammAddress)
  );
  const minBand = decodeInt256Word(
    requireRawResult(coreResults[3], "min_band()", ammAddress)
  );
  const maxBand = decodeInt256Word(
    requireRawResult(coreResults[4], "max_band()", ammAddress)
  );
  const pOracle = decodeUint256Word(
    requireRawResult(coreResults[5], "price_oracle()", ammAddress)
  );
  const coins: [string, string] = [
    bigintToAddress(decodeUint256Word(requireRawResult(coreResults[6], "coins(0)", ammAddress))),
    bigintToAddress(decodeUint256Word(requireRawResult(coreResults[7], "coins(1)", ammAddress))),
  ];

  const fetchedBands = buildBandList(minBand, maxBand, options);
  const decimals = (await getTokenDecimals(rpcUrl, coins, {
    strict: options.strict,
    blockTag: options.blockTag,
  })) as [number, number];
  const precisions = computePrecisions(decimals) as [bigint, bigint];

  const bandCalls: RpcCall[] = [
    { to: ammAddress, data: buildPOracleUpCalldata(activeBand) },
  ];
  for (const band of fetchedBands) {
    bandCalls.push(
      { to: ammAddress, data: buildBandsXCalldata(band) },
      { to: ammAddress, data: buildBandsYCalldata(band) }
    );
  }

  const bandResults = await batchRpcRawCalls(rpcUrl, bandCalls, {
    strict: options.strict,
    blockTag: options.blockTag,
  });

  const pOracleUp = decodeUint256Word(
    requireRawResult(bandResults[0], `p_oracle_up(${activeBand})`, ammAddress)
  );
  const bandsX: Record<number, bigint> = {};
  const bandsY: Record<number, bigint> = {};
  for (let idx = 0; idx < fetchedBands.length; idx++) {
    const band = fetchedBands[idx];
    bandsX[band] = decodeUint256Word(
      requireRawResult(bandResults[1 + idx * 2], `bands_x(${band})`, ammAddress)
    );
    bandsY[band] = decodeUint256Word(
      requireRawResult(bandResults[2 + idx * 2], `bands_y(${band})`, ammAddress)
    );
  }

  return {
    ammAddress,
    coins,
    decimals,
    fetchedBands,
    A,
    fee,
    activeBand,
    minBand,
    maxBand,
    pOracle,
    pOracleUp,
    bandsX,
    bandsY,
    borrowedPrecision: precisions[0],
    collateralPrecision: precisions[1],
  };
}
