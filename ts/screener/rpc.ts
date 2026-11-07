/**
 * A minimal NEAR JSON-RPC client over fetch. Errors keep NEAR's own cause name (`UNKNOWN_BLOCK`,
 * `UNKNOWN_ACCOUNT`, `TIMEOUT_ERROR`...), so callers can tell "not there" from "broken".
 */

export class RpcError extends Error {
  readonly method: string;
  /** NEAR's `error.cause.name`, or `HTTP_<status>` when the request itself failed. */
  readonly causeName: string;

  constructor(method: string, causeName: string, detail: string) {
    super(`${method}: ${causeName}: ${detail}`);
    this.name = "RpcError";
    this.method = method;
    this.causeName = causeName;
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

export const jsonRpc = (url: string): Rpc => {
  let id = 0;
  return {
    url,
    async call<T>(method: string, params: unknown): Promise<T> {
      id += 1;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!response.ok) throw new RpcError(method, `HTTP_${response.status}`, await response.text());
      const body = (await response.json()) as RpcBody;
      if (body.error) {
        const cause = body.error.cause?.name ?? body.error.name ?? "UNKNOWN";
        throw new RpcError(method, cause, JSON.stringify(body.error.data ?? body.error));
      }
      return body.result as T;
    },
  };
};

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
