/**
 * The two pre-NG three-coin CryptoSwap pools on Ethereum mainnet
 * (USDT / WBTC / WETH): tricrypto2 (crv3crypto) and the retired tricrypto v1
 * (crvTricrypto).
 *
 * The maths is the classic 3-coin `cryptoswap` port; this module pins the two
 * places where the pools differ, so callers can quote either from one state:
 *
 * - tricrypto v1 runs its maths with A_MULTIPLIER = 100, so `params.A` must
 *   be `A_precise() * 100` (the reader in `rpc` does this).
 * - tricrypto v1's `calc_withdraw_one_coin` always starts from the stored D,
 *   even mid-ramp; tricrypto2's view recomputes it.
 *
 * Use `rpc.getTricryptoLegacyState` to read a state at a pinned block.
 */

import * as cryptoswap from "./cryptoswap";
import type { TricryptoParams } from "./cryptoswap";

export const TRICRYPTO2_POOL_ADDRESS = "0xd51a44d3fae010294c616388b506acda1bfaae46";
export const TRICRYPTO_V1_POOL_ADDRESS = "0x80466c64868e1ab14a1ddf27a676c3fcbe638fe5";

export type TricryptoLegacyVariant = "tricrypto2" | "tricrypto-v1";

export interface TricryptoLegacyState {
  variant: TricryptoLegacyVariant;
  /** Pool state; `A` uses A_MULTIPLIER = 10000 for both variants */
  params: TricryptoParams;
  /** LP token `totalSupply()` */
  totalSupply: bigint;
}

/** `get_dy(i, j, dx)` */
export function getDy(state: TricryptoLegacyState, i: number, j: number, dx: bigint): bigint {
  return cryptoswap.getDy3(state.params, i, j, dx);
}

/** Smallest input whose `get_dy` is at least `dy` (neither pool has `get_dx`) */
export function getDx(state: TricryptoLegacyState, i: number, j: number, dy: bigint): bigint {
  return cryptoswap.getDx3(state.params, i, j, dy);
}

/** `calc_withdraw_one_coin(token_amount, i)` */
export function calcWithdrawOneCoin(
  state: TricryptoLegacyState,
  tokenAmount: bigint,
  i: number
): bigint {
  if (state.variant === "tricrypto2") {
    return cryptoswap.calcWithdrawOneCoin3(state.params, tokenAmount, i, state.totalSupply);
  }
  // v1 reads the stored D whatever future_A_gamma_time says
  const params = { ...state.params, futureAGammaTime: 0n };
  return cryptoswap.calcRemoveLiquidityOneCoin3(params, tokenAmount, i, state.totalSupply).dy;
}

/** `get_virtual_price()` */
export function getVirtualPrice(state: TricryptoLegacyState): bigint {
  return cryptoswap.getVirtualPrice3(state.params, state.totalSupply);
}
