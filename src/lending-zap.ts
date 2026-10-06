/**
 * Deposit zaps of Curve's first lending pools: compound (cDAI/cUSDC,
 * zap 0xeB21209a…), usdt (cDAI/cUSDC/USDT, zap 0xac795D2c…), y
 * (yDAI/yUSDC/yUSDT/yTUSD-era, zap 0xbBC81d23…) and PAX (zap 0xA50cCc70…).
 * These pools have no `calc_withdraw_one_coin` of their own; the zaps carry
 * their own (deliberately conservative) copy of the math, ported here
 * operation for operation:
 *
 * - `get_D` divides by `x * N + 1` and uses `A` without A_PRECISION;
 * - the fee is overcharged by `FEE_IMPRECISION` (25%);
 * - the expected balance of coin i is reduced by `S * (D0 - D1) / D0`;
 * - rates are the tokens' raw `exchangeRateStored()` (cTokens) or
 *   `getPricePerFullShare()` (yTokens), no accrual, and 1e18 for plain coins.
 */


const LENDING_PRECISION = 10n ** 18n;
const FEE_DENOMINATOR = 10n ** 10n;
const FEE_IMPRECISION = 25n * 10n ** 8n;

/** State a lending zap reads. */
export interface LendingZapParams {
  /** Pool `balances(i)` (wrapped-token units) */
  balances: bigint[];
  /** Pool `A()` */
  A: bigint;
  /** Pool `fee()` */
  fee: bigint;
  /** LP `totalSupply()` */
  totalSupply: bigint;
  /** 10^(18 − underlying decimals) per coin */
  precisionMul: bigint[];
  /** Which coins are lending tokens (cToken / yToken) */
  useLending: boolean[];
  /**
   * Per-coin rate (1e18): `exchangeRateStored()` / `getPricePerFullShare()`
   * for lending coins (any value for plain coins; it is ignored)
   */
  rates: bigint[];
}

/** Zap `get_D(A, xp)`. */
function getD(A: bigint, xp: bigint[]): bigint {
  const N = BigInt(xp.length);
  let S = 0n;
  for (const x of xp) S += x;
  if (S === 0n) return 0n;
  let D = S;
  const Ann = A * N;
  for (let k = 0; k < 255; k++) {
    let D_P = D;
    for (const x of xp) D_P = (D_P * D) / (x * N + 1n);
    const Dprev = D;
    D = ((Ann * S + D_P * N) * D) / ((Ann - 1n) * D + (N + 1n) * D_P);
    if (D > Dprev ? D - Dprev <= 1n : Dprev - D <= 1n) break;
  }
  return D;
}

/** Zap `get_y(A, i, xp, D)`. */
function getY(A: bigint, i: number, xp: bigint[], D: bigint): bigint {
  const N = BigInt(xp.length);
  let c = D;
  let S_ = 0n;
  const Ann = A * N;
  for (let k = 0; k < xp.length; k++) {
    if (k === i) continue;
    S_ += xp[k];
    c = (c * D) / (xp[k] * N);
  }
  c = (c * D) / (Ann * N);
  const b = S_ + D / Ann;
  let y = D;
  for (let k = 0; k < 255; k++) {
    const yPrev = y;
    y = (y * y + c) / (2n * y + b - D);
    if (y > yPrev ? y - yPrev <= 1n : yPrev - y <= 1n) break;
  }
  return y;
}

/**
 * Zap `calc_withdraw_one_coin(token_amount, i)` (= its
 * `_calc_withdraw_one_coin` with the passed rates), in underlying units of
 * coin i. The view uses `exchangeRateStored()`; `remove_liquidity_one_coin`
 * runs the same math with `exchangeRateCurrent()` (pass accrued rates).
 */
export function calcWithdrawOneCoin(params: LendingZapParams, tokenAmount: bigint, i: number): bigint {
  const n = params.balances.length;
  if (i < 0 || i >= n) throw new Error(`lendingZap.calcWithdrawOneCoin: index out of bounds (i=${i})`);
  if (params.totalSupply === 0n) throw new Error("lendingZap.calcWithdrawOneCoin: totalSupply cannot be zero");
  if (tokenAmount > params.totalSupply) {
    throw new Error("lendingZap.calcWithdrawOneCoin: tokenAmount exceeds totalSupply");
  }
  const N = BigInt(n);
  let fee = (params.fee * N) / (4n * (N - 1n));
  fee += (fee * FEE_IMPRECISION) / FEE_DENOMINATOR;

  const xp: bigint[] = [];
  let S = 0n;
  for (let j = 0; j < n; j++) {
    let x = params.precisionMul[j] * params.balances[j];
    if (params.useLending[j]) x = (x * params.rates[j]) / LENDING_PRECISION;
    xp.push(x);
    S += x;
  }
  const D0 = getD(params.A, xp);
  const D1 = D0 - (tokenAmount * D0) / params.totalSupply;
  const xpReduced = [...xp];
  for (let j = 0; j < n; j++) {
    const bIdeal = (xp[j] * D1) / D0;
    let bExpected = xp[j];
    if (j === i) bExpected -= (S * (D0 - D1)) / D0;
    const dxExpected = bIdeal >= bExpected ? bIdeal - bExpected : bExpected - bIdeal;
    xpReduced[j] -= (fee * dxExpected) / FEE_DENOMINATOR;
  }
  const dy = xpReduced[i] - getY(params.A, i, xpReduced, D1);
  return dy / params.precisionMul[i];
}

/**
 * Wrapped amount the zap's `remove_liquidity_one_coin` asks the pool for:
 * `dy * 1e18 / rate_i` of coin i (the pool's `remove_liquidity_imbalance`
 * then burns LP for it; unused LP is returned unless `donate_dust`).
 *
 * @param currentRates - `exchangeRateCurrent()` (accrued) per lending coin
 */
export function removeLiquidityOneCoinWrapped(
  params: LendingZapParams,
  tokenAmount: bigint,
  i: number,
  currentRates: bigint[]
): { dy: bigint; wrappedAmount: bigint } {
  const rates = params.useLending.map((l, k) => (l ? currentRates[k] : LENDING_PRECISION));
  const dy = calcWithdrawOneCoin({ ...params, rates }, tokenAmount, i);
  return { dy, wrappedAmount: (dy * LENDING_PRECISION) / rates[i] };
}


