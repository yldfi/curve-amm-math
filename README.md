<p align="center">
  <img src="logo-128.png" alt="yldfi" width="128" height="128">
</p>

<h1 align="center">@yldfi/curve-amm-math</h1>

<p align="center">
  Off-chain TypeScript implementations of Curve AMM math for local quote calculations
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@yldfi/curve-amm-math"><img src="https://badge.fury.io/js/@yldfi%2Fcurve-amm-math.svg" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

## Features

- **StableSwap math** - For pegged asset pools (stablecoins, liquid staking tokens)
- **Exact precision mode** - Match on-chain results within ±1 wei for all StableSwap pool types
- **CryptoSwap math** - Exact (to the wei) quotes for classic CryptoSwap pools (CurveCryptoSwap2, tricrypto2), Tricrypto-NG and Twocrypto-NG (both math variants)
- **Exact liquidity math** - add / remove liquidity for legacy, plain and NG StableSwap pools and all CryptoSwap families
- **Spot math** - Fee-free marginal rates and LP pool-spot value (an upper bound for single-coin withdrawals)
- **YieldBasis virtual pool math** - For YieldBasis stablecoin <-> asset virtual pool quotes
- **LlamaLend LLAMMA math** - For Curve LlamaLend borrowed token <-> collateral AMM quotes
- **triCRV helpers** - Classic 3pool exact StableSwap helpers (DAI/USDC/USDT)
- **Zero dependencies** - Pure TypeScript with native BigInt
- **Browser compatible** - Works in Node.js and browsers (ES2020+)
- **Optional RPC utilities** - Fetch pool parameters via JSON-RPC
- **Generalized for N coins** - Works with 2-8 coin StableSwap, 2-3 coin CryptoSwap
- **All asset types** - Supports oracle tokens (wstETH), ERC4626 (sDAI), rebasing tokens (stETH)

## Installation

```bash
npm install @yldfi/curve-amm-math
# or
pnpm add @yldfi/curve-amm-math
# or
yarn add @yldfi/curve-amm-math
```

The library has no runtime dependencies. The optional `@yldfi/curve-amm-math/rpc`
helpers use plain JSON-RPC over `fetch` (Node.js 18+ or any browser); they do
not need viem or ethers.

## Usage

### StableSwap (pegged assets)

```typescript
import { stableswap } from '@yldfi/curve-amm-math';

// Pool parameters
const balances = [1000n * 10n**18n, 1100n * 10n**18n];
const Ann = stableswap.computeAnn(100n, 2);  // A=100, 2 coins
const baseFee = 4000000n;                     // 0.04%
const feeMultiplier = 2n * 10n**10n;          // 2x off-peg multiplier
const totalSupply = 2100n * 10n**18n;         // LP token supply

// Swap quotes
const dy = stableswap.getDy(0, 1, 10n * 10n**18n, balances, Ann, baseFee, feeMultiplier);
const dx = stableswap.getDx(0, 1, 10n * 10n**18n, balances, Ann, baseFee, feeMultiplier);

// Price analysis
const spotPrice = stableswap.getSpotPrice(0, 1, balances, Ann);
const effectivePrice = stableswap.getEffectivePrice(0, 1, 10n * 10n**18n, balances, Ann, baseFee, feeMultiplier);
const priceImpact = stableswap.getPriceImpact(0, 1, 10n * 10n**18n, balances, Ann, baseFee, feeMultiplier);

// Liquidity operations
const lpTokens = stableswap.calcTokenAmount([5n * 10n**18n, 5n * 10n**18n], true, balances, Ann, totalSupply, baseFee);
const [withdrawn, fee] = stableswap.calcWithdrawOneCoin(lpTokens, 0, balances, Ann, totalSupply, baseFee);
const proportional = stableswap.calcRemoveLiquidity(lpTokens, balances, totalSupply);

// Pool metrics
const virtualPrice = stableswap.getVirtualPrice(balances, Ann, totalSupply);
```

### CryptoSwap (volatile assets)

```typescript
import { cryptoswap } from '@yldfi/curve-amm-math';

// 2-coin pool (CurveCryptoSwap2, e.g. cvxCRV/crvFRAX)
const params: cryptoswap.TwocryptoParams = {
  A: 400000n,
  gamma: 145000000000000n,
  D: 2000000000000000000000n,
  midFee: 3000000n,
  outFee: 30000000n,
  feeGamma: 230000000000000n,
  priceScale: 1000000000000000000n,
  balances: [1000n * 10n**18n, 1000n * 10n**18n],
  precisions: [1n, 1n],
};

const dy = cryptoswap.getDy(params, 0, 1, 10n * 10n**18n);
const lpPrice = cryptoswap.lpPrice(params, totalSupply);

// Liquidity: same results as the pool's views / state-changing calls
const lpOut = cryptoswap.calcTokenAmount(params, [0n, 10n * 10n**18n], totalSupply);
const minted = cryptoswap.calcAddLiquidity(params, [0n, 10n * 10n**18n], totalSupply).lpMinted;
const coinOut = cryptoswap.calcWithdrawOneCoin(params, lpOut, 0, totalSupply);

// 3-coin pool (tricrypto2)
const params3: cryptoswap.TricryptoParams = {
  A: 2700n,
  gamma: 1300000000000n,
  D: 30000000n * 10n**18n,
  midFee: 1000000n,
  outFee: 45000000n,
  feeGamma: 5000000000000000n,
  priceScales: [30000n * 10n**18n, 2000n * 10n**18n], // ETH, BTC prices in USD
  balances: [1000n * 10n**18n, 33n * 10n**18n, 500n * 10n**18n],
  precisions: [1n, 1n, 1n],
};

const dy3 = cryptoswap.getDy3(params3, 0, 1, 10n * 10n**18n);
const lpPrice3 = cryptoswap.lpPrice3(params3, totalSupply);
```

### YieldBasis Virtual Pools

```typescript
import { yieldbasis } from '@yldfi/curve-amm-math';

const params: yieldbasis.YieldBasisVirtualPoolParams = {
  ammState: {
    collateral: 5000n * 10n**18n,      // LP collateral in the YieldBasis AMM
    debt: 500000n * 10n**18n,          // Current stablecoin debt
    x0: 1100000n * 10n**18n,           // AMM get_state().x0
  },
  poolBalances: [1000000n * 10n**18n, 500n * 10n**18n], // [stablecoin, asset]
  poolTotalSupply: 10000n * 10n**18n,
  ammFee: 10n**15n,                    // 0.1% in 1e18 precision
};

// Coin 0 is the stablecoin, coin 1 is the crypto asset
const assetOut = yieldbasis.getDy(params, 0, 1, 10000n * 10n**18n);
const stableOut = yieldbasis.getDy(params, 1, 0, 5n * 10n**18n);
const stableIn = yieldbasis.getDx(params, 0, 1, assetOut);
```

With RPC utilities:

```typescript
import { yieldbasis } from '@yldfi/curve-amm-math';
import { getYieldBasisVirtualPoolParams } from '@yldfi/curve-amm-math/rpc';

const params = await getYieldBasisVirtualPoolParams(rpcUrl, virtualPoolAddress);
const dy = yieldbasis.getDy(params, 0, 1, 10000n * 10n**18n);
```

### LlamaLend LLAMMA

```typescript
import { llamalend } from '@yldfi/curve-amm-math';
import { getBlockNumber, getLlamaLendAmmParams } from '@yldfi/curve-amm-math/rpc';

const blockTag = await getBlockNumber(rpcUrl);
const params = await getLlamaLendAmmParams(rpcUrl, ammAddress, {
  // Pin mutable LLAMMA state for exact on-chain comparisons.
  blockTag,
  // Optional: widen this if min_band..max_band has more than 256 bands.
  maxBandFetch: 512,
});

// Coin 0 is the borrowed token, usually crvUSD. Coin 1 is collateral.
const collateralOut = llamalend.getDy(params, 0, 1, 1000n * 10n**18n);
const borrowedOut = llamalend.getDy(params, 1, 0, 1n * 10n**18n);
const borrowedIn = llamalend.getDx(params, 0, 1, collateralOut);
const fullQuote = llamalend.quote(params, 0, 1, 1000n * 10n**18n);
```

### triCRV / Classic 3pool

`triCRV` is the LP token for Curve's classic 3pool (`DAI/USDC/USDT`). It is
StableSwap math, not Tricrypto-NG.

```typescript
import { tricrv } from '@yldfi/curve-amm-math';
import { getTriCrvParams } from '@yldfi/curve-amm-math/rpc';

const params = await getTriCrvParams(rpcUrl);

// Native decimals: DAI has 18, USDC and USDT have 6.
const usdcOut = tricrv.getDy(params, 0, 1, 1000n * 10n**18n);
const daiIn = tricrv.getDx(params, 0, 1, 100n * 10n**6n);
```

### Exact Precision Mode (stableswapExact)

For applications requiring exact on-chain matching (±1 wei), use the exact precision module.
This replicates Vyper's exact operation order and handles all asset types correctly.

**stableswap vs stableswapExact:**

| Aspect | `stableswap` | `stableswapExact` |
|--------|--------------|-------------------|
| **Precision** | ~0.01% tolerance | ±1 wei exact |
| **Balances** | Normalized to 18 decimals | Native token decimals |
| **Rates** | Computed internally | Must provide explicitly |
| **Use case** | UI quotes, simulations | Aggregators, MEV, exact matching |
| **Complexity** | Simple | Requires rate handling |

**When to use exact precision:**
- Building aggregators or MEV bots where precision matters
- Pools with oracle tokens (wstETH, cbETH) or ERC4626 tokens (sDAI)
- When standard stableswap gives ~0.01% difference and you need exact

```typescript
import { stableswapExact } from '@yldfi/curve-amm-math';

// For standard ERC20 tokens, compute rates from decimals
// rates = 10^(36 - decimals) for each token
const decimals = [18, 6, 6];  // DAI, USDC, USDT
const rates = stableswapExact.computeRates(decimals);

const params: stableswapExact.ExactPoolParams = {
  balances: [1000000n * 10n**18n, 1000000n * 10n**6n, 1000000n * 10n**6n],  // Native decimals
  rates,                              // Rate multipliers (10^36 / 10^decimals)
  A: 2000n,                           // Raw A from contract (NOT multiplied by A_PRECISION)
  fee: 1000000n,                      // 0.01% in 1e10 precision
  offpegFeeMultiplier: 20000000000n,  // 2x multiplier
};

// Swap 1000 DAI -> USDC (input in native decimals)
const dy = stableswapExact.getDyExact(0, 1, 1000n * 10n**18n, params);
// Returns USDC amount in native 6 decimals

// Reverse: how much DAI needed for 1000 USDC out?
const dx = stableswapExact.getDxExact(0, 1, 1000n * 10n**6n, params);
```

**For pools with oracle/ERC4626 tokens**, fetch rates from the contract:

```typescript
import { stableswapExact } from '@yldfi/curve-amm-math';
import { getExactStableSwapParams } from 'curve-amm-math/rpc';

// Fetch params including dynamic rates from stored_rates()
const params = await getExactStableSwapParams(rpcUrl, poolAddress);

// Use directly with exact precision functions
const dy = stableswapExact.getDyExact(0, 1, dx, {
  balances: params.balances,
  rates: params.rates,  // Includes oracle adjustments
  A: params.A,
  fee: params.fee,
  offpegFeeMultiplier: params.offpegFeeMultiplier,
});
```

### RPC Utilities (optional)

```typescript
import { stableswap, cryptoswap } from '@yldfi/curve-amm-math';
import { getStableSwapParams, getCryptoSwapParams, getOnChainDy } from 'curve-amm-math/rpc';

const rpcUrl = 'https://eth.llamarpc.com';
const poolAddress = '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7'; // 3pool

// Fetch pool params from chain
const params = await getStableSwapParams(rpcUrl, poolAddress, 3);

// Calculate off-chain
const dyOffChain = stableswap.getDy(0, 1, 10n * 10n**18n, params.balances, params.Ann, params.fee, params.offpegFeeMultiplier);

// Verify against on-chain (for testing)
const dyOnChain = await getOnChainDy(rpcUrl, poolAddress, 0, 1, 10n * 10n**18n);
```

## API Reference

### StableSwap - Core Functions

| Function | Description |
|----------|-------------|
| `getD(xp, Ann)` | Calculate invariant D using Newton's method |
| `getY(i, j, x, xp, Ann, D)` | Calculate y given x and D |
| `getDy(i, j, dx, xp, Ann, baseFee, feeMultiplier)` | Swap output after fees |
| `getDx(i, j, dy, xp, Ann, baseFee, feeMultiplier)` | Input needed for desired output |
| `dynamicFee(xpi, xpj, baseFee, feeMultiplier)` | Dynamic fee based on balance |
| `computeAnn(A, nCoins, isAPrecise?)` | Convert A to Ann |

### StableSwap - Liquidity Functions

| Function | Description |
|----------|-------------|
| `calcTokenAmount(amounts, isDeposit, xp, Ann, totalSupply, fee)` | LP tokens for deposit/withdraw |
| `calcWithdrawOneCoin(lpAmount, i, xp, Ann, totalSupply, fee)` | Single-coin withdrawal amount |
| `calcRemoveLiquidity(lpAmount, balances, totalSupply)` | Proportional withdrawal |
| `calcRemoveLiquidityImbalance(amounts, xp, Ann, totalSupply, fee)` | LP tokens burned for exact amounts |

### StableSwap - Price Functions

| Function | Description |
|----------|-------------|
| `getVirtualPrice(xp, Ann, totalSupply)` | Virtual price of LP token |
| `getSpotPrice(i, j, xp, Ann)` | Instantaneous price without fees |
| `getEffectivePrice(i, j, dx, xp, Ann, baseFee, feeMultiplier)` | Actual price including fees and slippage |
| `getPriceImpact(i, j, dx, xp, Ann, baseFee, feeMultiplier)` | Price impact as basis points |
| `findPegPoint(i, j, xp, Ann, fee, feeMultiplier)` | Max amount with >= 1:1 rate |

### StableSwap - Advanced Functions

| Function | Description |
|----------|-------------|
| `calcTokenFee(amounts, xp, Ann, totalSupply, fee)` | Fee charged on imbalanced deposit |
| `getFeeAtBalance(xp, baseFee, feeMultiplier, targetBalance?)` | Fee at current pool state |
| `getAAtTime(A0, A1, t0, t1, currentTime)` | A parameter during ramping |
| `getDyUnderlying(metaI, metaJ, dx, metaParams)` | Metapool underlying swap |
| `quoteSwap(i, j, dx, xp, Ann, baseFee, feeMultiplier)` | Full swap quote with breakdown |
| `getAmountOut(i, j, dx, poolParams)` | Simplified output calculation |
| `getAmountIn(i, j, dy, poolParams)` | Simplified input calculation |

### StableSwapExact - Exact Precision Functions

Use these for ±1 wei on-chain matching. All inputs/outputs use **native token decimals**.

| Function | Description |
|----------|-------------|
| `getDyExact(i, j, dx, params)` | Exact swap output (native decimals) |
| `getDxExact(i, j, dy, params)` | Exact input needed (native decimals) |
| `getD(xp, amp, nCoins)` | Invariant D (Vyper-exact) |
| `getY(i, j, x, xp, amp, D, nCoins)` | Newton's method for Y (exact) |
| `getYD(amp, i, xp, D, nCoins)` | Y given D for liquidity ops |
| `dynamicFee(xpi, xpj, fee, feeMultiplier)` | Dynamic fee calculation |
| `getXp(balances, rates)` | Convert to normalized balances |
| `computeRates(decimals)` | Compute rates from decimals array |
| `computePrecisions(decimals)` | Compute precision multipliers |
| `createExactParams(balances, decimals, A, fee, offpegFeeMultiplier?)` | Helper to create params |
| `createExactParamsWithRates(balances, rates, A, fee, offpegFeeMultiplier?)` | Create params with custom rates |

**ExactPoolParams Interface:**
```typescript
interface ExactPoolParams {
  balances: bigint[];    // Raw balances in native token decimals
  rates: bigint[];       // Rate multipliers: 10^(36 - decimals) or from stored_rates()
  A: bigint;             // Raw A parameter (NOT multiplied by A_PRECISION)
  fee: bigint;           // Base fee (1e10 precision, e.g., 4000000 = 0.04%)
  offpegFeeMultiplier: bigint;  // Off-peg multiplier (1e10 precision, 0 if not supported)
}
```

**Asset Type Rate Sources:**

| Asset Type | Example | Rate Source |
|------------|---------|-------------|
| Standard ERC20 | USDC, DAI | `computeRates([decimals])` → `10^(36-d)` |
| Oracle token | wstETH, cbETH | `stored_rates()` from contract |
| ERC4626 vault | sDAI | `stored_rates()` (includes convertToAssets) |
| Rebasing token | stETH | `stored_rates()` (rate static, balance changes) |

### CryptoSwap - Core Functions (2-coin)

The `cryptoswap` module ports the classic (pre-NG) contracts: CurveCryptoSwap2
for 2 coins and tricrypto2 for 3 coins. Results match the on-chain views to the
wei (fixture tests at pinned blocks). Twocrypto-NG and Tricrypto-NG pools use
different math and are not covered by this module.

`params.D` is the pool's stored `D()`. Set `futureAGammaTime` to the pool's
`future_A_gamma_time()` when it is non-zero: the contract then recomputes D
from the balances, and so does this module.

| Function | Description |
|----------|-------------|
| `newtonD(A, gamma, xp)` / `calcD(...)` | Invariant D (Vyper `newton_D`) |
| `newtonY(A, gamma, x, D, i)` | Newton's method for CryptoSwap |
| `getDy(params, i, j, dx)` | Swap output after fees (`get_dy`) |
| `getDx(params, i, j, dy)` | Input needed for desired output |
| `dynamicFee(xp, feeGamma, midFee, outFee)` | K-based dynamic fee (`fee()`) |
| `calcTokenAmount(params, amounts, totalSupply)` | `calc_token_amount` view, deposit fee included |
| `calcAddLiquidity(params, amounts, totalSupply)` | LP minted by `add_liquidity`, plus fee, D, new supply |
| `calcWithdrawOneCoin(params, lpAmount, i, totalSupply)` | `calc_withdraw_one_coin` view |
| `calcRemoveLiquidityOneCoin(params, lpAmount, i, totalSupply)` | `remove_liquidity_one_coin` (starts from stored D) |
| `calcRemoveLiquidity(params, lpAmount, totalSupply)` | Balanced `remove_liquidity` (pays on `lpAmount - 1`) |
| `calcTokenFee(amounts, xp, feeGamma, midFee, outFee)` | Imbalanced-deposit fee (`_calc_token_fee`) |
| `geometricMean(x, sort?)`, `getXcp(D, priceScale)` | Helpers used by the above |

The retired tricrypto v1 (0x80466c64…) is covered by the 3-coin functions:
its math uses A_MULTIPLIER = 100 with `A_precise()`, so pass
`A = A_precise() * 100n`, and its `calc_withdraw_one_coin` starts from the
stored D (use `calcRemoveLiquidityOneCoin3`).

`add_liquidity` and `remove_liquidity_one_coin` may also claim admin fees
(`mint_relative` to the fee receiver) and move `price_scale` in `tweak_price`.
That does not change the amount the call itself mints or pays out, but it
changes `totalSupply` and `D` for the next call.

### CryptoSwap - 3-coin Functions

| Function | Description |
|----------|-------------|
| `newtonY3(A, gamma, x, D, i)` | Newton's method for 3-coin |
| `getDy3(params, i, j, dx)` | 3-coin swap output |
| `getDx3(params, i, j, dy)` | 3-coin input calculation |
| `calcTokenAmount3(params, amounts, totalSupply, deposit?)` | `calc_token_amount(amounts, deposit)` view |
| `calcAddLiquidity3(params, amounts, totalSupply)` | LP minted by `add_liquidity` |
| `calcWithdrawOneCoin3(params, lpAmount, i, totalSupply)` | `calc_withdraw_one_coin` view |
| `calcRemoveLiquidityOneCoin3(params, lpAmount, i, totalSupply)` | `remove_liquidity_one_coin` |
| `calcRemoveLiquidity3(params, lpAmount, totalSupply)` | Balanced `remove_liquidity` |

### StableSwapExact - Liquidity Functions

Exact (to the wei) ports of each StableSwap family's liquidity functions.
`params` is `StableLiquidityParams`: `ExactPoolParams` plus `variant`,
`totalSupply`, and optionally `ampPrecision` (1 for 3pool), `ampPrecise`
(the pool's `A_precise()`, needed while A ramps) and `adminFee`.

| `variant` | Pools (Curve API registry / implementation) | `calc_token_amount` |
|-----------|-------|---------------------|
| `"legacy"` | `main` registry plain pools (3pool, ETH/stETH, FRAXBP); `factory` v1 plain pools (`plain2basic`, `plain2balances`, `plain2basicema`, `plain2optimized`, `plain3balances`) | no imbalance fee |
| `"plain"` | `factory-crvusd` pools (crvUSD/USDT, …) | static imbalance fee |
| `"ng"` | `factory-stable-ng` (`plainstableng`, `plainstableng-old`) | dynamic fee (`offpeg_fee_multiplier`) |

Use `ampPrecision: 1n` only for pools without `A_precise()` (3pool); pass
`ampPrecise` from `A_precise()` otherwise. Pass `adminFee` from `admin_fee()`
when you use the post-call `balances` (3pool's is 100%, not the 50% default).
`getDyVariant(params, i, j, dx)` is the exact `get_dy` for every variant. Lending pools (cTokens, aTokens,
yTokens) need their current rates supplied in `rates`.

| Function | Description |
|----------|-------------|
| `calcTokenAmountExact(params, amounts, isDeposit)` | `calc_token_amount` view as the contract returns it |
| `calcAddLiquidityExact(params, amounts)` | LP actually minted by `add_liquidity` (imbalance fee included), per-coin fees, new balances |
| `calcRemoveLiquidityImbalanceExact(params, amounts)` | LP burned by `remove_liquidity_imbalance` (`+ 1`) |
| `calcWithdrawOneCoinExact(params, burnAmount, i)` | `[dy, fee]` of `calc_withdraw_one_coin` |
| `calcRemoveLiquidityExact(params, burnAmount)` | Balanced `remove_liquidity` |
| `getVirtualPriceExact(params)` | `get_virtual_price()` |
| `getDVariant(xp, amp, variant, ampPrecision?)` / `getYDVariant(...)` | Invariant helpers per family |

Legacy `calc_token_amount` omits the imbalance fee that `add_liquidity`
charges; use `calcAddLiquidityExact` for the amount minted.

**Not covered:** lending pools' rate accrual (cToken/aToken pools need
current rates in `rates`).

### Tricrypto-NG and Twocrypto-NG

`tricryptoNg` ports CurveTricryptoOptimizedWETH v2.0.0 and is verified for
v2.0.1 (math `0xcBFf3004…D6eE`); `twocryptoOptimized` ports
CurveTwocryptoOptimized v2.1.0/v2.1.1 (math `0x1Fd8Af16…F4A1`) and is verified
for v2.0.0 (math `0x2005995a…64Df`). Each exposes
`assertSupportedImplementation(version, mathAddress)`; other versions must not
be quoted with them. Twocrypto pools whose MATH is StableswapMath (v2.1.0d,
v3.0.0) use `twocryptoNg`.

| Function | Description |
|----------|-------------|
| `getDy(params, i, j, dx)` / `getDx(...)` | Swap quotes |
| `calcTokenAmount(params, amounts, deposit)` | `calc_token_amount`, NG imbalance fee included |
| `calcWithdrawOneCoin(params, lpAmount, i)` | Pool `calc_withdraw_one_coin` (what `remove_liquidity_one_coin` pays) |
| `calcWithdrawOneCoinViews(params, lpAmount, i)` | The views contract's variant |
| `calcRemoveLiquidity(params, lpAmount)` | Balanced `remove_liquidity` |
| `getVirtualPrice(params)`, `lpPrice(...)`, `fee(params)` | Price and fee getters |
| `newtonD`, `getY`, `newtonY` | Math contract ports |

`params.D` is the stored `D()`; set `isRamping` when
`future_A_gamma_time > block.timestamp`. `tricryptoNg.lpPrice` takes the
*stored* (undecayed) price oracle, as `lp_price()` reads it; the
`price_oracle(k)` view only equals it when `last_prices_timestamp` is the
current block.

### Metapools

Pool-level metapool math is the `stableswapExact` liquidity API with
`rates = [10^(36 - decimals0), baseVirtualPrice]` (`"legacy"` for `main` and
`factory` v1 metapools) or `stored_rates()` (`"ng"` for stable-ng metapools).
`baseVirtualPrice` is the base pool's live `get_virtual_price()`, except old
`main` metapools while their 10-minute cache (`base_virtual_price()`,
`base_cache_updated()`) is fresh. The `metapool` module adds the paths that
go through the base pool:

| Function | Description |
|----------|-------------|
| `getDyUnderlying({ meta, base }, i, j, dx)` | `get_dy_underlying` (0 = meta coin, 1..N = base coins) |
| `calcTokenAmountUnderlying({ meta, base }, amounts, isDeposit)` | Factory zap `calc_token_amount` |
| `calcWithdrawOneCoinUnderlying({ meta, base }, lpAmount, i)` | Factory zap `calc_withdraw_one_coin` |
| `calcAddLiquidityUnderlying({ meta, base }, amounts)` | LP minted by the zap's `add_liquidity` (base mint, then meta mint at the base's post-deposit virtual price) |

Crypto metapools (`factory-crypto` `metacrypto`: a CurveCryptoSwap2 pool of
[coin, base LP]) go through the crypto-meta zaps (FRAXBP 0x5De4EF48…, 3pool
0x97aDC08F…). Pass `{ meta: TwocryptoParams, metaTotalSupply, base }`:

| Function | Description |
|----------|-------------|
| `cryptoGetDyUnderlying(params, i, j, dx)` | Zap `get_dy` (0 = crypto coin, 1..N = base coins) |
| `cryptoCalcTokenAmountUnderlying(params, amounts)` | Zap `calc_token_amount` |
| `cryptoCalcWithdrawOneCoinUnderlying(params, lpAmount, i)` | Zap `calc_withdraw_one_coin` |
| `cryptoCalcAddLiquidityUnderlying(params, amounts)` | LP minted by the zap's `add_liquidity` |
| `cryptoRemoveLiquidityOneCoinUnderlying(params, lpAmount, i)` | Coin paid by the zap's `remove_liquidity_one_coin` |

### Twocrypto on StableswapMath (YieldBasis-style pools)

`twocryptoStableswap` ports the `Twocrypto` v3.0.0 and v2.1.0d pools whose
MATH is StableswapMath (crvUSD/WBTC, crvUSD/WETH, crvUSD/cbBTC, …). Set
`params.version` from `pool.version()`; `assertSupportedImplementation`
checks version and MATH.

| Function | Description |
|----------|-------------|
| `getDy(params, i, j, dx)` | `get_dy` (v3.0.0 fee clamp included) |
| `calcTokenAmount(params, amounts, deposit)` | `calc_token_amount`, incl. the donation-protection LP spam fee |
| `calcWithdrawOneCoin(params, lpAmount, i)` | `calc_withdraw_one_coin` |
| `calcWithdrawFixedOut(params, lpAmount, i, amountI)` | `calc_withdraw_fixed_out` |
| `calcRemoveLiquidity(params, lpAmount)` | Balanced `remove_liquidity` |
| `getVirtualPrice(params)`, `lpPrice(params, priceOracle)`, `priceOracle(state)`, `fee(params)` | Price and fee getters |

Pass `donation` (the `donation_*` getters and block timestamp) for exact
deposit quotes while donation protection is active, `isRamping` when
`future_A_gamma_time > last_timestamp`. v3.0.0 pools also need `policy`
(`pool.POLICY()`): the zero address and the known `YBTwocryptoPolicy`
contracts (`ZERO_FEE_POLICIES`, whose `get_fee` is a pure `return 0`) quote
with the pool's own fee; any other policy throws unless `policyFee` models it. State-changing calls claim admin fees
first; pass the post-claim state when a claim is due. These pools use the
StableSwap invariant on price-scaled balances, so `spot.cryptoSwap*` does not
apply to them.

### Spot - Marginal Rates and LP Spot Value

Fee-free marginal rate r_{j→i} (coin i out per coin j in, raw units) from the
invariant gradient, and the pool-spot value of LP in coin i:
`UB_i = L / supply · Σ_j balance_j · r_{j→i}`, an upper bound for
`calc_withdraw_one_coin`. Results are exact rationals (`{ n, d }`); floor once
with `floorRatio`.

| Function | Description |
|----------|-------------|
| `stableSwapMarginalRate(params, j, i)` | Exact StableSwap gradient rate |
| `stableSwapLpSpotValue(params, lpAmount, i)` | Guaranteed upper bound (min over D ± 1) |
| `cryptoSwapMarginalRate(state, j, i)` | CryptoSwap gradient rate (classic and NG) |
| `cryptoSwapLpSpotValue(state, lpAmount, supply, i)` | CryptoSwap pool-spot value |
| `lpSpotValueFromRates(balances, i, rates, lpAmount, supply)` | Spot value from any rates |

### CryptoSwap - Price Functions

| Function | Description |
|----------|-------------|
| `getVirtualPrice(params, totalSupply)` / `getVirtualPrice3(...)` | `get_virtual_price()`: `1e18 * xcp(D) / totalSupply` |
| `lpPriceFromOracle(virtualPrice, priceOracle)` | 2-coin `lp_price()` |
| `lpPrice(params, totalSupply)` / `lpPrice3(...)` | Pro-rata pool value per LP in token 0 at price_scale |
| `getSpotPrice(params, i, j)` / `getSpotPrice3(...)` | Instantaneous price |
| `getEffectivePrice(params, i, j, dx)` / `getEffectivePrice3(...)` | Actual price |
| `getPriceImpact(params, i, j, dx)` / `getPriceImpact3(...)` | Price impact (bps) |
| `findPegPoint(params, i, j)` | Max amount with >= 1:1 rate |
| `getAGammaAtTime(...)` | A/gamma during ramping |

### LlamaLend - Core Functions

| Function | Description |
|----------|-------------|
| `getDy(params, i, j, dx)` | Exact-input LLAMMA output quote |
| `getDx(params, i, j, dy)` | Exact-output LLAMMA input quote |
| `quote(params, i, j, dx)` | Full exact-input quote with touched bands |
| `quoteExactOut(params, i, j, dy)` | Full exact-output quote with touched bands |
| `getDynamicFee(A, pOracle, pOracleUp)` | Band/oracle dynamic fee |
| `getY0(A, x, y, pOracle, pOracleUp)` | Per-band invariant helper |

### triCRV - Classic 3pool Helpers

| Function | Description |
|----------|-------------|
| `createTriCrvParams(balances, A, fee, offpegFeeMultiplier?)` | Create exact 3pool params |
| `getDy(params, i, j, dx)` | Exact 3pool output quote |
| `getDx(params, i, j, dy)` | Exact 3pool input quote |

### RPC Utilities

| Function | Description |
|----------|-------------|
| `getStableSwapParams(rpcUrl, pool, nCoins?, options?)` | Fetch StableSwap pool params |
| `getExactStableSwapParams(rpcUrl, pool)` | Fetch exact precision params with stored_rates() |
| `getTriCrvParams(rpcUrl, pool?)` | Fetch exact classic 3pool / triCRV params |
| `getLlamaLendAmmParams(rpcUrl, amm, options?)` | Fetch LLAMMA params and band balances |
| `getBlockNumber(rpcUrl)` | Fetch a block number for pinned exact RPC reads |
| `getCryptoSwapParams(rpcUrl, pool, precisions?)` | Fetch CryptoSwap 2-coin params |
| `getTricryptoParams(rpcUrl, pool, precisions?)` | Fetch Tricrypto 3-coin params |
| `getOnChainDy(rpcUrl, pool, i, j, dx, factory?)` | On-chain get_dy for verification |
| `getStoredRates(rpcUrl, pool)` | Fetch dynamic rates for oracle/ERC4626 tokens |
| `getNCoins(rpcUrl, pool)` | Get number of coins in pool |
| `getPoolCoins(rpcUrl, pool, nCoins?)` | Get token addresses |
| `getTokenDecimals(rpcUrl, tokens)` | Get decimals for tokens |
| `previewRedeem(rpcUrl, vault, shares)` | ERC4626 preview redeem |
| `batchRpcCalls(rpcUrl, calls)` | Batched eth_call requests |

## Testing Accuracy

The math implementations are tested against known values. For production use with financial consequences, we recommend:

1. **Verify against on-chain**: Use `getOnChainDy()` to compare your off-chain calculations
2. **Add slippage tolerance**: Always use `calculateMinDy()` with appropriate slippage (e.g., 50-100 bps)
3. **Integration tests**: Run periodic checks against mainnet pools

```typescript
import { stableswap } from '@yldfi/curve-amm-math';
import { getStableSwapParams, getOnChainDy } from 'curve-amm-math/rpc';

// Verify accuracy
const params = await getStableSwapParams(rpcUrl, pool);
const offChain = stableswap.getDy(0, 1, dx, params.balances, params.Ann, params.fee, params.offpegFeeMultiplier);
const onChain = await getOnChainDy(rpcUrl, pool, 0, 1, dx);

const diff = offChain > onChain ? offChain - onChain : onChain - offChain;
const tolerance = onChain / 10000n; // 0.01% tolerance
console.assert(diff <= tolerance, 'Off-chain calculation exceeds tolerance');
```

## Pool Type Reference

| Pool Type | Factory ID | Math Module | Exact Module | Coins |
|-----------|------------|-------------|--------------|-------|
| StableSwap (legacy) | Registry | `stableswap` | `stableswapExact` | 2-4 |
| StableSwapNG | 12 | `stableswap` | `stableswapExact` | 2-8 |
| StableSwapNG (oracle) | 12 | `stableswap` | `stableswapExact` + `stored_rates()` | 2-8 |
| triCRV / 3pool | Registry | `tricrv` / `stableswapExact` | `stableswapExact` | 3 |
| Twocrypto-NG | 13 | `cryptoswap` | - | 2 |
| Tricrypto-NG | 11 | `cryptoswap` | - | 3 |
| LlamaLend LLAMMA | Lending | `llamalend` | - | 2 |

## References

- [StableSwap whitepaper](https://curve.fi/files/stableswap-paper.pdf)
- [CryptoSwap whitepaper](https://curve.fi/files/crypto-pools-paper.pdf)
- [Curve stablecoin AMM source](https://github.com/curvefi/curve-stablecoin/blob/master/curve_stablecoin/AMM.vy)
- [RareSkills: Curve get_d get_y](https://www.rareskills.io/post/curve-get-d-get-y)
- [Curve Meta Registry](https://etherscan.io/address/0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC)

## License

MIT
