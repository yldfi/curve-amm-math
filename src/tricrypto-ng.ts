/**
 * Curve Tricrypto-NG exact math (Vyper-faithful, wei-exact).
 *
 * Line-by-line port of the verified mainnet sources:
 *
 * - Pool:  `CurveTricryptoOptimizedWETH` v2.0.0
 *          (e.g. TricryptoUSDT 0xf5f5B97624542D72A9E06f04804Bf81baA15e2B4,
 *          TricryptoUSDC 0x7F86Bf177Dd4F3494b841a37e810A34dD56c829B,
 *          TriCRV 0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14)
 * - Math:  `CurveTricryptoMathOptimized` v2.0.0
 *          (0xcBFf3004a20dBfE2731543AA38599A526e0fD6eE)
 * - Views: `CurveCryptoViews3Optimized`
 *          (0x064253915b8449fdEFac2c4A74aA9fdF56691a31)
 *
 * Every function here is exact for that implementation set ONLY. Before
 * quoting a pool, check `pool.version() == "v2.0.0"` and
 * `pool.MATH() == 0xcBFf...D6eE` (see {@link SUPPORTED_POOL_VERSION} and
 * {@link SUPPORTED_MATH_ADDRESS}); other implementations must not be quoted
 * with this module.
 *
 * Vyper semantics are reproduced deliberately:
 * - checked uint256/int256 arithmetic throws where the contract would revert;
 * - `unsafe_*` operations wrap modulo 2**256 (two's complement for int256)
 *   and `unsafe_div` by zero yields 0;
 * - int256 division truncates toward zero (EVM SDIV), as BigInt does.
 *
 * State semantics (important):
 * - `D` must be the pool's STORED `D()`; views never re-solve D from balances
 *   unless the pool is ramping A/gamma (`future_A_gamma_time > block.timestamp`),
 *   in which case set `isRamping: true` and the port re-solves it exactly like
 *   the contracts (`newton_D(A, gamma, xp, 0)`).
 * - `A` and `gamma` must be the current `A()` / `gamma()` getter values.
 * - `precisions` must be `pool.precisions()`.
 */

import { A_MULTIPLIER, FEE_DENOMINATOR, PRECISION } from "./constants";

// ============================================
// Implementation identity
// ============================================

/** `pool.version()` this module is exact for. */
export const SUPPORTED_POOL_VERSION = "v2.0.0";

/** `pool.MATH()` (CurveTricryptoMathOptimized v2.0.0, Ethereum mainnet) this module is exact for. */
export const SUPPORTED_MATH_ADDRESS = "0xcbff3004a20dbfe2731543aa38599a526e0fd6ee";

/** Views contract (CurveCryptoViews3Optimized, Ethereum mainnet) this module is exact for. */
export const SUPPORTED_VIEWS_ADDRESS = "0x064253915b8449fdefac2c4a74aa9fdf56691a31";

/**
 * Throws unless the given on-chain identity matches the implementation this
 * module ports. Use it to avoid silently mis-quoting other Tricrypto versions.
 *
 * @param version - `pool.version()`
 * @param mathAddress - `pool.MATH()` (optional; checked when provided)
 */
export function assertSupportedImplementation(version: string, mathAddress?: string): void {
  if (version !== SUPPORTED_POOL_VERSION) {
    throw new Error(
      `tricryptoNg: unsupported pool version "${version}" (exact only for ${SUPPORTED_POOL_VERSION})`
    );
  }
  if (mathAddress !== undefined && mathAddress.toLowerCase() !== SUPPORTED_MATH_ADDRESS) {
    throw new Error(
      `tricryptoNg: unsupported MATH contract ${mathAddress} (exact only for ${SUPPORTED_MATH_ADDRESS})`
    );
  }
}

// ============================================
// Constants (CurveTricryptoMathOptimized v2.0.0)
// ============================================

const N_COINS = 3n;

const MIN_GAMMA = 10n ** 10n;
const MAX_GAMMA = 5n * 10n ** 16n;

const MIN_A = (N_COINS ** N_COINS * A_MULTIPLIER) / 100n;
const MAX_A = N_COINS ** N_COINS * A_MULTIPLIER * 1000n;

/** Pool constant NOISE_FEE (0.1 bps) added to the add-liquidity fee. */
const NOISE_FEE = 10n ** 5n;

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_INT256 = (1n << 255n) - 1n;
const MIN_INT256 = -(1n << 255n);

const E14 = 10n ** 14n;
const E16 = 10n ** 16n;
const E17 = 10n ** 17n;
const E18 = 10n ** 18n;
const E20 = 10n ** 20n;
const E36 = 10n ** 36n;

// ============================================
// Vyper integer semantics
// ============================================

function fail(message: string): never {
  throw new Error(`tricryptoNg: ${message}`);
}

function u256(x: bigint): bigint {
  if (x < 0n) fail("uint256 underflow (contract would revert)");
  if (x > MAX_UINT256) fail("uint256 overflow (contract would revert)");
  return x;
}

/** Checked uint256 ops (Vyper `+ - * /`). */
const add = (a: bigint, b: bigint): bigint => u256(a + b);
const sub = (a: bigint, b: bigint): bigint => u256(a - b);
const mul = (a: bigint, b: bigint): bigint => u256(a * b);
function div(a: bigint, b: bigint): bigint {
  if (b === 0n) fail("division by zero (contract would revert)");
  return a / b;
}

/** Wrapping uint256 ops (Vyper `unsafe_add/sub/mul/div`). */
const unsafeAdd = (a: bigint, b: bigint): bigint => BigInt.asUintN(256, a + b);
const unsafeSub = (a: bigint, b: bigint): bigint => BigInt.asUintN(256, a - b);
const unsafeMul = (a: bigint, b: bigint): bigint => BigInt.asUintN(256, a * b);
const unsafeDiv = (a: bigint, b: bigint): bigint => (b === 0n ? 0n : a / b);

function i256(x: bigint): bigint {
  if (x > MAX_INT256 || x < MIN_INT256) fail("int256 overflow (contract would revert)");
  return x;
}

/** Checked int256 ops. Division truncates toward zero (EVM SDIV). */
const iAdd = (a: bigint, b: bigint): bigint => i256(a + b);
const iSub = (a: bigint, b: bigint): bigint => i256(a - b);
const iMul = (a: bigint, b: bigint): bigint => i256(a * b);
function iDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) fail("int256 division by zero (contract would revert)");
  return i256(a / b);
}

/** Wrapping int256 ops (Vyper `unsafe_*` on int256). */
const iUnsafeAdd = (a: bigint, b: bigint): bigint => BigInt.asIntN(256, a + b);
const iUnsafeSub = (a: bigint, b: bigint): bigint => BigInt.asIntN(256, a - b);
const iUnsafeMul = (a: bigint, b: bigint): bigint => BigInt.asIntN(256, a * b);
const iUnsafeDiv = (a: bigint, b: bigint): bigint =>
  b === 0n ? 0n : BigInt.asIntN(256, a / b);

/** `convert(x, int256)` for a uint256 value. */
function toInt256(x: bigint): bigint {
  if (x < 0n || x > MAX_INT256) fail("uint256 -> int256 conversion out of range");
  return x;
}

/** `convert(x, uint256)` for an int256 value. */
function toUint256(x: bigint): bigint {
  if (x < 0n) fail("int256 -> uint256 conversion of a negative value");
  return x;
}

/** Vyper `abs(int256)`. */
function iAbs(x: bigint): bigint {
  if (x === MIN_INT256) fail("abs(int256 min) overflow");
  return x < 0n ? -x : x;
}

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function checkCoinIndex(i: number, fn: string): void {
  if (!Number.isInteger(i) || i < 0 || i > 2) {
    fail(`${fn}: coin index out of range (i=${i}, must be 0, 1 or 2)`);
  }
}

// ============================================
// Types
// ============================================

/**
 * Tricrypto-NG pool state snapshot (all values as returned by the pool
 * getters at one block).
 */
export interface TricryptoNgParams {
  /** `pool.A()` (already includes N**N * A_MULTIPLIER, ramp-interpolated) */
  A: bigint;
  /** `pool.gamma()` (ramp-interpolated) */
  gamma: bigint;
  /** STORED invariant `pool.D()` (not re-solved from balances) */
  D: bigint;
  /** `pool.mid_fee()` */
  midFee: bigint;
  /** `pool.out_fee()` */
  outFee: bigint;
  /** `pool.fee_gamma()` */
  feeGamma: bigint;
  /** `[pool.price_scale(0), pool.price_scale(1)]` */
  priceScales: [bigint, bigint];
  /** `pool.balances(k)` (unscaled, token decimals) */
  balances: [bigint, bigint, bigint];
  /** `pool.precisions()` (10**(18 - decimals)) */
  precisions: [bigint, bigint, bigint];
  /** `pool.totalSupply()`; required by LP-token functions */
  totalSupply?: bigint;
  /**
   * True when `pool.future_A_gamma_time() > block.timestamp`. The contracts
   * then ignore stored D and re-solve `newton_D(A, gamma, xp, 0)`.
   */
  isRamping?: boolean;
}

/** Inputs of the pool's EMA `price_oracle(k)` view. */
export interface TricryptoNgPriceOracleState {
  /** Raw stored oracle price (unpacked `price_oracle_packed[k]`, NOT the `price_oracle(k)` view) */
  storedPriceOracle: bigint;
  /** `pool.price_scale(k)` */
  priceScale: bigint;
  /** `pool.last_prices(k)` */
  lastPrices: bigint;
  /** `pool.last_prices_timestamp()` */
  lastPricesTimestamp: bigint;
  /** `pool.ma_time()` */
  maTime: bigint;
  /** Timestamp of the block the view is evaluated at */
  blockTimestamp: bigint;
}

// ============================================
// Math utils (CurveTricryptoMathOptimized v2.0.0)
// ============================================

/**
 * Floor integer square root. Mirrors Vyper's builtin `isqrt(uint256)`.
 */
export function isqrt(x: bigint): bigint {
  if (x < 0n) fail("isqrt: negative input");
  if (x < 2n) return x;
  let z = 1n << BigInt((x.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (z + x / z) >> 1n;
    if (y >= z) return z;
    z = y;
  }
}

/** `_snekmate_log_2(x, False)`: floor(log2(x)), 0 for x = 0. */
function log2Floor(x: bigint): bigint {
  return x === 0n ? 0n : BigInt(x.toString(2).length - 1);
}

const CBRT_T = 115792089237316195423570985008687907853269n;

/**
 * Cube root with 1e18 precision: `cbrt(x) = (x / 1e18)^(1/3) * 1e18`.
 * Mirrors `CurveTricryptoMathOptimized._cbrt` v2.0.0 (identical in
 * `CurveTwocryptoMathOptimized` v2.1.0): fixed initial guess and exactly 7
 * unrolled Newton iterations.
 */
export function cbrt(x: bigint): bigint {
  u256(x);
  let xx: bigint;
  if (x >= CBRT_T * E18) {
    xx = x;
  } else if (x >= CBRT_T) {
    xx = unsafeMul(x, E18);
  } else {
    xx = unsafeMul(x, E36);
  }

  const log2x = log2Floor(xx);
  const remainder = log2x % 3n;
  let a = unsafeDiv(
    unsafeMul(BigInt.asUintN(256, 2n ** (log2x / 3n)), 1260n ** remainder),
    1000n ** remainder
  );

  for (let k = 0; k < 7; k++) {
    a = unsafeDiv(unsafeAdd(unsafeMul(2n, a), unsafeDiv(xx, unsafeMul(a, a))), 3n);
  }

  if (x >= CBRT_T * E18) {
    a = unsafeMul(a, 10n ** 12n);
  } else if (x >= CBRT_T) {
    a = unsafeMul(a, 10n ** 6n);
  }

  return a;
}

/** `_sort`: sorts three numbers in descending order. */
function sortDesc(unsorted: readonly bigint[]): [bigint, bigint, bigint] {
  const x: [bigint, bigint, bigint] = [unsorted[0], unsorted[1], unsorted[2]];
  let temp = x[0];
  if (x[0] < x[1]) {
    x[0] = x[1];
    x[1] = temp;
  }
  if (x[0] < x[2]) {
    temp = x[0];
    x[0] = x[2];
    x[2] = temp;
  }
  if (x[1] < x[2]) {
    temp = x[1];
    x[1] = x[2];
    x[2] = temp;
  }
  return x;
}

function checkLength3(x: readonly bigint[], fn: string): void {
  if (x.length !== 3) fail(`${fn}: expected exactly 3 values (got ${x.length})`);
}

/**
 * Geometric mean of three 1e18-precision numbers.
 * Mirrors `CurveTricryptoMathOptimized.geometric_mean` v2.0.0.
 */
export function geometricMean(x: readonly bigint[]): bigint {
  checkLength3(x, "geometricMean");
  const prod = unsafeDiv(mul(unsafeDiv(mul(x[0], x[1]), E18), x[2]), E18);
  if (prod === 0n) return 0n;
  return cbrt(prod);
}

/**
 * Fee reduction coefficient `fee_gamma / (fee_gamma + (1 - K))`.
 * Mirrors `CurveTricryptoMathOptimized.reduction_coefficient` v2.0.0.
 */
export function reductionCoefficient(x: readonly bigint[], feeGamma: bigint): bigint {
  checkLength3(x, "reductionCoefficient");
  const S = add(add(x[0], x[1]), x[2]);

  let K = div(mul(mul(E18, N_COINS), x[0]), S);
  K = unsafeDiv(mul(mul(K, N_COINS), x[1]), S);
  K = unsafeDiv(mul(mul(K, N_COINS), x[2]), S);

  if (feeGamma > 0n) {
    K = div(mul(feeGamma, E18), sub(add(feeGamma, E18), K));
  }

  return K;
}

/**
 * e**x with 1e18 precision (Snekmate `wad_exp`).
 * Mirrors `CurveTricryptoMathOptimized.wad_exp` v2.0.0 (identical arithmetic
 * in `CurveTwocryptoMathOptimized.wad_exp` v2.1.0).
 */
export function wadExp(power: bigint): bigint {
  i256(power);
  if (power <= -42139678854452767551n) return 0n;
  if (power >= 135305999368893231589n) fail("wadExp: wad_exp overflow");

  const LN2_96 = 54916777467707473351141471128n;

  // value = unsafe_div(x << 78, 5 ** 18)
  let value = iUnsafeDiv(BigInt.asIntN(256, power << 78n), 5n ** 18n);

  // k = unsafe_add(unsafe_div(value << 96, ln2), 2 ** 95) >> 96
  const k = iUnsafeAdd(iUnsafeDiv(BigInt.asIntN(256, value << 96n), LN2_96), 2n ** 95n) >> 96n;
  value = iUnsafeSub(value, iUnsafeMul(k, LN2_96));

  const y = iUnsafeAdd(
    iUnsafeMul(iUnsafeAdd(value, 1346386616545796478920950773328n), value) >> 96n,
    57155421227552351082224309758442n
  );
  const p = iUnsafeAdd(
    iUnsafeMul(
      iUnsafeAdd(
        iUnsafeMul(iUnsafeSub(iUnsafeAdd(y, value), 94201549194550492254356042504812n), y) >> 96n,
        28719021644029726153956944680412240n
      ),
      value
    ),
    BigInt.asIntN(256, 4385272521454847904659076985693276n << 96n)
  );

  let q = iUnsafeAdd(
    iUnsafeMul(iUnsafeSub(value, 2855989394907223263936484059900n), value) >> 96n,
    50020603652535783019961831881945n
  );
  q = iUnsafeSub(iUnsafeMul(q, value) >> 96n, 533845033583426703283633433725380n);
  q = iUnsafeAdd(iUnsafeMul(q, value) >> 96n, 3604857256930695427073651918091429n);
  q = iUnsafeSub(iUnsafeMul(q, value) >> 96n, 14423608567350463180887372962807573n);
  q = iUnsafeAdd(iUnsafeMul(q, value) >> 96n, 26449188498355588339934803723976023n);

  const r = iUnsafeDiv(p, q);

  return (
    unsafeMul(BigInt.asUintN(256, r), 3822833074963236453042738258902158003155416615667n) >>
    BigInt.asUintN(256, iUnsafeSub(195n, k))
  );
}

// ============================================
// AMM math (CurveTricryptoMathOptimized v2.0.0)
// ============================================

function checkUnsafeXFrac(frac: bigint): void {
  if (!(frac > E16 - 1n && frac < E20 + 1n)) fail("Unsafe values x[i]");
}

/**
 * Newton's method for x[i] given the other balances and D.
 * Mirrors `CurveTricryptoMathOptimized._newton_y` v2.0.0 (the fallback used
 * by `get_y` when the cubic solver's discriminant is not positive).
 *
 * @param ANN - `pool.A()`
 * @param gamma - `pool.gamma()`
 * @param x - scaled balances (xp)
 * @param D - invariant
 * @param i - index of the coin to solve for
 */
export function newtonY(
  ANN: bigint,
  gamma: bigint,
  x: readonly bigint[],
  D: bigint,
  i: number
): bigint {
  checkLength3(x, "newtonY");
  checkCoinIndex(i, "newtonY");

  for (let k = 0; k < 3; k++) {
    if (k !== i) checkUnsafeXFrac(div(mul(x[k], E18), D));
  }

  let y = div(D, N_COINS);
  let K0_i = E18;
  let S_i = 0n;

  const xZeroed: bigint[] = [x[0], x[1], x[2]];
  xZeroed[i] = 0n;
  const xSorted = sortDesc(xZeroed);

  const convergenceLimit = max(max(xSorted[0] / E14, D / E14), 100n);

  for (let j = 2; j < 4; j++) {
    const _x = xSorted[3 - j];
    y = div(mul(y, D), mul(_x, N_COINS));
    S_i = add(S_i, _x);
  }

  for (let j = 0; j < 2; j++) {
    K0_i = div(mul(mul(K0_i, xSorted[j]), N_COINS), D);
  }

  for (let iter = 0; iter < 255; iter++) {
    const yPrev = y;

    const K0 = div(mul(mul(K0_i, y), N_COINS), D);
    const S = add(S_i, y);

    let g1k0 = add(gamma, E18);
    if (g1k0 > K0) {
      g1k0 = add(sub(g1k0, K0), 1n);
    } else {
      g1k0 = add(sub(K0, g1k0), 1n);
    }

    // mul1 = 10**18 * D / gamma * _g1k0 / gamma * _g1k0 * A_MULTIPLIER / ANN
    const mul1 = div(
      mul(mul(div(mul(div(mul(E18, D), gamma), g1k0), gamma), g1k0), A_MULTIPLIER),
      ANN
    );

    // mul2 = 10**18 + (2 * 10**18) * K0 / _g1k0
    const mul2 = add(E18, div(mul(2n * E18, K0), g1k0));

    let yfprime = add(add(mul(E18, y), mul(S, mul2)), mul1);
    const dyfprime = mul(D, mul2);
    if (yfprime < dyfprime) {
      y = yPrev / 2n;
      continue;
    } else {
      yfprime -= dyfprime;
    }

    const fprime = div(yfprime, y);

    let yMinus = div(mul1, fprime);
    const yPlus = add(
      div(add(yfprime, mul(E18, D)), fprime),
      div(mul(yMinus, E18), K0)
    );
    yMinus = add(yMinus, div(mul(E18, S), fprime));

    if (yPlus < yMinus) {
      y = yPrev / 2n;
    } else {
      y = yPlus - yMinus;
    }

    const diff = y > yPrev ? y - yPrev : yPrev - y;

    if (diff < max(convergenceLimit, y / E14)) {
      const frac = div(mul(y, E18), D);
      if (!(frac > E16 - 1n && frac < E20 + 1n)) fail("Unsafe value for y");
      return y;
    }
  }

  return fail("newtonY: Did not converge");
}

/**
 * Solve for x[i] given the other balances and D (analytical cubic solver with
 * Newton fallback). Mirrors `CurveTricryptoMathOptimized.get_y` v2.0.0.
 *
 * @param ANN - `pool.A()`
 * @param gamma - `pool.gamma()`
 * @param x - scaled balances (xp)
 * @param D - invariant
 * @param i - index of the coin to solve for
 * @returns `[y, K0_prev]` exactly as the contract (K0_prev is 0 on the Newton fallback)
 */
export function getY(
  ANN: bigint,
  gamma: bigint,
  x: readonly bigint[],
  D: bigint,
  i: number
): [bigint, bigint] {
  checkLength3(x, "getY");
  checkCoinIndex(i, "getY");

  // Safety checks
  if (!(ANN > MIN_A - 1n && ANN < MAX_A + 1n)) fail("getY: unsafe values A");
  if (!(gamma > MIN_GAMMA - 1n && gamma < MAX_GAMMA + 1n)) fail("getY: unsafe values gamma");
  if (!(D > E17 - 1n && D < 10n ** 15n * E18 + 1n)) fail("getY: unsafe values D");

  for (let k = 0; k < 3; k++) {
    if (k !== i) checkUnsafeXFrac(div(mul(x[k], E18), D));
  }

  let j = 0;
  let k = 0;
  if (i === 0) {
    j = 1;
    k = 2;
  } else if (i === 1) {
    j = 0;
    k = 2;
  } else {
    j = 0;
    k = 1;
  }

  const ANNi = toInt256(ANN);
  const g = toInt256(gamma);
  const Di = toInt256(D);
  const x_j = toInt256(x[j]);
  const x_k = toInt256(x[k]);
  const gamma2 = iUnsafeMul(g, g);

  let a = E36 / 27n;

  // 10**36/9 + 2*10**18*gamma/27 - D**2/x_j*gamma**2*ANN/27**2/convert(A_MULTIPLIER, int256)/x_k
  let b = iSub(
    iUnsafeAdd(E36 / 9n, iUnsafeDiv(iUnsafeMul(2n * E18, g), 27n)),
    iUnsafeDiv(
      iUnsafeDiv(
        iUnsafeDiv(
          iMul(iUnsafeMul(iUnsafeDiv(iUnsafeMul(Di, Di), x_j), gamma2), ANNi),
          27n ** 2n
        ),
        A_MULTIPLIER
      ),
      x_k
    )
  );

  // 10**36/9 + gamma*(gamma + 4*10**18)/27 + gamma**2*(x_j+x_k-D)/D*ANN/27/convert(A_MULTIPLIER, int256)
  let c = iAdd(
    iUnsafeAdd(E36 / 9n, iUnsafeDiv(iUnsafeMul(g, iUnsafeAdd(g, 4n * E18)), 27n)),
    iUnsafeDiv(
      iUnsafeDiv(
        iUnsafeMul(
          iUnsafeDiv(iMul(gamma2, iUnsafeSub(iUnsafeAdd(x_j, x_k), Di)), Di),
          ANNi
        ),
        27n
      ),
      A_MULTIPLIER
    )
  );

  // (10**18 + gamma)**2/27
  let d = iUnsafeDiv(i256(iUnsafeAdd(E18, g) ** 2n), 27n);

  // abs(3*a*c/b - b)
  const d0 = iAbs(iSub(iDiv(iMul(iUnsafeMul(3n, a), c), b), b));

  let divider: bigint;
  if (d0 > 10n ** 48n) {
    divider = 10n ** 30n;
  } else if (d0 > 10n ** 44n) {
    divider = 10n ** 26n;
  } else if (d0 > 10n ** 40n) {
    divider = 10n ** 22n;
  } else if (d0 > 10n ** 36n) {
    divider = 10n ** 18n;
  } else if (d0 > 10n ** 32n) {
    divider = 10n ** 14n;
  } else if (d0 > 10n ** 28n) {
    divider = 10n ** 10n;
  } else if (d0 > 10n ** 24n) {
    divider = 10n ** 6n;
  } else if (d0 > 10n ** 20n) {
    divider = 10n ** 2n;
  } else {
    divider = 1n;
  }

  let additionalPrec: bigint;
  if (iAbs(a) > iAbs(b)) {
    additionalPrec = iAbs(iUnsafeDiv(a, b));
    a = iUnsafeDiv(iUnsafeMul(a, additionalPrec), divider);
    b = iUnsafeDiv(iMul(b, additionalPrec), divider);
    c = iUnsafeDiv(iMul(c, additionalPrec), divider);
    d = iUnsafeDiv(iMul(d, additionalPrec), divider);
  } else {
    additionalPrec = iAbs(iUnsafeDiv(b, a));
    a = iUnsafeDiv(iDiv(a, additionalPrec), divider);
    b = iUnsafeDiv(iUnsafeDiv(b, additionalPrec), divider);
    c = iUnsafeDiv(iUnsafeDiv(c, additionalPrec), divider);
    d = iUnsafeDiv(iUnsafeDiv(d, additionalPrec), divider);
  }

  // 3*a*c/b - b
  const _3ac = iMul(iUnsafeMul(3n, a), c);
  const delta0 = iSub(iUnsafeDiv(_3ac, b), b);

  // 9*a*c/b - 2*b - 27*a**2/b*d/b
  const delta1 = iSub(
    iSub(iUnsafeDiv(iMul(3n, _3ac), b), iUnsafeMul(2n, b)),
    iUnsafeDiv(iMul(iUnsafeDiv(iMul(27n, i256(a ** 2n)), b), d), b)
  );

  // delta1**2 + 4*delta0**2/b*delta0
  const sqrtArg = iAdd(
    i256(delta1 ** 2n),
    iMul(iUnsafeDiv(iMul(4n, i256(delta0 ** 2n)), b), delta0)
  );

  if (sqrtArg <= 0n) {
    return [newtonY(ANN, gamma, x, D, i), 0n];
  }
  const sqrtVal = toInt256(isqrt(sqrtArg));

  let bCbrt: bigint;
  if (b >= 0n) {
    bCbrt = toInt256(cbrt(b));
  } else {
    bCbrt = -toInt256(cbrt(toUint256(i256(-b))));
  }

  let secondCbrt: bigint;
  if (delta1 > 0n) {
    // convert(self._cbrt(convert((delta1 + sqrt_val), uint256)/2), int256)
    secondCbrt = toInt256(cbrt(unsafeDiv(toUint256(iAdd(delta1, sqrtVal)), 2n)));
  } else {
    secondCbrt = -toInt256(
      cbrt(unsafeDiv(toUint256(i256(-iSub(delta1, sqrtVal))), 2n))
    );
  }

  // b_cbrt*b_cbrt/10**18*second_cbrt/10**18
  const C1 = iUnsafeDiv(iMul(iUnsafeDiv(iMul(bCbrt, bCbrt), E18), secondCbrt), E18);

  // (b + b*delta0/C1 - C1)/3
  const rootK0 = iUnsafeDiv(iSub(iAdd(b, iDiv(iMul(b, delta0), C1)), C1), 3n);

  // D*D/27/x_k*D/x_j*root_K0/a
  const root = iUnsafeDiv(
    iMul(
      iUnsafeDiv(iMul(iUnsafeDiv(iUnsafeDiv(iMul(Di, Di), 27n), x_k), Di), x_j),
      rootK0
    ),
    a
  );

  const out: [bigint, bigint] = [
    toUint256(root),
    toUint256(iUnsafeDiv(iMul(E18, rootK0), a)),
  ];

  const frac = unsafeDiv(mul(out[0], E18), D);
  if (!(frac >= E16 - 1n && frac < E20 + 1n)) fail("Unsafe value for y");

  return out;
}

/**
 * Solve the Tricrypto invariant for D with Newton's method and the NG initial
 * guess. Mirrors `CurveTricryptoMathOptimized.newton_D` v2.0.0, including its
 * convergence rule (`diff * 1e14 < max(1e16, D)`) and post-convergence
 * "Unsafe values x[i]" assertion.
 *
 * @param ANN - `pool.A()`
 * @param gamma - `pool.gamma()`
 * @param xUnsorted - scaled balances (xp), any order
 * @param K0Prev - a priori K0 from `getY()[1]` (0 = none, as used by all views)
 */
export function newtonD(
  ANN: bigint,
  gamma: bigint,
  xUnsorted: readonly bigint[],
  K0Prev: bigint = 0n
): bigint {
  checkLength3(xUnsorted, "newtonD");
  const x = sortDesc(xUnsorted);
  if (!(x[0] < (MAX_UINT256 / E18) * N_COINS ** N_COINS)) fail("newtonD: out of limits");
  if (!(x[0] > 0n)) fail("newtonD: empty pool");

  const S = unsafeAdd(unsafeAdd(x[0], x[1]), x[2]);
  let D: bigint;

  if (K0Prev === 0n) {
    D = unsafeMul(N_COINS, geometricMean(x));
  } else {
    if (S > E36) {
      D = cbrt(
        mul(mul(unsafeDiv(mul(unsafeDiv(mul(x[0], x[1]), E36), x[2]), K0Prev), 27n), 10n ** 12n)
      );
    } else if (S > 10n ** 24n) {
      D = cbrt(
        mul(
          mul(unsafeDiv(mul(unsafeDiv(mul(x[0], x[1]), 10n ** 24n), x[2]), K0Prev), 27n),
          10n ** 6n
        )
      );
    } else {
      D = cbrt(mul(unsafeDiv(mul(unsafeDiv(mul(x[0], x[1]), E18), x[2]), K0Prev), 27n));
    }
  }

  for (let iter = 0; iter < 255; iter++) {
    const DPrev = D;

    // K0 = 10**18 * x[0] * N_COINS / D * x[1] * N_COINS / D * x[2] * N_COINS / D
    const K0 = unsafeDiv(
      unsafeMul(
        unsafeMul(
          unsafeDiv(
            unsafeMul(
              unsafeMul(unsafeDiv(unsafeMul(unsafeMul(E18, x[0]), N_COINS), D), x[1]),
              N_COINS
            ),
            D
          ),
          x[2]
        ),
        N_COINS
      ),
      D
    );

    let g1k0 = unsafeAdd(gamma, E18);
    if (g1k0 > K0) {
      g1k0 = unsafeAdd(unsafeSub(g1k0, K0), 1n);
    } else {
      g1k0 = unsafeAdd(unsafeSub(K0, g1k0), 1n);
    }

    // mul1 = 10**18 * D / gamma * _g1k0 / gamma * _g1k0 * A_MULTIPLIER / ANN
    const mul1 = unsafeDiv(
      unsafeMul(
        unsafeMul(
          unsafeDiv(unsafeMul(unsafeDiv(unsafeMul(E18, D), gamma), g1k0), gamma),
          g1k0
        ),
        A_MULTIPLIER
      ),
      ANN
    );

    // mul2 = (2 * 10**18) * N_COINS * K0 / _g1k0
    const mul2 = unsafeDiv(unsafeMul(2n * E18 * N_COINS, K0), g1k0);

    // neg_fprime = (S + S * mul2 / 10**18) + mul1 * N_COINS / K0 - mul2 * D / 10**18
    const negFprime = unsafeSub(
      unsafeAdd(
        unsafeAdd(S, unsafeDiv(unsafeMul(S, mul2), E18)),
        unsafeDiv(unsafeMul(mul1, N_COINS), K0)
      ),
      unsafeDiv(unsafeMul(mul2, D), E18)
    );

    // D_plus = D * (neg_fprime + S) / neg_fprime
    const DPlus = unsafeDiv(mul(D, unsafeAdd(negFprime, S)), negFprime);

    // D_minus = D*D / neg_fprime
    let DMinus = unsafeDiv(mul(D, D), negFprime);

    if (E18 > K0) {
      // D_minus += D * (mul1 / neg_fprime) / 10**18 * (10**18 - K0) / K0
      DMinus = add(
        DMinus,
        unsafeDiv(
          unsafeMul(unsafeDiv(mul(D, unsafeDiv(mul1, negFprime)), E18), unsafeSub(E18, K0)),
          K0
        )
      );
    } else {
      // D_minus -= D * (mul1 / neg_fprime) / 10**18 * (K0 - 10**18) / K0
      DMinus = sub(
        DMinus,
        unsafeDiv(
          unsafeMul(unsafeDiv(mul(D, unsafeDiv(mul1, negFprime)), E18), unsafeSub(K0, E18)),
          K0
        )
      );
    }

    if (DPlus > DMinus) {
      D = unsafeSub(DPlus, DMinus);
    } else {
      D = unsafeDiv(unsafeSub(DMinus, DPlus), 2n);
    }

    const diff = D > DPrev ? unsafeSub(D, DPrev) : unsafeSub(DPrev, D);

    if (unsafeMul(diff, E14) < max(E16, D)) {
      for (const _x of x) {
        const frac = unsafeDiv(unsafeMul(_x, E18), D);
        if (!(frac >= E16 - 1n && frac < E20 + 1n)) fail("Unsafe values x[i]");
      }
      return D;
    }
  }

  return fail("newtonD: Did not converge");
}

/**
 * Spot prices dx_0/dx_k (in price-scale units; multiply by `price_scale[k]`
 * / 1e18 for the real price). Mirrors `CurveTricryptoMathOptimized.get_p`
 * v2.0.0.
 *
 * @param xp - scaled balances
 * @param D - invariant
 * @param AGamma - `[A, gamma]`
 */
export function getP(
  xp: readonly bigint[],
  D: bigint,
  AGamma: readonly [bigint, bigint]
): [bigint, bigint] {
  checkLength3(xp, "getP");
  if (!(D > E17 - 1n && D < 10n ** 15n * E18 + 1n)) fail("getP: unsafe D values");

  // K0 = P * N**N / D**N, 10**36 precision
  const K0 = unsafeDiv(
    mul(unsafeDiv(mul(unsafeDiv(mul(mul(27n, xp[0]), xp[1]), D), xp[2]), D), E36),
    D
  );

  const gammaPlus = unsafeAdd(AGamma[1], E18);
  const GK0 = sub(
    add(
      unsafeDiv(mul(unsafeDiv(mul(mul(2n, K0), K0), E36), K0), E36),
      unsafeMul(gammaPlus, gammaPlus)
    ),
    unsafeDiv(
      mul(unsafeDiv(unsafeMul(K0, K0), E36), unsafeAdd(unsafeMul(2n, AGamma[1]), 3n * E18)),
      E18
    )
  );

  // NNAG2 = N**N * A * gamma**2
  const NNAG2 = unsafeDiv(unsafeMul(AGamma[0], unsafeMul(AGamma[1], AGamma[1])), A_MULTIPLIER);

  // denominator = (GK0 + NNAG2 * x / D * _K0 / 10**36)
  const denominator = add(GK0, unsafeDiv(mul(unsafeDiv(mul(NNAG2, xp[0]), D), K0), E36));

  const p = (k: number): bigint =>
    unsafeDiv(
      mul(
        div(
          mul(xp[0], add(GK0, unsafeDiv(mul(unsafeDiv(mul(NNAG2, xp[k]), D), K0), E36))),
          xp[k]
        ),
        E18
      ),
      denominator
    );

  return [p(1), p(2)];
}

// ============================================
// Pool internals (CurveTricryptoOptimizedWETH v2.0.0)
// ============================================

function checkParams(params: TricryptoNgParams, fn: string): void {
  if (params.balances.length !== 3 || params.precisions.length !== 3) {
    fail(`${fn}: balances and precisions must have exactly 3 elements`);
  }
  if (params.priceScales.length !== 2) {
    fail(`${fn}: priceScales must have exactly 2 elements`);
  }
}

function requireTotalSupply(params: TricryptoNgParams, fn: string): bigint {
  if (params.totalSupply === undefined) fail(`${fn}: params.totalSupply is required`);
  return params.totalSupply as bigint;
}

/** Scale raw balances exactly like the views contract (`x * price_scale * precision / 1e18`). */
function scaleBalances(
  raw: readonly bigint[],
  params: TricryptoNgParams
): [bigint, bigint, bigint] {
  return [
    mul(raw[0], params.precisions[0]),
    div(mul(mul(raw[1], params.priceScales[0]), params.precisions[1]), PRECISION),
    div(mul(mul(raw[2], params.priceScales[1]), params.precisions[2]), PRECISION),
  ];
}

/**
 * Scaled pool balances. Mirrors `CurveTricryptoOptimizedWETH.xp()` v2.0.0.
 */
export function xp(params: TricryptoNgParams): [bigint, bigint, bigint] {
  checkParams(params, "xp");
  return scaleBalances(params.balances, params);
}

/**
 * The D the views contract uses: stored `D()` unless ramping, in which case
 * `newton_D(A, gamma, xp, 0)`. Mirrors `CurveCryptoViews3Optimized._calc_D_ramp`.
 */
function currentD(params: TricryptoNgParams): bigint {
  if (params.isRamping) {
    return newtonD(params.A, params.gamma, scaleBalances(params.balances, params), 0n);
  }
  return params.D;
}

/**
 * Dynamic fee for the given scaled balances.
 * Mirrors `CurveTricryptoOptimizedWETH._fee` / `fee_calc(xp)` v2.0.0.
 */
export function feeCalc(
  scaledBalances: readonly bigint[],
  midFee: bigint,
  outFee: bigint,
  feeGamma: bigint
): bigint {
  const f = reductionCoefficient(scaledBalances, feeGamma);
  return unsafeDiv(add(mul(midFee, f), mul(outFee, sub(E18, f))), E18);
}

/**
 * Current pool fee. Mirrors `CurveTricryptoOptimizedWETH.fee()` v2.0.0
 * (`_fee(xp())`). Derivable from balances and price scales alone.
 */
export function fee(params: TricryptoNgParams): bigint {
  return feeCalc(xp(params), params.midFee, params.outFee, params.feeGamma);
}

/**
 * Fee charged on an (im)balanced deposit, as a fraction of 1e10.
 * Mirrors `CurveTricryptoOptimizedWETH._calc_token_fee` / `calc_token_fee`
 * v2.0.0 (`fee * N / (4 * (N - 1)) * sum|a_i - avg| / sum(a) + NOISE_FEE`).
 *
 * @param amountsScaled - deposit amounts scaled like xp
 * @param scaledBalances - scaled balances AFTER the liquidity change
 */
export function calcTokenFee(
  amountsScaled: readonly bigint[],
  scaledBalances: readonly bigint[],
  midFee: bigint,
  outFee: bigint,
  feeGamma: bigint
): bigint {
  checkLength3(amountsScaled, "calcTokenFee");
  // fee = sum(amounts_i - avg(amounts)) * fee' / sum(amounts)
  const feePrime = unsafeDiv(
    unsafeMul(feeCalc(scaledBalances, midFee, outFee, feeGamma), N_COINS),
    unsafeMul(4n, unsafeSub(N_COINS, 1n))
  );

  let S = 0n;
  for (const _x of amountsScaled) S = add(S, _x);

  const avg = unsafeDiv(S, N_COINS);
  let Sdiff = 0n;
  for (const _x of amountsScaled) {
    Sdiff = add(Sdiff, _x > avg ? unsafeSub(_x, avg) : unsafeSub(avg, _x));
  }

  return add(div(mul(feePrime, Sdiff), S), NOISE_FEE);
}

// ============================================
// Views (CurveCryptoViews3Optimized + pool views)
// ============================================

function getDyNoFee(
  params: TricryptoNgParams,
  i: number,
  j: number,
  dx: bigint
): { dy: bigint; xp: [bigint, bigint, bigint] } {
  checkParams(params, "getDy");
  if (
    i === j ||
    !Number.isInteger(i) ||
    !Number.isInteger(j) ||
    i < 0 ||
    i > 2 ||
    j < 0 ||
    j > 2
  ) {
    fail(`getDy: coin index out of range (i=${i}, j=${j})`);
  }
  if (!(dx > 0n)) fail("getDy: do not exchange 0 coins");

  const D = currentD(params);

  // adjust xp with input dx
  const raw: bigint[] = [...params.balances];
  raw[i] = add(raw[i], dx);
  const scaled = scaleBalances(raw, params);

  const yOut = getY(params.A, params.gamma, scaled, D, j);
  let dy = sub(sub(scaled[j], yOut[0]), 1n);
  scaled[j] = yOut[0];
  if (j > 0) {
    dy = div(mul(dy, PRECISION), params.priceScales[j - 1]);
  }
  dy = div(dy, params.precisions[j]);

  return { dy, xp: scaled };
}

/**
 * Output amount of coin j for `dx` of coin i, including the dynamic fee.
 * Mirrors `pool.get_dy(i, j, dx)` -> `CurveCryptoViews3Optimized.get_dy`.
 * Exact for pool v2.0.0 / math v2.0.0. Throws where the view reverts.
 */
export function getDy(params: TricryptoNgParams, i: number, j: number, dx: bigint): bigint {
  const { dy, xp: xpAfter } = getDyNoFee(params, i, j, dx);
  const feeRate = feeCalc(xpAfter, params.midFee, params.outFee, params.feeGamma);
  return sub(dy, div(mul(feeRate, dy), FEE_DENOMINATOR));
}

/**
 * Fee (in coin j units) charged by `get_dy(i, j, dx)`.
 * Mirrors `CurveCryptoViews3Optimized.calc_fee_get_dy`.
 */
export function calcFeeGetDy(
  params: TricryptoNgParams,
  i: number,
  j: number,
  dx: bigint
): bigint {
  const { dy, xp: xpAfter } = getDyNoFee(params, i, j, dx);
  return div(
    mul(feeCalc(xpAfter, params.midFee, params.outFee, params.feeGamma), dy),
    FEE_DENOMINATOR
  );
}

function getDxFee(
  params: TricryptoNgParams,
  i: number,
  j: number,
  dy: bigint
): { dx: bigint; xp: [bigint, bigint, bigint] } {
  checkParams(params, "getDx");
  if (
    i === j ||
    !Number.isInteger(i) ||
    !Number.isInteger(j) ||
    i < 0 ||
    i > 2 ||
    j < 0 ||
    j > 2
  ) {
    fail(`getDx: coin index out of range (i=${i}, j=${j})`);
  }
  if (!(dy > 0n)) fail("getDx: do not exchange out 0 coins");

  const D = currentD(params);

  const raw: bigint[] = [...params.balances];
  raw[j] = sub(raw[j], dy);
  const scaled = scaleBalances(raw, params);

  const xOut = getY(params.A, params.gamma, scaled, D, i);
  let dx = sub(xOut[0], scaled[i]);
  scaled[i] = xOut[0];
  if (i > 0) {
    dx = div(mul(dx, PRECISION), params.priceScales[i - 1]);
  }
  dx = div(dx, params.precisions[i]);

  return { dx, xp: scaled };
}

/**
 * Approximate input of coin i needed to receive `dy` of coin j (5 fixed-point
 * iterations, exactly like the contract). Mirrors `pool.get_dx(i, j, dy)` ->
 * `CurveCryptoViews3Optimized.get_dx`.
 */
export function getDx(params: TricryptoNgParams, i: number, j: number, dy: bigint): bigint {
  let dx = 0n;
  let _dy = dy;

  for (let k = 0; k < 5; k++) {
    const res = getDxFee(params, i, j, _dy);
    dx = res.dx;
    const feeDy = div(
      mul(feeCalc(res.xp, params.midFee, params.outFee, params.feeGamma), _dy),
      FEE_DENOMINATOR
    );
    _dy = add(add(dy, feeDy), 1n);
  }

  return dx;
}

function calcDTokenNoFee(
  params: TricryptoNgParams,
  amounts: readonly bigint[],
  deposit: boolean
): { dToken: bigint; amountsp: [bigint, bigint, bigint]; xp: [bigint, bigint, bigint] } {
  checkParams(params, "calcTokenAmount");
  checkLength3(amounts, "calcTokenAmount");
  const tokenSupply = requireTotalSupply(params, "calcTokenAmount");
  const D0 = currentD(params);

  const raw: bigint[] = [...params.balances];
  for (let k = 0; k < 3; k++) {
    raw[k] = deposit ? add(raw[k], amounts[k]) : sub(raw[k], amounts[k]);
  }

  const scaled = scaleBalances(raw, params);
  const amountsp = scaleBalances(amounts, params);

  const D = newtonD(params.A, params.gamma, scaled, 0n);
  let dToken = div(mul(tokenSupply, D), D0);

  if (deposit) {
    dToken = sub(dToken, tokenSupply);
  } else {
    dToken = sub(tokenSupply, dToken);
  }

  return { dToken, amountsp, xp: scaled };
}

/**
 * LP tokens minted (deposit) or burned (withdraw) for `amounts`, including
 * the NG fee on imbalanced liquidity. Mirrors `pool.calc_token_amount` ->
 * `CurveCryptoViews3Optimized.calc_token_amount`
 * (`d_token -= calc_token_fee(amountsp, xp) * d_token / 1e10 + 1`).
 *
 * @param amounts - raw token amounts per coin
 * @param deposit - true for add_liquidity, false for an imbalanced withdrawal
 */
export function calcTokenAmount(
  params: TricryptoNgParams,
  amounts: readonly bigint[],
  deposit: boolean
): bigint {
  const { dToken, amountsp, xp: scaled } = calcDTokenNoFee(params, amounts, deposit);
  const tokenFee = calcTokenFee(amountsp, scaled, params.midFee, params.outFee, params.feeGamma);
  return sub(dToken, add(div(mul(tokenFee, dToken), FEE_DENOMINATOR), 1n));
}

/**
 * LP-token fee charged by `calc_token_amount`.
 * Mirrors `CurveCryptoViews3Optimized.calc_fee_token_amount`.
 */
export function calcFeeTokenAmount(
  params: TricryptoNgParams,
  amounts: readonly bigint[],
  deposit: boolean
): bigint {
  const { dToken, amountsp, xp: scaled } = calcDTokenNoFee(params, amounts, deposit);
  const tokenFee = calcTokenFee(amountsp, scaled, params.midFee, params.outFee, params.feeGamma);
  return add(div(mul(tokenFee, dToken), FEE_DENOMINATOR), 1n);
}

function withdrawOneCoin(
  params: TricryptoNgParams,
  tokenAmount: bigint,
  i: number,
  mode: "pool" | "views"
): { dy: bigint; approxFee: bigint } {
  checkParams(params, "calcWithdrawOneCoin");
  const tokenSupply = requireTotalSupply(params, "calcWithdrawOneCoin");
  if (!(tokenAmount <= tokenSupply)) fail("calcWithdrawOneCoin: token amount more than supply");
  checkCoinIndex(i, "calcWithdrawOneCoin");

  const xx = params.balances;
  const precisions = params.precisions;
  const scaled: [bigint, bigint, bigint] = [precisions[0], precisions[1], precisions[2]];

  let priceScaleI = mul(PRECISION, precisions[0]);
  scaled[0] = mul(scaled[0], xx[0]);
  for (let k = 1; k < 3; k++) {
    const p = params.priceScales[k - 1];
    if (i === k) {
      priceScaleI = mul(p, scaled[i]);
    }
    scaled[k] =
      mode === "pool"
        ? unsafeDiv(mul(mul(scaled[k], xx[k]), p), PRECISION)
        : div(mul(mul(scaled[k], xx[k]), p), PRECISION);
  }

  const D0 = params.isRamping ? newtonD(params.A, params.gamma, scaled, 0n) : params.D;
  let D = D0;

  let feeRate: bigint;
  let dD: bigint;
  if (mode === "pool") {
    // Charge fees on D using an imprecise post-withdrawal xp; if the
    // correction would underflow, charge out_fee.
    const xpImprecise: [bigint, bigint, bigint] = [scaled[0], scaled[1], scaled[2]];
    const xpCorrection = div(mul(mul(scaled[i], N_COINS), tokenAmount), tokenSupply);
    feeRate = params.outFee;

    if (xpCorrection < xpImprecise[i]) {
      xpImprecise[i] -= xpCorrection;
      feeRate = feeCalc(xpImprecise, params.midFee, params.outFee, params.feeGamma);
    }

    dD = unsafeDiv(mul(tokenAmount, D), tokenSupply);
  } else {
    const f = reductionCoefficient(scaled, params.feeGamma);
    feeRate = div(add(mul(params.midFee, f), mul(params.outFee, sub(E18, f))), E18);
    dD = div(mul(tokenAmount, D), tokenSupply);
  }

  const DFee = add(div(mul(feeRate, dD), 2n * FEE_DENOMINATOR), 1n);
  const approxFee = div(mul(mul(N_COINS, DFee), xx[i]), D);

  D = sub(D, sub(dD, DFee));

  const y = getY(params.A, params.gamma, scaled, D, i)[0];
  const dy = div(mul(sub(scaled[i], y), PRECISION), priceScaleI);

  return { dy, approxFee };
}

/**
 * Amount of coin i received for burning `tokenAmount` LP tokens, including
 * the NG withdrawal fee. Mirrors `pool.calc_withdraw_one_coin(token_amount, i)`
 * (`CurveTricryptoOptimizedWETH._calc_withdraw_one_coin` v2.0.0), whose fee is
 * `_fee(xp_imprecise)` with `xp_imprecise[i] -= xp[i] * N * token_amount / supply`
 * (or `out_fee` if that would underflow).
 *
 * NOTE: this is the POOL's method. The views contract exposes a different
 * `calc_withdraw_one_coin(token_amount, i, swap)` that charges `_fee(xp)`
 * without the correction; see {@link calcWithdrawOneCoinViews}.
 */
export function calcWithdrawOneCoin(
  params: TricryptoNgParams,
  tokenAmount: bigint,
  i: number
): bigint {
  return withdrawOneCoin(params, tokenAmount, i, "pool").dy;
}

/**
 * `CurveCryptoViews3Optimized.calc_withdraw_one_coin(token_amount, i, swap)`.
 * Differs from the pool's own method (and from what `remove_liquidity_one_coin`
 * pays) in the fee: it uses `_fee(xp)` at the pre-withdrawal balances.
 */
export function calcWithdrawOneCoinViews(
  params: TricryptoNgParams,
  tokenAmount: bigint,
  i: number
): bigint {
  return withdrawOneCoin(params, tokenAmount, i, "views").dy;
}

/**
 * Amounts received for a balanced withdrawal of `amount` LP tokens.
 * Mirrors the arithmetic of `CurveTricryptoOptimizedWETH.remove_liquidity`
 * v2.0.0: `balances[i] * (amount - 1) / total_supply` (the `- 1` favours
 * remaining LPs), or the full balances when `amount == total_supply`.
 *
 * NOTE: on-chain, `remove_liquidity(..., claim_admin_fees=True)` first runs
 * `_claim_admin_fees()`, which may sync balances and mint admin LP tokens.
 * Pass the post-claim `balances` / `totalSupply` for an exact match in that
 * case; the result is exact as-is whenever the claim is a no-op.
 */
export function calcRemoveLiquidity(
  params: TricryptoNgParams,
  amount: bigint
): [bigint, bigint, bigint] {
  checkParams(params, "calcRemoveLiquidity");
  const totalSupply = requireTotalSupply(params, "calcRemoveLiquidity");
  if (amount > totalSupply) fail("calcRemoveLiquidity: amount exceeds total supply");

  const balances = params.balances;
  if (amount === totalSupply) {
    return [balances[0], balances[1], balances[2]];
  }

  const adjusted = sub(amount, 1n);
  return [
    div(mul(balances[0], adjusted), totalSupply),
    div(mul(balances[1], adjusted), totalSupply),
    div(mul(balances[2], adjusted), totalSupply),
  ];
}

/**
 * Pool value in "xcp" units. Mirrors `CurveTricryptoOptimizedWETH.get_xcp`
 * v2.0.0.
 */
export function getXcp(D: bigint, priceScales: readonly [bigint, bigint]): bigint {
  const x: [bigint, bigint, bigint] = [
    div(D, N_COINS),
    div(mul(D, E18), mul(N_COINS, priceScales[0])),
    div(mul(D, E18), mul(N_COINS, priceScales[1])),
  ];
  return geometricMean(x);
}

/**
 * Mirrors `pool.get_virtual_price()` v2.0.0:
 * `1e18 * get_xcp(self.D) / totalSupply`.
 *
 * Derivable from stored `D`, `price_scale` and `totalSupply` (NOT from
 * balances alone: stored D is only re-solved on state-changing calls). It is
 * not the cached `pool.virtual_price()` storage value, which `lp_price()`
 * uses and which only updates in `tweak_price` / admin-fee claims.
 */
export function getVirtualPrice(params: TricryptoNgParams): bigint {
  const totalSupply = requireTotalSupply(params, "getVirtualPrice");
  return div(mul(E18, getXcp(params.D, params.priceScales)), totalSupply);
}

/**
 * EMA price oracle for coin k+1. Mirrors `pool.price_oracle(k)` v2.0.0.
 * Needs raw storage (`price_oracle_packed`) that has no public getter.
 */
export function priceOracle(state: TricryptoNgPriceOracleState): bigint {
  if (state.lastPricesTimestamp < state.blockTimestamp) {
    const alpha = wadExp(
      -toInt256(
        div(mul(sub(state.blockTimestamp, state.lastPricesTimestamp), E18), state.maTime)
      )
    );

    // We cap state price that goes into the EMA with 2 x price_scale.
    return div(
      add(
        mul(min(state.lastPrices, mul(2n, state.priceScale)), sub(E18, alpha)),
        mul(state.storedPriceOracle, alpha)
      ),
      E18
    );
  }

  return state.storedPriceOracle;
}

/**
 * LP token price in coin-0 units. Mirrors `pool.lp_price()` v2.0.0:
 * `3 * self.virtual_price * cbrt(price_oracle[0] * price_oracle[1]) / 1e24`.
 *
 * NOT derivable from balances. Inputs are raw storage values:
 * @param cachedVirtualPrice - `pool.virtual_price()` (cached storage, not `get_virtual_price()`)
 * @param storedPriceOracles - unpacked `price_oracle_packed` storage (the
 *   stored EMA values; `lp_price()` does NOT apply the time-decay that the
 *   `price_oracle(k)` view applies, so the view values only match when
 *   `last_prices_timestamp == block.timestamp`)
 */
export function lpPrice(
  cachedVirtualPrice: bigint,
  storedPriceOracles: readonly [bigint, bigint]
): bigint {
  return div(
    mul(mul(3n, cachedVirtualPrice), cbrt(mul(storedPriceOracles[0], storedPriceOracles[1]))),
    10n ** 24n
  );
}
