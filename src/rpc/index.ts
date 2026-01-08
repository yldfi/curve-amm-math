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
import type { CryptoSwapParams } from "../cryptoswap";
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

  // CryptoSwap pool functions
  GAMMA: "0xb1373929", // gamma()
  D: "0x0f529ba2", // D()
  MID_FEE: "0x92526c0c", // mid_fee()
  OUT_FEE: "0xee8de675", // out_fee()
  FEE_GAMMA: "0x72d4f0e2", // fee_gamma()
  PRICE_SCALE: "0xb9e8c9fd", // price_scale() for 2-coin
  PRICE_SCALE_I: "0xa3f7cdd5", // price_scale(uint256) for N>2 coins

  // ERC4626 vault functions
  PREVIEW_REDEEM: "0x4cdad506", // previewRedeem(uint256)
  CONVERT_TO_ASSETS: "0x07a2d13a", // convertToAssets(uint256)
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
 * Execute multiple eth_call requests in a single HTTP request
 * Reduces latency by batching RPC calls
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param calls - Array of { to, data } call objects
 * @returns Array of bigint results (null if call failed)
 */
export async function batchRpcCalls(
  rpcUrl: string,
  calls: RpcCall[]
): Promise<(bigint | null)[]> {
  if (calls.length === 0) return [];

  const batch = calls.map((call, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, "latest"],
  }));

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });

  const json = await response.json();

  // Handle case where response is not an array
  if (!Array.isArray(json)) {
    return calls.map(() => null);
  }

  const results = json as RpcBatchResult[];
  results.sort((a, b) => a.id - b.id);

  return results.map((r) => {
    if (r.result && r.result !== "0x" && r.result !== "0x0") {
      return BigInt(r.result);
    }
    return null;
  });
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
 * Fetch StableSwap pool parameters in a single batched call
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param poolAddress - Pool contract address
 * @param numCoins - Number of coins in pool (default 2)
 * @returns Pool parameters for off-chain calculations
 */
export async function getStableSwapParams(
  rpcUrl: string,
  poolAddress: string,
  numCoins: number = 2
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

  const results = await batchRpcCalls(rpcUrl, calls);

  const balances = results.slice(0, numCoins).map((r) => r ?? 0n);
  const A = results[numCoins] ?? 0n;
  const fee = results[numCoins + 1] ?? 0n;
  const offpegFeeMultiplier = results[numCoins + 2] ?? 0n;

  // Compute Ann = A * A_PRECISION * N_COINS
  const Ann = A * A_PRECISION * BigInt(numCoins);

  return {
    balances,
    A,
    Ann,
    fee,
    offpegFeeMultiplier,
    nCoins: numCoins,
  };
}

/**
 * Fetch CryptoSwap (Twocrypto) pool parameters in a single batched call
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @param poolAddress - Pool contract address
 * @param precisions - Token precisions (default [1n, 1n] for 18-decimal tokens)
 * @returns Pool parameters for off-chain calculations
 */
export async function getCryptoSwapParams(
  rpcUrl: string,
  poolAddress: string,
  precisions?: [bigint, bigint]
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

  const results = await batchRpcCalls(rpcUrl, calls);

  return {
    A: results[2] ?? 0n,
    gamma: results[3] ?? 0n,
    D: results[4] ?? 0n,
    midFee: results[5] ?? 0n,
    outFee: results[6] ?? 0n,
    feeGamma: results[7] ?? 0n,
    priceScale: results[8] ?? 10n ** 18n,
    balances: [results[0] ?? 0n, results[1] ?? 0n],
    precisions: precisions ?? [1n, 1n],
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
