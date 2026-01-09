# curve-amm-math

Off-chain TypeScript implementations of Curve AMM math for gas-free calculations.

[![npm version](https://badge.fury.io/js/curve-amm-math.svg)](https://www.npmjs.com/package/curve-amm-math)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **StableSwap math** - For pegged asset pools (stablecoins, liquid staking tokens)
- **Exact precision mode** - Match on-chain results within ±1 wei for all StableSwap pool types
- **CryptoSwap math** - For volatile asset pairs (Twocrypto-NG, Tricrypto-NG)
- **Zero dependencies** - Pure TypeScript with native BigInt
- **Browser compatible** - Works in Node.js and browsers (ES2020+)
- **Optional RPC utilities** - Fetch pool parameters via JSON-RPC
- **Generalized for N coins** - Works with 2-8 coin StableSwap, 2-3 coin CryptoSwap
- **All asset types** - Supports oracle tokens (wstETH), ERC4626 (sDAI), rebasing tokens (stETH)

## Installation

```bash
npm install curve-amm-math
# or
pnpm add curve-amm-math
# or
yarn add curve-amm-math
```

For RPC utilities:
```bash
npm install curve-amm-math viem
```

## Usage

### StableSwap (pegged assets)

```typescript
import { stableswap } from 'curve-amm-math';

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
import { cryptoswap } from 'curve-amm-math';

// 2-coin pool (Twocrypto-NG)
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

// 3-coin pool (Tricrypto-NG)
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
import { stableswapExact } from 'curve-amm-math';

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
import { stableswapExact } from 'curve-amm-math';
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
import { stableswap, cryptoswap } from 'curve-amm-math';
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

| Function | Description |
|----------|-------------|
| `newtonY(A, gamma, x, D, i)` | Newton's method for CryptoSwap |
| `getDy(params, i, j, dx)` | Swap output after fees |
| `getDx(params, i, j, dy)` | Input needed for desired output |
| `dynamicFee(xp, feeGamma, midFee, outFee)` | K-based dynamic fee |
| `calcTokenAmount(params, amounts, totalSupply)` | LP tokens for deposit |
| `calcWithdrawOneCoin(params, lpAmount, i, totalSupply)` | Single-coin withdrawal |

### CryptoSwap - 3-coin Functions

| Function | Description |
|----------|-------------|
| `newtonY3(A, gamma, x, D, i)` | Newton's method for 3-coin |
| `getDy3(params, i, j, dx)` | 3-coin swap output |
| `getDx3(params, i, j, dy)` | 3-coin input calculation |
| `calcTokenAmount3(params, amounts, totalSupply)` | 3-coin LP calculation |
| `calcWithdrawOneCoin3(params, lpAmount, i, totalSupply)` | 3-coin single-coin withdrawal |

### CryptoSwap - Price Functions

| Function | Description |
|----------|-------------|
| `getVirtualPrice(params, totalSupply)` / `getVirtualPrice3(...)` | Virtual price of LP token |
| `lpPrice(params, totalSupply)` / `lpPrice3(...)` | LP token price in token 0 |
| `getSpotPrice(params, i, j)` / `getSpotPrice3(...)` | Instantaneous price |
| `getEffectivePrice(params, i, j, dx)` / `getEffectivePrice3(...)` | Actual price |
| `getPriceImpact(params, i, j, dx)` / `getPriceImpact3(...)` | Price impact (bps) |
| `findPegPoint(params, i, j)` | Max amount with >= 1:1 rate |
| `getAGammaAtTime(...)` | A/gamma during ramping |

### RPC Utilities

| Function | Description |
|----------|-------------|
| `getStableSwapParams(rpcUrl, pool, nCoins?, options?)` | Fetch StableSwap pool params |
| `getExactStableSwapParams(rpcUrl, pool)` | Fetch exact precision params with stored_rates() |
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
import { stableswap } from 'curve-amm-math';
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
| Twocrypto-NG | 13 | `cryptoswap` | - | 2 |
| Tricrypto-NG | 11 | `cryptoswap` | - | 3 |

## References

- [StableSwap whitepaper](https://curve.fi/files/stableswap-paper.pdf)
- [CryptoSwap whitepaper](https://curve.fi/files/crypto-pools-paper.pdf)
- [RareSkills: Curve get_d get_y](https://www.rareskills.io/post/curve-get-d-get-y)
- [Curve Meta Registry](https://etherscan.io/address/0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC)

## License

MIT
