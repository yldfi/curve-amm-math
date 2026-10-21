/**
 * Caller-supplied transports (`CurveRpc`, `eip1193Rpc`): detection and state
 * reads replayed from the recorded traffic in rpc-pools-recorded.json, with
 * the same results as the RPC URL path, plus error and abort propagation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchRpcCalls,
  batchRpcRawCalls,
  detectPool,
  eip1193Rpc,
  getBlockNumber,
  getExactStableSwapParams,
  getStoredRates,
  isRevertError,
  readPoolState,
} from "./index";
import type { CurveRpc, RpcCall } from "./index";
import recorded from "../__fixtures__/rpc-pools-recorded.json";

interface RecordedCase {
  name: string;
  pool: string;
  lpToken?: string;
  descriptor: { family: string };
}

type Answer = { result?: unknown; error?: { code?: number; message?: string } };
const responses = recorded.responses as Record<string, Answer>;
const cases = recorded.cases as RecordedCase[];
const RPC = "http://replay.invalid";
const BLOCK_HEX = "0x" + BigInt(recorded.block).toString(16);

function lookup(method: string, params: unknown[]): Answer {
  const hit = responses[JSON.stringify([method, params])];
  if (!hit) throw new Error(`not recorded: ${method} ${JSON.stringify(params)}`);
  return hit;
}

/** The RPC URL path's fetch, answering from the recording */
function replayFetch(_url: string, init: { body: string }) {
  const body = JSON.parse(init.body);
  const answer = (r: { id: number; method: string; params: unknown[] }) => ({
    jsonrpc: "2.0",
    id: r.id,
    ...lookup(r.method, r.params),
  });
  const json = Array.isArray(body) ? body.map(answer) : answer(body);
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) });
}

/** A hand-written CurveRpc answering from the recording, logging what it was asked */
function recordedRpc() {
  const log = { calls: [] as { calls: RpcCall[]; blockTag: string }[], requests: [] as { method: string; params: unknown[] }[] };
  const rpc: CurveRpc = {
    async call(calls, { blockTag }) {
      log.calls.push({ calls, blockTag });
      return calls.map((c) => {
        const a = lookup("eth_call", [{ to: c.to, data: c.data }, blockTag]);
        if (a.error) {
          if (isRevertError(a.error)) return null;
          throw new Error(a.error.message);
        }
        return a.result as string;
      });
    },
    async request(method, params) {
      log.requests.push({ method, params });
      const a = lookup(method, params);
      if (a.error) throw new Error(a.error.message);
      return a.result;
    },
  };
  return { rpc, log };
}

/** A minimal EIP-1193 provider over the same URL: one fetch per request, JSON-RPC errors thrown */
const urlProvider = {
  async request({ method, params }: { method: string; params?: unknown }) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as Answer;
    if (json.error) throw Object.assign(new Error(json.error.message), json.error);
    return json.result;
  },
};

const plain = (x: unknown) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(replayFetch);
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("CurveRpc transport: detectPool / readPoolState", () => {
  for (const c of cases) {
    it(`${c.name}: same descriptor and state as the RPC URL`, async () => {
      const opts = { blockTag: recorded.block, lpToken: c.lpToken };
      const viaUrl = await detectPool(RPC, c.pool, opts);
      const stateViaUrl = viaUrl.family === "unsupported" ? undefined : await readPoolState(RPC, c.pool, opts);

      fetchMock.mockClear();
      const { rpc, log } = recordedRpc();
      const viaRpc = await detectPool(rpc, c.pool, opts);
      expect(plain(viaRpc)).toEqual(plain(viaUrl));
      expect(viaRpc.family).toBe(c.descriptor.family);
      if (viaRpc.family === "unsupported") {
        await expect(readPoolState(rpc, c.pool, opts)).rejects.toThrow("not supported");
      } else {
        expect(plain(await readPoolState(rpc, c.pool, opts))).toEqual(plain(stateViaUrl));
      }
      // the transport is the only way out, and every read is pinned to the block
      expect(fetchMock).not.toHaveBeenCalled();
      expect(log.calls.length).toBeGreaterThan(0);
      for (const { blockTag } of log.calls) expect(blockTag).toBe(BLOCK_HEX);
      for (const { method, params } of log.requests) {
        if (method === "eth_getBlockByNumber") expect(params).toEqual([BLOCK_HEX, false]);
        else expect(params[params.length - 1]).toBe(BLOCK_HEX);
      }

      const viaEip1193 = eip1193Rpc(urlProvider);
      expect(plain(await detectPool(viaEip1193, c.pool, opts))).toEqual(plain(viaUrl));
      if (stateViaUrl) {
        expect(plain(await readPoolState(viaEip1193, c.pool, opts))).toEqual(plain(stateViaUrl));
      }
    });
  }

  it("covers each family", () => {
    const families = new Set(cases.map((c) => c.descriptor.family));
    for (const f of ["stableswap", "cryptoswap", "tricryptoLegacy", "tricryptoNg", "twocryptoOptimized", "twocryptoStableswap", "unsupported"]) {
      expect(families).toContain(f);
    }
  });

  it("splits calls by batchSize", async () => {
    const { rpc, log } = recordedRpc();
    const c = cases.find((x) => x.name.startsWith("3pool"))!;
    await detectPool(rpc, c.pool, { blockTag: recorded.block, lpToken: c.lpToken, batchSize: 4 });
    expect(Math.max(...log.calls.map((x) => x.calls.length))).toBe(4);
  });

  it("a caller-pinned block skips the block lookup and reads the same state", async () => {
    const header = lookup("eth_getBlockByNumber", [BLOCK_HEX, false]).result as { number: string; timestamp: string };
    const block = { number: BigInt(header.number), timestamp: BigInt(header.timestamp) };
    for (const name of ["aave", "TriDBR"]) {
      const c = cases.find((x) => x.name.startsWith(name))!;
      const viaUrl = await readPoolState(RPC, c.pool, { blockTag: recorded.block, lpToken: c.lpToken });
      const { rpc, log } = recordedRpc();
      const state = await readPoolState(rpc, c.pool, { block, lpToken: c.lpToken });
      expect(plain(state)).toEqual(plain(viaUrl));
      expect(log.requests.map((r) => r.method)).not.toContain("eth_getBlockByNumber");
      expect(plain(await readPoolState(rpc, c.pool, { block, blockTag: recorded.block, lpToken: c.lpToken }))).toEqual(
        plain(viaUrl)
      );
    }
    const { rpc } = recordedRpc();
    const pool = cases[0].pool;
    await expect(detectPool(rpc, pool, { block, blockTag: recorded.block - 1 })).rejects.toThrow("does not match block");
    await expect(detectPool(rpc, pool, { block, blockTag: "latest" })).rejects.toThrow("does not match block");
  });

  it("reads a given descriptor without re-detecting", async () => {
    const c = cases.find((x) => x.name === "tricrypto2")!;
    const descriptor = await detectPool(RPC, c.pool, { blockTag: recorded.block });
    const { rpc, log } = recordedRpc();
    const state = await readPoolState(rpc, c.pool, { blockTag: recorded.block, descriptor });
    expect(state.family).toBe("tricryptoLegacy");
    expect(log.requests.map((r) => r.method)).toEqual(["eth_getBlockByNumber"]);
  });
});

describe("CurveRpc transport: errors", () => {
  const c = cases.find((x) => x.name.startsWith("3pool"))!;
  const opts = { blockTag: recorded.block, lpToken: c.lpToken };

  it("a transport failure rejects instead of reading as a missing view", async () => {
    const { rpc } = recordedRpc();
    const failing: CurveRpc = { ...rpc, call: async () => Promise.reject(new Error("429 rate limited")) };
    await expect(detectPool(failing, c.pool, opts)).rejects.toThrow("429 rate limited");
    await expect(readPoolState(failing, c.pool, opts)).rejects.toThrow("429 rate limited");
  });

  it("a failure on the nth batch rejects", async () => {
    const { rpc } = recordedRpc();
    let n = 0;
    const failing: CurveRpc = { ...rpc, call: (calls, o) => (++n === 3 ? Promise.reject(new Error("upstream 503")) : rpc.call(calls, o)) };
    await expect(readPoolState(failing, c.pool, opts)).rejects.toThrow("upstream 503");
  });

  it("request failures (block, code) reject", async () => {
    const { rpc } = recordedRpc();
    const noBlock: CurveRpc = { ...rpc, request: async () => Promise.reject(new Error("block fetch failed")) };
    await expect(detectPool(noBlock, c.pool, opts)).rejects.toThrow("block fetch failed");
    const noCode: CurveRpc = {
      ...rpc,
      request: (m, p, o) => (m === "eth_getCode" ? Promise.reject(new Error("pruned")) : rpc.request(m, p, o)),
    };
    await expect(detectPool(noCode, c.pool, opts)).rejects.toThrow("pruned");
    const missing: CurveRpc = { ...rpc, request: async () => null };
    await expect(detectPool(missing, c.pool, opts)).rejects.toThrow("not found");
  });

  it("a result count that does not match the calls rejects", async () => {
    const { rpc } = recordedRpc();
    const short: CurveRpc = { ...rpc, call: async (calls) => calls.slice(1).map(() => null) };
    await expect(detectPool(short, c.pool, opts)).rejects.toThrow("results for");
    await expect(batchRpcRawCalls(short, [{ to: c.pool, data: "0x" }])).rejects.toThrow("returned 0 results for 1 calls");
  });

  it("eip1193Rpc: reverts read as null, other errors reject", async () => {
    const provider = {
      request: vi.fn(async ({ params }: { method: string; params?: unknown }) => {
        const data = (params as [{ data: string }])[0].data;
        if (data === "0x01") throw Object.assign(new Error("execution reverted"), { code: 3 });
        if (data === "0x02") throw Object.assign(new Error("VM Exception while processing transaction: revert"), { code: -32000 });
        if (data === "0x03") throw Object.assign(new Error("wrapped"), { cause: { code: 3, message: "execution reverted" } });
        if (data === "0x04") return "0x";
        if (data === "0x05") throw Object.assign(new Error("rate limited"), { code: -32005 });
        if (data === "0x06") throw new Error("HTTP request failed: execution reverted"); // no JSON-RPC code
        return "0x" + "00".repeat(31) + "2a";
      }),
    };
    const rpc = eip1193Rpc(provider);
    const at = (data: string) => rpc.call([{ to: c.pool, data }], { blockTag: "0x10" });
    expect(await at("0x00")).toEqual(["0x" + "00".repeat(31) + "2a"]);
    for (const d of ["0x01", "0x02", "0x03", "0x04"]) expect(await at(d)).toEqual([null]);
    await expect(at("0x05")).rejects.toThrow("rate limited");
    await expect(at("0x06")).rejects.toThrow("HTTP request failed");
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_call", params: [{ to: c.pool, data: "0x00" }, "0x10"] });
  });

  it("batchRpcCalls: reverts are null, strict turns them into errors, transport errors reject", async () => {
    const rpc: CurveRpc = {
      call: async (calls) => calls.map((x) => (x.data === "0xdead" || x.data === "0xfd0684b1" ? null : "0x" + "00".repeat(31) + "07")),
      request: async () => "0x10",
    };
    const calls = [{ to: c.pool, data: "0x01" }, { to: c.pool, data: "0xdead" }];
    expect(await batchRpcCalls(rpc, calls)).toEqual([7n, null]);
    await expect(batchRpcCalls(rpc, calls, { strict: true })).rejects.toThrow("RPC call 1 reverted or returned empty result");
    expect(await getBlockNumber(rpc)).toBe(16n);
    await expect(getStoredRates(rpc, c.pool)).rejects.toThrow("Failed to fetch stored_rates");
    const broken: CurveRpc = { call: async () => Promise.reject(new Error("socket hang up")), request: rpc.request };
    await expect(batchRpcCalls(broken, calls)).rejects.toThrow("socket hang up");
    // a transport error is not "no stored_rates": the stored_rates fallback must not swallow it
    await expect(getExactStableSwapParams(broken, c.pool)).rejects.toThrow("socket hang up");
  });

  it("batchRpcCalls passes blockTag through", async () => {
    const seen: string[] = [];
    const rpc: CurveRpc = {
      call: async (calls, { blockTag }) => (seen.push(blockTag), calls.map(() => null)),
      request: async () => null,
    };
    await batchRpcCalls(rpc, [{ to: c.pool, data: "0x01" }], { blockTag: 26236847n });
    await batchRpcCalls(rpc, [{ to: c.pool, data: "0x01" }], { blockTag: "finalized" });
    await batchRpcCalls(rpc, [{ to: c.pool, data: "0x01" }]);
    expect(seen).toEqual([BLOCK_HEX, "finalized", "latest"]);
  });
});

describe("abort", () => {
  const c = cases.find((x) => x.name.startsWith("3pool"))!;
  const opts = { blockTag: recorded.block, lpToken: c.lpToken };

  it("an already-aborted signal rejects before any request", async () => {
    const { rpc, log } = recordedRpc();
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));
    const signal = controller.signal;
    await expect(detectPool(rpc, c.pool, { ...opts, signal })).rejects.toThrow("caller gave up");
    await expect(readPoolState(rpc, c.pool, { ...opts, signal })).rejects.toThrow("caller gave up");
    await expect(batchRpcCalls(rpc, [{ to: c.pool, data: "0x01" }], { signal })).rejects.toThrow("caller gave up");
    expect(log.calls.length + log.requests.length).toBe(0);
    await expect(detectPool(RPC, c.pool, { ...opts, signal })).rejects.toThrow("caller gave up");
    await expect(batchRpcCalls(RPC, [{ to: c.pool, data: "0x01" }], { signal })).rejects.toThrow("caller gave up");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the transport receives the signal, and an abort mid-read stops the read", async () => {
    const { rpc } = recordedRpc();
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    let n = 0;
    const aborting: CurveRpc = {
      request: (m, p, o) => (signals.push(o.signal), rpc.request(m, p, o)),
      call: async (calls, o) => {
        signals.push(o.signal);
        const out = await rpc.call(calls, o);
        if (++n === 2) controller.abort(new Error("block changed"));
        return out;
      },
    };
    await expect(readPoolState(aborting, c.pool, { ...opts, signal: controller.signal })).rejects.toThrow("block changed");
    expect(n).toBe(2);
    expect(signals.every((s) => s === controller.signal)).toBe(true);
  });

  it("the RPC URL path aborts the in-flight fetch and does not retry it", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          setTimeout(() => controller.abort(new Error("caller gave up")), 5);
        })
    );
    await expect(detectPool(RPC, c.pool, { ...opts, signal: controller.signal })).rejects.toThrow("caller gave up");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the RPC URL batch helpers abort the in-flight fetch with the signal's reason, not a timeout", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          setTimeout(() => controller.abort(new Error("caller gave up")), 5);
        })
    );
    await expect(
      batchRpcCalls(RPC, [{ to: c.pool, data: "0x01" }], { signal: controller.signal })
    ).rejects.toThrow("caller gave up");
  });

  it("eip1193Rpc rejects with the signal's reason once the request settles", async () => {
    const controller = new AbortController();
    const provider = {
      request: async () => {
        controller.abort(new Error("cancelled"));
        return "0x" + "00".repeat(32);
      },
    };
    const rpc = eip1193Rpc(provider);
    await expect(rpc.call([{ to: c.pool, data: "0x01" }], { blockTag: "latest", signal: controller.signal })).rejects.toThrow(
      "cancelled"
    );
    await expect(rpc.request("eth_blockNumber", [], { signal: controller.signal })).rejects.toThrow("cancelled");
  });
});
