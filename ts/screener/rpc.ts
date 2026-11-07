/**
 * A minimal NEAR JSON-RPC client over fetch. Errors keep NEAR's own cause name (`UNKNOWN_BLOCK`,
 * `UNKNOWN_ACCOUNT`, `TIMEOUT_ERROR`...), so callers can tell "not there" from "broken".
 *
 * neard sends some of those errors with an HTTP status other than 200 (2.13.4, `rpc_handler` in
 * chain/jsonrpc/src/lib.rs): an unknown block below its head with 422, a timeout with 408, an
 * internal error with 500, a malformed request with 400. The body is NEAR's usual JSON-RPC error
 * either way, so its cause name is read from it whatever the status.
 */

export class RpcError extends Error {
  readonly method: string;
  /** NEAR's `error.cause.name`, or `HTTP_<status>` when the request failed without NEAR's error body. */
  readonly causeName: string;
  /** The HTTP status, when it was not 200. */
  readonly httpStatus: number | undefined;

  constructor(method: string, causeName: string, detail: string, httpStatus?: number) {
    super(`${method}: ${causeName}${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}: ${detail}`);
    this.name = "RpcError";
    this.method = method;
    this.causeName = causeName;
    this.httpStatus = httpStatus;
  }
}

export interface Rpc {
  readonly url: string;
  call<T>(method: string, params: unknown): Promise<T>;
}

interface RpcBody {
  readonly result?: unknown;
  readonly error?: { readonly cause?: { readonly name?: string }; readonly name?: string; readonly data?: unknown };
}

/** How a request reaches the network: plain `fetch`, or a paced one (paced-fetch.ts). */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** NEAR's error body in `text`, if it holds one: a JSON-RPC response with an `error`. */
const nearErrorIn = (text: string): RpcBody["error"] | undefined => {
  try {
    const body = JSON.parse(text) as RpcBody | null;
    return typeof body === "object" && body !== null && typeof body.error === "object" && body.error !== null ? body.error : undefined;
  } catch {
    return undefined;
  }
};

const errorFrom = (method: string, error: NonNullable<RpcBody["error"]>, httpStatus?: number): RpcError =>
  new RpcError(method, error.cause?.name ?? error.name ?? "UNKNOWN", JSON.stringify(error.data ?? error), httpStatus);

export const jsonRpc = (url: string, transport: Transport = (u, init) => fetch(u, init)): Rpc => {
  let id = 0;
  return {
    url,
    async call<T>(method: string, params: unknown): Promise<T> {
      id += 1;
      const response = await transport(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!response.ok) {
        const text = await response.text();
        const error = nearErrorIn(text);
        throw error ? errorFrom(method, error, response.status) : new RpcError(method, `HTTP_${response.status}`, text, response.status);
      }
      const body = (await response.json()) as RpcBody;
      if (body.error) throw errorFrom(method, body.error);
      return body.result as T;
    },
  };
};

/**
 * Errors a healthy node answers later: it gave up waiting (TIMEOUT_ERROR, or a bare HTTP 408), hit
 * an internal error, or has a shard still catching up.
 */
export const RETRY_CAUSES: ReadonlySet<string> = new Set([
  "TIMEOUT_ERROR",
  "HTTP_408",
  "INTERNAL_ERROR",
  "UNAVAILABLE_SHARD",
  "NO_SYNCED_BLOCKS",
]);

/**
 * `rpc` that asks again after an error in RETRY_CAUSES: up to `attempts` tries in all, waiting
 * 1 s, then 2 s, then 4 s between them. Only for calls that are safe to repeat, as reads are.
 */
export const retryingRpc = (rpc: Rpc, sleep: (ms: number) => Promise<void>, attempts = 4): Rpc => ({
  url: rpc.url,
  async call<T>(method: string, params: unknown): Promise<T> {
    for (let n = 1; ; n += 1) {
      try {
        return await rpc.call<T>(method, params);
      } catch (error) {
        if (!(error instanceof RpcError && RETRY_CAUSES.has(error.causeName)) || n >= attempts) throw error;
        await sleep(1000 * 2 ** (n - 1));
      }
    }
  },
});

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export const mapLimit = async <T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/**
 * Calls a contract's view method and returns its JSON result. A view that panics comes back from
 * NEAR as a 200 with an `error` string, not an RPC error; that is thrown as a `ViewError` with the
 * contract's own message.
 */
export class ViewError extends Error {
  readonly contract: string;
  readonly method: string;

  constructor(contract: string, method: string, detail: string) {
    super(`${contract}.${method}: ${detail}`);
    this.name = "ViewError";
    this.contract = contract;
    this.method = method;
  }
}

export const callView = async (rpc: Rpc, contract: string, method: string, args: unknown): Promise<unknown> => {
  const result = await rpc.call<{ result?: readonly number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (result.error !== undefined) {
    const panic = /panic_msg: "(?:panicked at [^"]*?:\\n)?([^"]*)"/.exec(result.error);
    throw new ViewError(contract, method, panic?.[1]?.trim() || result.error.slice(0, 200));
  }
  return JSON.parse(Buffer.from(result.result ?? []).toString("utf8"));
};
