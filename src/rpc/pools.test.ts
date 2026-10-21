/**
 * rpc.detectPool / rpc.readPoolState replayed offline from recorded JSON-RPC
 * traffic (scripts/parity/record.mjs): one pool per detector branch, checked
 * against the pools' own get_virtual_price and get_dy at the recorded block.
 * Re-record after changing which calls the detector or readers make.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as pools from "../pools";
import * as twocryptoStableswap from "../twocrypto-stableswap";
import { detectPool, readPoolState } from "./index";
import recorded from "../__fixtures__/rpc-pools-recorded.json";

interface RecordedCase {
  name: string;
  pool: string;
  lpToken?: string;
  descriptor: { family: string; [k: string]: unknown };
  /** null where the pool's own view reverts */
  get_virtual_price?: string | null;
  get_dy?: { i: number; j: number; dx: string; result: string | null };
  calc_token_amount?: { amounts: string[]; isDeposit: boolean; result: string }[];
}

const responses = recorded.responses as Record<string, { result?: unknown; error?: unknown }>;
const RPC = "http://replay.invalid";

function replay(_url: string, init: { body: string }) {
  const body = JSON.parse(init.body);
  const answer = (r: { id: number; method: string; params: unknown[] }) => {
    const hit = responses[JSON.stringify([r.method, r.params])];
    if (!hit) throw new Error(`not recorded: ${r.method} ${JSON.stringify(r.params)} (re-run scripts/parity/record.mjs)`);
    return { jsonrpc: "2.0", id: r.id, ...hit };
  };
  const json = Array.isArray(body) ? body.map(answer) : answer(body);
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) });
}

const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = vi.fn().mockImplementation(replay);
});
afterAll(() => {
  global.fetch = originalFetch;
});

describe("rpc.detectPool / readPoolState (recorded at Ethereum block " + recorded.block + ")", () => {
  for (const c of recorded.cases as RecordedCase[]) {
    it(c.name, async () => {
      const opts = { blockTag: recorded.block, lpToken: c.lpToken };
      const descriptor = await detectPool(RPC, c.pool, opts);
      // the fixture stores bigints (ampPrecision) as strings
      expect(JSON.parse(JSON.stringify(descriptor, (_, v) => (typeof v === "bigint" ? v.toString() : v)))).toEqual(
        c.descriptor
      );
      if (descriptor.family === "unsupported") {
        await expect(readPoolState(RPC, c.pool, opts)).rejects.toThrow("not supported");
        return;
      }
      const state = await readPoolState(RPC, c.pool, opts);
      expect(state.family).toBe(descriptor.family);
      if (c.get_virtual_price === null) expect(() => pools.getVirtualPrice(state)).toThrow();
      else expect(pools.getVirtualPrice(state)).toBe(BigInt(c.get_virtual_price!));
      for (const { amounts, isDeposit, result } of c.calc_token_amount ?? []) {
        expect(pools.calcTokenAmount(state, amounts.map(BigInt), isDeposit)).toBe(BigInt(result));
      }
      const { i, j, dx, result } = c.get_dy!;
      if (result === null) {
        expect(() => pools.getDy(state, i, j, BigInt(dx))).toThrow();
        return;
      }
      const policy = state.family === "twocryptoStableswap" ? state.params.policy : undefined;
      if (policy && !twocryptoStableswap.ZERO_FEE_POLICIES.includes(policy)) {
        // a dynamic POLICY needs the caller's policyFee
        expect(() => pools.getDy(state, i, j, BigInt(dx))).toThrow("unknown fee POLICY");
        return;
      }
      expect(pools.getDy(state, i, j, BigInt(dx))).toBe(BigInt(result));
    });
  }

  it("pools.* throws for views the pool does not have", async () => {
    const read = (name: string) => {
      const c = (recorded.cases as RecordedCase[]).find((x) => x.name.startsWith(name))!;
      return readPoolState(RPC, c.pool, { blockTag: recorded.block, lpToken: c.lpToken });
    };
    const compound = await read("compound");
    expect(() => pools.calcWithdrawOneCoin(compound, 10n ** 18n, 0)).toThrow("lendingZap");
    const euroc = await read("EUROC");
    expect(() => pools.calcTokenAmount(euroc, [10n ** 6n, 0n], false)).toThrow("deposits only");
    const tricrypto2 = await read("tricrypto2");
    expect(() => pools.calcTokenAmount(tricrypto2, [1n, 1n], true)).toThrow("expected 3 amounts");
    expect(() => pools.getDyUnderlying(tricrypto2, 0, 1, 1n)).toThrow("not a stableswap metapool");
    const usdv = await read("USDV");
    expect(pools.nCoins(usdv)).toBe(2);
    expect(pools.getDyUnderlying(usdv, 1, 0, 10n ** 18n)).toBeGreaterThan(0n);
  });

  it("covers each family", () => {
    const families = new Set((recorded.cases as RecordedCase[]).map((c) => c.descriptor.family));
    for (const f of ["stableswap", "cryptoswap", "tricryptoLegacy", "tricryptoNg", "twocryptoOptimized", "twocryptoStableswap", "unsupported"]) {
      expect(families).toContain(f);
    }
  });
});
