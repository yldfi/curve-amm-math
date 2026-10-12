// curve-amm-math: core StableSwap and CryptoSwap math, published vs local build.
import { runMathCompat } from "./math-runner.mjs";

const E18 = 10n ** 18n;
await runMathCompat((r, n, run) => {
  const N = n % 3 === 0 ? 3 : 2;
  const xp = Array.from({ length: N }, () => (r(1n, 10n ** 7n) * E18) / r(1n, 1000n));
  const Ann = r(1n, 5000n) * 100n * BigInt(N);
  const dx = xp[0] / r(1n, 10000n) + 1n;
  const fee = r(1n, 4n) * 10n ** 6n;
  const supply = xp.reduce((a, b) => a + b, 0n);
  const amounts = xp.map((x) => x / r(1n, 1000n));
  const A = r(1n, 400000n) * 10000n;
  const gamma = r(10n ** 10n, 2n * 10n ** 16n);
  const x2 = [xp[0], xp[1]];
  return (m) => ({
    getD: run(() => m.stableswap.getD(xp, Ann)),
    getY: run(() => m.stableswap.getY(0, 1, xp[0] + dx, xp, Ann, m.stableswap.getD(xp, Ann))),
    getDy: run(() => m.stableswap.getDy(0, 1, dx, xp, Ann, fee, 2n * 10n ** 10n)),
    getDx: run(() => m.stableswap.getDx(0, 1, dx, xp, Ann, fee, 2n * 10n ** 10n)),
    calcTokenAmount: run(() => m.stableswap.calcTokenAmount(amounts, true, xp, Ann, supply, fee)),
    calcWithdrawOneCoin: run(() => m.stableswap.calcWithdrawOneCoin(supply / 100n, 1, xp, Ann, supply, fee)),
    getVirtualPrice: run(() => m.stableswap.getVirtualPrice(xp, Ann, supply)),
    newtonD: run(() => m.cryptoswap.newtonD(A, gamma, x2)),
    newtonY: run(() => m.cryptoswap.newtonY(A, gamma, x2, m.cryptoswap.newtonD(A, gamma, x2), 1)),
  });
});
