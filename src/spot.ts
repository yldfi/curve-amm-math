/**
 * Fee-free marginal rates and pool-spot LP valuation for Curve pools.
 *
 * The marginal rate r_{j→i} is the fee-free amount of coin i a pool pays per
 * unit of coin j for an infinitesimal trade, in raw token units: the ratio of
 * the invariant's gradient components at the current state.
 *
 * The pool-spot value of L LP tokens in coin i,
 *
 *   UB_i = L / supply · Σ_j balance_j · r_{j→i}     (r_{i→i} = 1)
 *
 * is an upper bound for `calc_withdraw_one_coin(L, i)`: a one-coin withdrawal
 * is a pro-rata withdrawal plus swaps of the other coins into coin i along a
 * convex curve, minus fees, and the tangent at the pro-rata point bounds every
 * such swap.
 *
 * All results are exact rationals ({@link Ratio}); floor them once at the end
 * with {@link floorRatio}.
 */

import { A_MULTIPLIER, PRECISION } from "./constants";
import { newtonD } from "./cryptoswap";
import {
  getDVariant,
  getXp,
  type StableLiquidityParams,
} from "./stableswap-exact";

/** An exact rational `n / d` (d > 0). */
export interface Ratio {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** Build a reduced rational; throws on a zero denominator. */
export function ratio(n: bigint, d: bigint = 1n): Ratio {
  if (d === 0n) throw new Error("spot: zero denominator");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

const mul = (a: Ratio, b: Ratio): Ratio => ratio(a.n * b.n, a.d * b.d);
const div = (a: Ratio, b: Ratio): Ratio => ratio(a.n * b.d, a.d * b.n);
const add = (a: Ratio, b: Ratio): Ratio => ratio(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Ratio, b: Ratio): Ratio => ratio(a.n * b.d - b.n * a.d, a.d * b.d);

/** a < b */
export function ratioLessThan(a: Ratio, b: Ratio): boolean {
  return a.n * b.d < b.n * a.d;
}

/** floor(n / d) for a non-negative rational. */
export function floorRatio(r: Ratio): bigint {
  if (r.n < 0n) throw new Error("spot: floorRatio of a negative value");
  return r.n / r.d;
}

/**
 * Pool-spot value of `lpAmount` LP in raw units of coin `i`, from per-coin
 * marginal rates into coin i:
 * `(balance_i + Σ_{j≠i} balance_j · r_{j→i}) · lpAmount / supply`.
 *
 * @param rates - `rates[j]` = r_{j→i} in raw units; `rates[i]` is ignored
 */
export function lpSpotValueFromRates(
  balances: readonly bigint[],
  i: number,
  rates: readonly Ratio[],
  lpAmount: bigint,
  supply: bigint
): Ratio {
  if (supply <= 0n) throw new Error("spot: supply must be positive");
  if (i < 0 || i >= balances.length) throw new Error(`spot: index out of bounds (i=${i})`);
  let total = ratio(balances[i]);
  for (let j = 0; j < balances.length; j++) {
    if (j === i) continue;
    total = add(total, mul(ratio(balances[j]), rates[j]));
  }
  return mul(total, ratio(lpAmount, supply));
}

// ============================================
// StableSwap
// ============================================

function stableState(params: StableLiquidityParams) {
  const ampPrecision = params.ampPrecision ?? 100n;
  const amp = params.ampPrecise ?? params.A * ampPrecision;
  const xp = getXp(params.balances, params.rates);
  const D = getDVariant(xp, amp, params.variant, ampPrecision);
  return { amp, ampPrecision, xp, D };
}

/**
 * Fee-free marginal rate r_{j→i} of a StableSwap pool in raw units, from the
 * invariant gradient: `(F_j / F_i) · (rate_j / rate_i)` with
 * `F_k ∝ (Ann·N^N·Πx·x_k + D^(N+1)) / x_k` (A_PRECISION folded in). D is the
 * pool's `get_D` of the current balances.
 */
export function stableSwapMarginalRate(params: StableLiquidityParams, j: number, i: number): Ratio {
  const n = BigInt(params.balances.length);
  if (i < 0 || j < 0 || i >= params.balances.length || j >= params.balances.length) {
    throw new Error(`spot: index out of bounds (i=${i}, j=${j})`);
  }
  const { amp, ampPrecision, xp, D } = stableState(params);
  if (xp.some((x) => x <= 0n)) throw new Error("spot: empty pool coin");
  const prod = xp.reduce((a, b) => a * b, 1n);
  const k = amp * n * n ** n * prod;
  const q = ampPrecision * D ** (n + 1n);
  return ratio(
    (k * xp[j] + q) * xp[i] * params.rates[j],
    (k * xp[i] + q) * xp[j] * params.rates[i]
  );
}

/**
 * Pool-spot value of `lpAmount` LP in raw units of coin `i` for a StableSwap
 * pool (closed form of {@link lpSpotValueFromRates} with the exact gradient):
 *
 *   UB = L·x_i·(Ann·S·N^N·Πx + N·D^(N+1)) / (supply·(Ann·x_i·N^N·Πx + D^(N+1))) / rate_i
 *
 * UB increases with D and `get_D` converges to within one unit, so this
 * returns the smaller of the values at D − 1 and D + 1: a guaranteed upper
 * bound for `calc_withdraw_one_coin`, never above the true spot value.
 */
export function stableSwapLpSpotValue(
  params: StableLiquidityParams,
  lpAmount: bigint,
  i: number
): Ratio {
  const supply = params.totalSupply;
  if (supply <= 0n) throw new Error("spot: supply must be positive");
  if (i < 0 || i >= params.balances.length) throw new Error(`spot: index out of bounds (i=${i})`);
  const n = BigInt(params.balances.length);
  const { amp, ampPrecision, xp, D } = stableState(params);
  if (xp.some((x) => x <= 0n)) throw new Error("spot: empty pool coin");
  const S = xp.reduce((a, b) => a + b, 0n);
  const prod = xp.reduce((a, b) => a * b, 1n);
  const nn = n ** n;
  const a = amp * n;
  const at = (dd: bigint): Ratio => {
    const dn1 = dd ** (n + 1n);
    return ratio(
      lpAmount * xp[i] * (a * S * nn * prod + ampPrecision * n * dn1) * PRECISION,
      supply * (a * xp[i] * nn * prod + ampPrecision * dn1) * params.rates[i]
    );
  };
  const lo = at(D - 1n);
  const hi = at(D + 1n);
  return ratioLessThan(lo, hi) ? lo : hi;
}

// ============================================
// CryptoSwap (classic and NG: same invariant)
// ============================================

/**
 * CryptoSwap state for spot math (2 or 3 coins). Works for classic
 * CurveCryptoSwap2 / tricrypto2 and Twocrypto-NG / Tricrypto-NG pools:
 * they share the invariant.
 */
export interface CryptoSpotState {
  /** On-chain `A()` (A · N^N · A_MULTIPLIER) */
  A: bigint;
  /** On-chain `gamma()` */
  gamma: bigint;
  /** Raw balances */
  balances: readonly bigint[];
  /** 10^(18 − decimals) per coin (`precisions()`) */
  precisions: readonly bigint[];
  /** `price_scale` of coins 1..N−1 against coin 0 (1e18) */
  priceScales: readonly bigint[];
  /**
   * Invariant to take the gradient at. Defaults to `newton_D` of the current
   * balances (the curve the balances lie on).
   */
  D?: bigint;
}

/** Raw → xp factor of coin k: precision_k · price_scale_k / 1e18. */
function cryptoScale(state: CryptoSpotState, k: number): Ratio {
  return k === 0
    ? ratio(state.precisions[0])
    : ratio(state.precisions[k] * state.priceScales[k - 1], PRECISION);
}

/**
 * Fee-free marginal rate r_{j→i} of a CryptoSwap pool in raw units, from the
 * gradient of the invariant
 *
 *   F = K·D^(N−1)·S + Πx − K·D^N − (D/N)^N,
 *   K = A·K0·γ² / (γ + 1 − K0)²,  K0 = N^N·Πx / D^N,  A = A() / (A_MULTIPLIER·N^N)
 *
 * at fixed D: `x_k·∂F/∂x_k = K·D^(N−1)·x_k + T` with
 * `T = Πx + (dK/dK0)·K0·(D^(N−1)·S − D^N)`, so
 * `r = (K·x_j/D + T̂)·x_i / ((K·x_i/D + T̂)·x_j)` in xp units (T̂ = T / D^N),
 * then scaled by the coins' raw → xp factors. Exact rational arithmetic on
 * unrounded xp; the only approximation is D (newton_D converges to 1e-14).
 */
export function cryptoSwapMarginalRate(state: CryptoSpotState, j: number, i: number): Ratio {
  const N = state.balances.length;
  if (N !== 2 && N !== 3) throw new Error(`spot: crypto pool must have 2 or 3 coins (got ${N})`);
  if (i < 0 || j < 0 || i >= N || j >= N) throw new Error(`spot: index out of bounds (i=${i}, j=${j})`);
  if (i === j) return ratio(1n);

  const scales = state.balances.map((_, k) => cryptoScale(state, k));
  // Unrounded xp, normalised by D
  const xpExact = state.balances.map((b, k) => mul(ratio(b), scales[k]));
  const xpFloor = xpExact.map((x) => floorRatio(x));
  if (xpFloor.some((x) => x <= 0n)) throw new Error("spot: empty pool coin");
  const Dint = state.D ?? newtonD(state.A, state.gamma, xpFloor);
  const D = ratio(Dint);
  const x = xpExact.map((v) => div(v, D));

  const nBig = BigInt(N);
  const nn = ratio(nBig ** nBig);
  const A = ratio(state.A, A_MULTIPLIER * nBig ** nBig);
  const g = ratio(state.gamma, PRECISION);
  const one = ratio(1n);

  const P = x.reduce((acc, v) => mul(acc, v), one);
  const S = x.reduce((acc, v) => add(acc, v), ratio(0n));
  const K0 = mul(P, nn);
  const gp1 = add(g, one);
  const denom = sub(gp1, K0);
  if (denom.n === 0n) throw new Error("spot: degenerate state (K0 = 1 + gamma)");
  const g2 = mul(g, g);
  const K = div(mul(mul(A, K0), g2), mul(denom, denom));
  const dKdK0 = div(mul(mul(A, g2), add(gp1, K0)), mul(mul(denom, denom), denom));
  // T̂ = Πx̂ + dK/dK0 · K0 · (Ŝ − 1)
  const T = add(P, mul(mul(dKdK0, K0), sub(S, one)));

  const Fj = add(mul(K, x[j]), T);
  const Fi = add(mul(K, x[i]), T);
  // xp units: (Fj · x_i) / (Fi · x_j); raw: × scale_j / scale_i
  const rXp = div(mul(Fj, x[i]), mul(Fi, x[j]));
  const r = mul(rXp, div(scales[j], scales[i]));
  if (r.n <= 0n) throw new Error("spot: non-positive marginal rate (state off the curve)");
  return r;
}

/**
 * Pool-spot value of `lpAmount` LP in raw units of coin `i` for a CryptoSwap
 * pool, from {@link cryptoSwapMarginalRate}.
 */
export function cryptoSwapLpSpotValue(
  state: CryptoSpotState,
  lpAmount: bigint,
  supply: bigint,
  i: number
): Ratio {
  const rates = state.balances.map((_, j) =>
    j === i ? ratio(1n) : cryptoSwapMarginalRate(state, j, i)
  );
  return lpSpotValueFromRates(state.balances, i, rates, lpAmount, supply);
}
