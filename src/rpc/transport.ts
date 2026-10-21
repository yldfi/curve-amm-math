/**
 * Caller-supplied transports: the `CurveRpc` interface every `rpc` helper
 * accepts in place of an RPC URL, and an adapter for EIP-1193 providers.
 */

import type { RpcCall } from "./index";

/** Options a {@link CurveRpc} receives with every request */
export interface CurveRpcRequestOptions {
  /** The caller's abort signal: reject (ideally with `signal.reason`) once it fires */
  signal?: AbortSignal;
}

/** Options a {@link CurveRpc} receives with every `call` */
export interface CurveRpcCallOptions extends CurveRpcRequestOptions {
  /** Block every call in the batch reads at: a hex block number, or a tag such as "latest" */
  blockTag: string;
}

/**
 * A caller-supplied JSON-RPC transport, accepted wherever an `rpc` helper
 * takes an RPC URL. Use it to route the helpers' reads through your own
 * client: its batching, endpoint routing, block pinning, request budget or
 * cancellation. {@link eip1193Rpc} adapts an EIP-1193 provider (or a viem
 * client) to it.
 *
 * Timeouts, retries and batch splitting are the transport's own: the
 * helpers' `timeout` option applies only to RPC URLs.
 */
export interface CurveRpc {
  /**
   * eth_call each of `calls` at `options.blockTag`, resolving to one entry
   * per call, in order: the raw hex return data, or `null` when that call
   * reverted or returned no data.
   *
   * Reject on anything else (transport failure, rate limit, missing state,
   * abort). Never resolve such a failure to `null`: the pool detector reads
   * `null` as "this view does not exist".
   */
  call(calls: RpcCall[], options: CurveRpcCallOptions): Promise<(string | null)[]>;
  /**
   * Any other JSON-RPC method (`eth_getCode`, `eth_getBlockByNumber`,
   * `eth_blockNumber`): resolve to the response's `result`, reject on an
   * error response.
   */
  request(method: string, params: unknown[], options: CurveRpcRequestOptions): Promise<unknown>;
}

/** An RPC URL, or a {@link CurveRpc} transport */
export type RpcTarget = string | CurveRpc;

/** The subset of an EIP-1193 provider {@link eip1193Rpc} uses (viem clients have it too) */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

const REVERT_MESSAGE = /revert|invalid opcode|out of gas|stack underflow|bad instruction|vm exception/i;

/**
 * True when an eth_call error is the call reverting rather than the request
 * failing: a JSON-RPC error with code 3, or with a numeric code and a revert
 * message ("execution reverted", "invalid opcode", …). Follows `cause`
 * chains, so wrapped errors (viem's) classify like the raw JSON-RPC error.
 * Errors without a JSON-RPC code (HTTP, network, abort) are never reverts.
 */
export function isRevertError(error: unknown): boolean {
  let e = error;
  for (let depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    const { code, message, details, cause } = e as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    if (code === 3) return true;
    if (typeof code === "number") {
      if (typeof message === "string" && REVERT_MESSAGE.test(message)) return true;
      if (typeof details === "string" && REVERT_MESSAGE.test(details)) return true;
    }
    e = cause;
  }
  return false;
}

/**
 * Adapt an EIP-1193 provider (`window.ethereum`, a viem `PublicClient`, or
 * anything else with an EIP-1193 `request`) to a {@link CurveRpc}. Each eth_call is
 * its own `request`, so batching is whatever the provider does (viem's
 * `http(url, { batch: true })` transport batches them). A call whose error
 * {@link isRevertError} classifies as a revert reads as `null`; any other
 * error rejects.
 *
 * EIP-1193 has no cancellation: an aborted signal rejects before each
 * request and once in-flight requests settle, but cannot stop them.
 */
export function eip1193Rpc(provider: Eip1193Provider): CurveRpc {
  return {
    call: (calls, { blockTag, signal }) =>
      Promise.all(
        calls.map(async (c) => {
          throwIfAborted(signal);
          try {
            const result = (await provider.request({
              method: "eth_call",
              params: [{ to: c.to, data: c.data }, blockTag],
            })) as string | null;
            throwIfAborted(signal);
            return result && result !== "0x" ? result : null;
          } catch (error) {
            throwIfAborted(signal);
            if (isRevertError(error)) return null;
            throw error;
          }
        })
      ),
    request: async (method, params, { signal }) => {
      throwIfAborted(signal);
      const result = await provider.request({ method, params });
      throwIfAborted(signal);
      return result;
    },
  };
}

/** Throw the signal's reason when it has fired */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("RPC request aborted");
}
