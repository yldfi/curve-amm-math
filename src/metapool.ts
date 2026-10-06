/**
 * Curve StableSwap metapools: a 2-coin pool of [coin, base LP token] on top
 * of a base StableSwap pool. Exact ports of the metapool underlying paths
 * (`get_dy_underlying`) and of the factory deposit zaps
 * (`calc_token_amount`, `calc_withdraw_one_coin`, `add_liquidity`).
 *
 * Pool-level metapool math is ordinary StableSwap math: build the metapool
 * as `StableLiquidityParams` with `rates = [10^(36 - decimals0), baseVirtualPrice]`
 * (NG metapools: `stored_rates()`) and use the `stableswapExact` functions:
 *
 * | Metapool | `variant` |
 * |----------|-----------|
 * | `main` registry metapools (GUSD/3Crv, MUSD/3Crv, …), `factory` v1 metapools (`metausd`, `metausdbalances`, `metausd-fraxusdc`, `v1metausd`) | `"legacy"` |
 * | `factory-stable-ng` metapools (`metausdstableng*`) | `"ng"` |
 *
 * `baseVirtualPrice` is the base pool's live `get_virtual_price()` for
 * factory and NG metapools. Old `main` registry metapools cache it for 10
 * minutes: use `base_virtual_price()` while
 * `base_cache_updated() + 600 >= block.timestamp`, else the live value.
 *
 * Crypto metapools (`factory-crypto` `metacrypto`: a CurveCryptoSwap2 pool of
 * [coin, base LP]) are covered by the `crypto*` functions below, which port
 * the factory crypto-meta zaps (e.g. 0x5De4EF48… for FRAXBP, 0x97aDC08F… for
 * 3pool). Their pool-level math is the `cryptoswap` module.
 */

import * as cryptoswap from "./cryptoswap";
import {
  calcAddLiquidityExact,
  calcTokenAmountExact,
  calcWithdrawOneCoinExact,
  dynamicFee,
  FEE_DENOMINATOR,
  getDVariant,
  getDyVariant,
  getVirtualPriceExact,
  getXp,
  getYVariant,
  PRECISION,
  type StableLiquidityParams,
} from "./stableswap-exact";

/** A metapool and its base pool, both at the same block. */
export interface MetapoolParams {
  /** The metapool: 2 coins, `rates[1]` = base virtual price */
  meta: StableLiquidityParams;
  /** The base pool */
  base: StableLiquidityParams;
}

function ampOf(p: StableLiquidityParams): [bigint, bigint] {
  const ampPrecision = p.ampPrecision ?? 100n;
  return [p.ampPrecise ?? p.A * ampPrecision, ampPrecision];
}

/**
 * Exact `get_dy_underlying(i, j, dx)`. Index 0 is the metapool's own coin,
 * 1..N are the base pool's coins.
 *
 * - Base → meta coin: the base `calc_token_amount` (deposit) in base LP,
 *   less half the base fee for legacy metapools (the contracts' approximation),
 *   swapped in the metapool.
 * - Meta coin → base: swapped to base LP, then the base
 *   `calc_withdraw_one_coin`.
 * - Base → base: the base pool's `get_dy`.
 *
 * NG metapools (`meta.variant === "ng"`) use the NG views: dynamic fee, no
 * half-fee deduction. The base `calc_token_amount` is the base family's own
 * view, which for an NG metapool on a legacy base means static fees: pass that
 * base with `variant: "plain"`.
 */
export function getDyUnderlying(params: MetapoolParams, i: number, j: number, dx: bigint): bigint {
  const { meta, base } = params;
  const nBase = base.balances.length;
  if (i === j || i < 0 || j < 0 || i > nBase || j > nBase) {
    throw new Error(`metapool.getDyUnderlying: invalid indices (i=${i}, j=${j})`);
  }
  if (i > 0 && j > 0) {
    return getDyVariant(base, i - 1, j - 1, dx);
  }
  const isNg = meta.variant === "ng";
  const [amp, ampPrecision] = ampOf(meta);
  const rates = meta.rates;
  const xp = getXp(meta.balances, rates);

  let x: bigint;
  const metaI = i === 0 ? 0 : 1;
  const metaJ = j === 0 ? 0 : 1;
  if (i === 0) {
    x = xp[0] + (dx * rates[0]) / PRECISION;
  } else {
    const baseInputs = base.balances.map((_, k) => (k === i - 1 ? dx : 0n));
    x = (calcTokenAmountExact(base, baseInputs, true) * rates[1]) / PRECISION;
    if (!isNg) {
      x -= (x * base.fee) / (2n * FEE_DENOMINATOR);
    }
    x += xp[1];
  }

  const D = getDVariant(xp, amp, meta.variant, ampPrecision);
  const y = getYVariant(metaI, metaJ, x, xp, amp, D, ampPrecision);
  let dy = xp[metaJ] - y - 1n;
  if (dy < 0n) return 0n;
  if (isNg) {
    const f = dynamicFee((xp[metaI] + x) / 2n, (xp[metaJ] + y) / 2n, meta.fee, meta.offpegFeeMultiplier);
    dy -= (f * dy) / FEE_DENOMINATOR;
  } else {
    dy -= (meta.fee * dy) / FEE_DENOMINATOR;
  }

  if (j === 0) {
    return isNg ? (dy * PRECISION) / rates[0] : dy / (rates[0] / PRECISION);
  }
  return calcWithdrawOneCoinExact(base, (dy * PRECISION) / rates[1], j - 1)[0];
}

/**
 * Factory deposit zap `calc_token_amount(pool, amounts, is_deposit)`:
 * `amounts[0]` is the metapool coin, `amounts[1..]` the base coins. The base
 * coins go through the base `calc_token_amount`, then the metapool's.
 * (Legacy views omit imbalance fees, so this is the zap's quote, not the
 * mint: see {@link calcAddLiquidityUnderlying}.)
 */
export function calcTokenAmountUnderlying(
  params: MetapoolParams,
  amounts: bigint[],
  isDeposit: boolean
): bigint {
  const { meta, base } = params;
  if (amounts.length !== base.balances.length + 1) {
    throw new Error("metapool.calcTokenAmountUnderlying: amounts must cover the meta coin and every base coin");
  }
  const baseAmounts = amounts.slice(1);
  const baseTokens = baseAmounts.some((a) => a > 0n)
    ? calcTokenAmountExact(base, baseAmounts, isDeposit)
    : 0n;
  return calcTokenAmountExact(meta, [amounts[0], baseTokens], isDeposit);
}

/**
 * Factory deposit zap `calc_withdraw_one_coin(pool, token_amount, i)`:
 * index 0 withdraws the metapool coin; 1..N withdraw base LP from the
 * metapool, then that base coin from the base pool.
 */
export function calcWithdrawOneCoinUnderlying(params: MetapoolParams, tokenAmount: bigint, i: number): bigint {
  const { meta, base } = params;
  if (i < 0 || i > base.balances.length) {
    throw new Error(`metapool.calcWithdrawOneCoinUnderlying: index out of bounds (i=${i})`);
  }
  if (i === 0) return calcWithdrawOneCoinExact(meta, tokenAmount, 0)[0];
  const baseTokens = calcWithdrawOneCoinExact(meta, tokenAmount, 1)[0];
  return calcWithdrawOneCoinExact(base, baseTokens, i - 1)[0];
}

/**
 * Metapool LP minted by the factory zap's `add_liquidity(pool, amounts)`,
 * fees included: the base coins are added to the base pool (exact base
 * mint), then `[amounts[0], baseLpMinted]` to the metapool, whose base
 * virtual price is recomputed from the base pool's post-deposit state
 * (factory and NG metapools read it live).
 *
 * @param baseVirtualPriceLive - set false for cached-rate (old `main`)
 *   metapools whose cache is still fresh: the metapool rate then stays
 *   `meta.rates[1]`
 */
export function calcAddLiquidityUnderlying(
  params: MetapoolParams,
  amounts: bigint[],
  baseVirtualPriceLive: boolean = true
): bigint {
  const { meta, base } = params;
  if (amounts.length !== base.balances.length + 1) {
    throw new Error("metapool.calcAddLiquidityUnderlying: amounts must cover the meta coin and every base coin");
  }
  const baseAmounts = amounts.slice(1);
  let baseMinted = 0n;
  let rates = meta.rates;
  if (baseAmounts.some((a) => a > 0n)) {
    const r = calcAddLiquidityExact(base, baseAmounts);
    baseMinted = r.lpAmount;
    if (baseVirtualPriceLive) {
      const vp = getVirtualPriceExact({ ...base, balances: r.balances, totalSupply: r.totalSupply });
      rates = [meta.rates[0], vp];
    }
  }
  return calcAddLiquidityExact({ ...meta, rates }, [amounts[0], baseMinted]).lpAmount;
}

// ============================================
// Crypto metapools (CurveCryptoSwap2 [coin, base LP] + crypto-meta zap)
// ============================================

/** A crypto metapool (CurveCryptoSwap2, coin 1 = base LP) and its base pool. */
export interface CryptoMetapoolParams {
  /** The crypto pool; `totalSupply` of its LP is passed separately */
  meta: cryptoswap.TwocryptoParams;
  /** The crypto pool's LP totalSupply */
  metaTotalSupply: bigint;
  /** The base StableSwap pool */
  base: StableLiquidityParams;
}

function checkCryptoIndex(params: CryptoMetapoolParams, i: number, name: string): void {
  if (i < 0 || i > params.base.balances.length) {
    throw new Error(`metapool.${name}: index out of bounds (i=${i})`);
  }
}

/**
 * Crypto-meta zap `get_dy(pool, i, j, dx)`: 0 = the crypto pool's coin,
 * 1..N = base coins. Meta → base swaps into base LP and withdraws one coin;
 * base → meta deposits via the base `calc_token_amount` view and swaps; base →
 * base is the base pool's `get_dy`.
 */
export function cryptoGetDyUnderlying(params: CryptoMetapoolParams, i: number, j: number, dx: bigint): bigint {
  checkCryptoIndex(params, i, "cryptoGetDyUnderlying");
  checkCryptoIndex(params, j, "cryptoGetDyUnderlying");
  if (i === j) throw new Error("metapool.cryptoGetDyUnderlying: i and j must differ");
  const { meta, base } = params;
  if (i === 0) {
    const lp = cryptoswap.getDy(meta, 0, 1, dx);
    return calcWithdrawOneCoinExact(base, lp, j - 1)[0];
  }
  if (j === 0) {
    const baseInputs = base.balances.map((_, k) => (k === i - 1 ? dx : 0n));
    const lp = calcTokenAmountExact(base, baseInputs, true);
    return cryptoswap.getDy(meta, 1, 0, lp);
  }
  return getDyVariant(base, i - 1, j - 1, dx);
}

/**
 * Crypto-meta zap `calc_token_amount(pool, amounts)`: base coins through the
 * base `calc_token_amount` view, then the crypto pool's `calc_token_amount`.
 */
export function cryptoCalcTokenAmountUnderlying(params: CryptoMetapoolParams, amounts: bigint[]): bigint {
  const { meta, base } = params;
  if (amounts.length !== base.balances.length + 1) {
    throw new Error("metapool.cryptoCalcTokenAmountUnderlying: amounts must cover the meta coin and every base coin");
  }
  const baseAmounts = amounts.slice(1);
  const baseTokens = baseAmounts.some((a) => a > 0n) ? calcTokenAmountExact(base, baseAmounts, true) : 0n;
  return cryptoswap.calcTokenAmount(meta, [amounts[0], baseTokens], params.metaTotalSupply);
}

/**
 * Crypto-meta zap `calc_withdraw_one_coin(pool, token_amount, i)`.
 */
export function cryptoCalcWithdrawOneCoinUnderlying(
  params: CryptoMetapoolParams,
  tokenAmount: bigint,
  i: number
): bigint {
  checkCryptoIndex(params, i, "cryptoCalcWithdrawOneCoinUnderlying");
  const { meta, base, metaTotalSupply } = params;
  if (i === 0) return cryptoswap.calcWithdrawOneCoin(meta, tokenAmount, 0, metaTotalSupply);
  const baseTokens = cryptoswap.calcWithdrawOneCoin(meta, tokenAmount, 1, metaTotalSupply);
  return calcWithdrawOneCoinExact(base, baseTokens, i - 1)[0];
}

/**
 * LP minted by the crypto-meta zap's `add_liquidity(pool, amounts)`: the
 * exact base mint, then the crypto pool's `add_liquidity` of
 * `[amounts[0], baseLpMinted + zapBaseLpDust]` (the zap deposits its whole
 * base-LP balance).
 */
export function cryptoCalcAddLiquidityUnderlying(
  params: CryptoMetapoolParams,
  amounts: bigint[],
  zapBaseLpDust: bigint = 0n
): bigint {
  const { meta, base } = params;
  if (amounts.length !== base.balances.length + 1) {
    throw new Error("metapool.cryptoCalcAddLiquidityUnderlying: amounts must cover the meta coin and every base coin");
  }
  const baseAmounts = amounts.slice(1);
  const baseMinted = baseAmounts.some((a) => a > 0n) ? calcAddLiquidityExact(base, baseAmounts).lpAmount : 0n;
  return cryptoswap.calcAddLiquidity(meta, [amounts[0], baseMinted + zapBaseLpDust], params.metaTotalSupply)
    .lpMinted;
}

/**
 * Coin paid by the crypto-meta zap's `remove_liquidity_one_coin(pool,
 * burn_amount, i)`: the crypto pool's `remove_liquidity_one_coin` (stored D),
 * then for base coins the base `remove_liquidity_one_coin`.
 */
export function cryptoRemoveLiquidityOneCoinUnderlying(
  params: CryptoMetapoolParams,
  burnAmount: bigint,
  i: number
): bigint {
  checkCryptoIndex(params, i, "cryptoRemoveLiquidityOneCoinUnderlying");
  const { meta, base, metaTotalSupply } = params;
  if (i === 0) return cryptoswap.calcRemoveLiquidityOneCoin(meta, burnAmount, 0, metaTotalSupply).dy;
  const baseTokens = cryptoswap.calcRemoveLiquidityOneCoin(meta, burnAmount, 1, metaTotalSupply).dy;
  return calcWithdrawOneCoinExact(base, baseTokens, i - 1)[0];
}
