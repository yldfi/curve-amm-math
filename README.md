# curve-amm-math

Off-chain TypeScript implementations of Curve AMM math for gas-free calculations.

[![npm version](https://badge.fury.io/js/curve-amm-math.svg)](https://www.npmjs.com/package/curve-amm-math)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **StableSwap math** - For pegged asset pools (stablecoins, liquid staking tokens)
- **CryptoSwap math** - For volatile asset pairs (Twocrypto-NG, Tricrypto-NG)
- **Zero dependencies** - Pure TypeScript with native BigInt
- **Optional RPC utilities** - Fetch pool parameters via JSON-RPC
- **Generalized for N coins** - Works with 2-8 coin pools

## Installation

```bash
npm install curve-amm-math
# or
pnpm add curve-amm-math
# or
yarn add curve-amm-math
```

## Usage

### StableSwap (pegged assets)

```typescript
import { stableswap } from 'curve-amm-math';

// Pool balances (in 18-decimal wei)
const balances = [1000n * 10n**18n, 1100n * 10n**18n];

// Compute Ann from A parameter (A=100, 2 coins)
const Ann = stableswap.computeAnn(100n, 2);

// Pool fees
const baseFee = 4000000n;          // 0.04%
const feeMultiplier = 2n * 10n**10n; // 2x off-peg multiplier

// Calculate swap output
const dx = 10n * 10n**18n; // Input: 10 tokens
const dy = stableswap.getDy(0, 1, dx, balances, Ann, baseFee, feeMultiplier);

console.log(`Swap 10 tokens: get ${dy / 10n**18n} tokens out`);
```

### CryptoSwap (volatile assets)

```typescript
import { cryptoswap } from 'curve-amm-math';

const params: cryptoswap.CryptoSwapParams = {
  A: 400000n,
  gamma: 145000000000000n,
  D: 2000000000000000000000n,
  midFee: 3000000n,
  outFee: 30000000n,
  feeGamma: 230000000000000n,
  priceScales: [1000000000000000000n], // 1:1 price scale
  balances: [1000n * 10n**18n, 1000n * 10n**18n],
  precisions: [1n, 1n], // Both tokens have 18 decimals
};

const dx = 10n * 10n**18n;
const dy = cryptoswap.getDy(params, 0, 1, dx);

console.log(`Swap 10 tokens: get ${dy / 10n**18n} tokens out`);
```

### RPC Utilities (optional)

Fetch pool parameters from on-chain:

```typescript
import { stableswap } from 'curve-amm-math';
import { getStableSwapParams, getCryptoSwapParams } from 'curve-amm-math/rpc';

const rpcUrl = 'https://eth.llamarpc.com';
const poolAddress = '0xc50e...'; // Your pool address

// Fetch StableSwap params
const params = await getStableSwapParams(rpcUrl, poolAddress);

// Use with math functions
const dy = stableswap.getDy(
  0, 1, 10n * 10n**18n,
  params.balances,
  params.Ann,
  params.fee,
  params.offpegFeeMultiplier
);
```

## API Reference

### StableSwap

| Function | Description |
|----------|-------------|
| `getD(xp, Ann)` | Calculate invariant D using Newton's method |
| `getY(i, j, x, xp, Ann, D)` | Calculate y given x and D |
| `getDy(i, j, dx, xp, Ann, baseFee, feeMultiplier)` | Calculate swap output after fees |
| `dynamicFee(xpi, xpj, baseFee, feeMultiplier)` | Calculate dynamic fee based on balance |
| `findPegPoint(i, j, xp, Ann, fee, feeMultiplier)` | Find max amount with >= 1:1 rate |
| `calculateMinDy(expectedOutput, slippageBps)` | Calculate min_dy with slippage |
| `computeAnn(A, nCoins, isAPrecise?)` | Convert A to Ann |

### CryptoSwap

| Function | Description |
|----------|-------------|
| `newtonY(A, gamma, x, D, i)` | Newton's method for CryptoSwap |
| `getDy(params, i, j, dx)` | Calculate swap output after fees |
| `dynamicFee(xp, feeGamma, midFee, outFee)` | Calculate K-based dynamic fee |
| `findPegPoint(params, i, j, precision?)` | Find max amount with >= 1:1 rate |
| `scaleBalances(balances, precisions, priceScales)` | Scale to internal units |

### RPC Utilities

| Function | Description |
|----------|-------------|
| `getStableSwapParams(rpcUrl, pool, nCoins?)` | Fetch StableSwap pool params |
| `getCryptoSwapParams(rpcUrl, pool, nCoins?, precisions?)` | Fetch CryptoSwap pool params |
| `getOnChainDy(rpcUrl, pool, i, j, dx, factory?)` | Get on-chain get_dy for verification |
| `batchRpcCalls(rpcUrl, calls)` | Execute batched eth_call requests |

## Pool Type Reference

| Pool Type | Factory | Math Module |
|-----------|---------|-------------|
| StableSwap (legacy) | v1 Registry | `stableswap` |
| StableSwapNG | Factory ID 12 | `stableswap` |
| Twocrypto-NG | Factory ID 13 | `cryptoswap` |
| Tricrypto-NG | Factory ID 11 | `cryptoswap` |

## References

- [StableSwap whitepaper](https://curve.fi/files/stableswap-paper.pdf)
- [CryptoSwap whitepaper](https://curve.fi/files/crypto-pools-paper.pdf)
- [RareSkills: Curve get_d get_y](https://www.rareskills.io/post/curve-get-d-get-y)
- [Curve Meta Registry](https://etherscan.io/address/0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC)

## License

MIT
