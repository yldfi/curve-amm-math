# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0](https://github.com/yldfi/curve-amm-math/compare/v1.4.0...v1.5.0) (2026-10-06)


### Features

* add calcExchangeExact; verify NG and crypto metapool zap txs ([d89104a](https://github.com/yldfi/curve-amm-math/commit/d89104a711349f0547d733932db33864825949d8))
* add exact crypto-metapool zap math ([5f6cc38](https://github.com/yldfi/curve-amm-math/commit/5f6cc38ca5fb30bcd309e27e68b657c3c6e4d2dd))
* add exact liquidity math for Twocrypto pools on StableswapMath ([1a9ae44](https://github.com/yldfi/curve-amm-math/commit/1a9ae44b765a100d9a7f3486f7c1634ff332b327))
* add exact metapool math and get_dy for every StableSwap family ([2c07949](https://github.com/yldfi/curve-amm-math/commit/2c07949a409552431114527e200197d83c74a69e))
* cover lending, aave and rate-token StableSwap pools ([4e4ccbc](https://github.com/yldfi/curve-amm-math/commit/4e4ccbc7b60d115eb620109c2d34d80f2237befc))
* fail closed on unknown Twocrypto fee POLICY contracts ([4627ac0](https://github.com/yldfi/curve-amm-math/commit/4627ac0faac4dfe4ca71c41c0f5b121447db5aea))
* port the old lending-pool deposit zaps; verify pools at active blocks ([14654bd](https://github.com/yldfi/curve-amm-math/commit/14654bd69686aa09d253df147b6237df2a0afeb0))
* support Tricrypto-NG v2.0.1 and Twocrypto-NG v2.0.0 pools ([307576b](https://github.com/yldfi/curve-amm-math/commit/307576ba02b3c30af996f237cd5f46a2e660bfaa))


### Bug Fixes

* drop the unused optional viem peer dependency ([e809adb](https://github.com/yldfi/curve-amm-math/commit/e809adb7b5948fbff528057104479a8ab59f56c8))
* verify ramp paths on-chain; NG calc_token_amount uses A() * 100 ([3f47220](https://github.com/yldfi/curve-amm-math/commit/3f47220334871841719840dfd32daed64539b7f5))

## [1.4.0](https://github.com/yldfi/curve-amm-math/compare/v1.3.0...v1.4.0) (2026-10-06)


### Features

* add exact StableSwap liquidity math (legacy, plain, NG) ([78cf484](https://github.com/yldfi/curve-amm-math/commit/78cf484636e3a555fed7c682aa13a1a7e0986fa8))
* add exact Tricrypto-NG and Twocrypto-NG math ([042996a](https://github.com/yldfi/curve-amm-math/commit/042996a38e96bd1c8381c99c59a83f883f32cc1e))
* add fee-free marginal rates and pool-spot LP value ([d6907ed](https://github.com/yldfi/curve-amm-math/commit/d6907ed51d43aea15a40ee2fc55e646531bebe26))


### Bug Fixes

* port classic CryptoSwap newton_D and liquidity math exactly ([9b0b90f](https://github.com/yldfi/curve-amm-math/commit/9b0b90fc3a1de664aa83f400ddc394a64be631bd)), closes [#8](https://github.com/yldfi/curve-amm-math/issues/8)

## [1.3.0](https://github.com/yldfi/curve-amm-math/compare/v1.2.0...v1.3.0) (2026-06-21)


### Features

* add llamalend and tricrv math ([240c01a](https://github.com/yldfi/curve-amm-math/commit/240c01ac7624aa54c47b88f1efc56358b81b61fe))

## [1.2.0](https://github.com/yldfi/curve-amm-math/compare/v1.1.0...v1.2.0) (2026-06-04)


### Features

* add twocrypto stableswap view quotes ([05a01f0](https://github.com/yldfi/curve-amm-math/commit/05a01f03e0a77135b691527902654d587722516d))

## [1.1.0](https://github.com/yldfi/curve-amm-math/compare/v1.0.0...v1.1.0) (2026-06-02)


### Features

* add yieldbasis virtual pool math ([64807be](https://github.com/yldfi/curve-amm-math/commit/64807be70bc23cc0e49c92bf76913717b82918fb))
* publish under [@yldfi](https://github.com/yldfi) org with trusted publishing ([c716901](https://github.com/yldfi/curve-amm-math/commit/c716901dd7052446a566a47315ebe959558fc45f))


### Bug Fixes

* use npm provenance for OIDC-based publishing ([e776aac](https://github.com/yldfi/curve-amm-math/commit/e776aac0d128b33edaecbc55c7f1cdd6d1047db3))

## 1.0.0 (2026-01-09)


### Features

* enhance RPC module with batch operations and validation ([ca982b1](https://github.com/michaeldim/curve-amm-math/commit/ca982b14039f20208c9b23a8de62ca5c70143be2))
* harden math functions for production use ([1b07458](https://github.com/michaeldim/curve-amm-math/commit/1b07458ca7a337efafbb31cc1aad503f898ecb4d))
* refactor for DRY, add tests, CI/CD and code quality tools ([6a003d8](https://github.com/michaeldim/curve-amm-math/commit/6a003d87123cc8a2e2aba002a4cf0eafca4a547b))


### Bug Fixes

* adjust coverage thresholds to match actual coverage ([f636b9c](https://github.com/michaeldim/curve-amm-math/commit/f636b9cda1113952990d68eb2bb7e76ed0a3bedc))

## [0.1.0] - 2026-01-08

### Added

- **StableSwap module** (`stableswap`)
  - `getD` - Calculate D invariant using Newton's method
  - `getY` - Calculate y given x values and D
  - `getDy` - Calculate expected output for a swap
  - `getDx` - Calculate required input for desired output
  - `calcTokenAmount` - Calculate LP tokens for deposit/withdrawal
  - `calcWithdrawOneCoin` - Calculate single-token withdrawal
  - `quoteSwap` - Full swap quote with fees and price impact
  - Metapool support with `getDyUnderlying` and `getDxUnderlying`

- **Exact precision StableSwap module** (`stableswapExact`)
  - Matches Curve Vyper contracts within ±1 unit
  - `getDyExact` and `getDxExact` for precise calculations
  - Support for oracle tokens (wstETH, cbETH) and ERC4626 tokens

- **CryptoSwap module** (`cryptoswap`)
  - 2-coin support (Twocrypto-NG)
  - 3-coin support (Tricrypto-NG)
  - Dynamic fee calculations
  - Price impact and slippage helpers
  - `validateParams` for parameter range validation

- **RPC utilities** (`curve-amm-math/rpc`)
  - `getStableSwapParams` - Fetch pool parameters via RPC
  - `getCryptoSwapParams` - Fetch CryptoSwap parameters
  - Helper functions for building calldata

- **Comprehensive documentation**
  - Module selection guide
  - Error handling behavior tables
  - Input limits for all pool types
  - Thread safety guarantees

- **Test suite**
  - 414 unit tests
  - Property-based fuzz testing with fast-check
  - Edge case coverage (extreme imbalances, tiny/huge amounts)

### Security

- Division-by-zero guards in all core math functions
- Newton's method convergence protection (MAX_ITERATIONS = 255)
- Input validation for slippage, indices, and pool parameters
- Comprehensive parameter range validation
