/**
 * A `fetch` that is polite to a free public endpoint: one request at a time, started at least
 * 500 ms after the last (2 a second at most), retried with doubling backoff on 429, 5xx and
 * network errors (a 429 also doubles the gap between requests for the rest of the run), and limited to the keyless FastNEAR hosts. Mainnet mode is read-only and keyless
 * by design; this is where that is enforced, so no caller can get around it by accident.
 *
 * `sleep` and `now` are injectable so tests run on a fake clock. The defaults are real.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The most requests a second this will ever send. FastNEAR publishes no keyless limit; this stays well under any. */
export const MAX_PER_SECOND = 2;

/** Hosts mainnet mode may call: FastNEAR's keyless RPC, transaction index and key index. */
export const ALLOWED_HOSTS: readonly string[] = ["free.rpc.fastnear.com", "tx.main.fastnear.com", "api.fastnear.com"];

export interface PacedFetchOptions {
  readonly base?: FetchLike;
  readonly perSecond?: number;
  /** Tries per request, the first included. */
  readonly attempts?: number;
  /** The first retry waits this long; each next one doubles it. */
  readonly backoffMs?: number;
  readonly allowedHosts?: readonly string[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface PacedFetch extends FetchLike {
  /** Requests actually sent so far, retries included. */
  readonly requests: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const retryable = (status: number): boolean => status === 429 || status >= 500;

/** Seconds or an HTTP date, as a wait in milliseconds; null if absent or unreadable. */
const retryAfterMs = (response: Response, now: number): number | null => {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.min(Math.max(date - now, 0), 60_000);
};

export const createPacedFetch = (options: PacedFetchOptions = {}): PacedFetch => {
  const perSecond = options.perSecond ?? MAX_PER_SECOND;
  if (!(perSecond > 0 && perSecond <= MAX_PER_SECOND)) throw new Error(`mainnet mode sends at most ${MAX_PER_SECOND} requests a second, not ${perSecond}`);
  const base: FetchLike = options.base ?? ((url, init) => fetch(url, init));
  const attempts = options.attempts ?? 6;
  const backoffMs = options.backoffMs ?? 2000;
  const allowed = new Set(options.allowedHosts ?? ALLOWED_HOSTS);
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  let gapMs = Math.ceil(1000 / perSecond);
  /** The slowest the pace ever gets after the server pushes back: one request every 4 s. */
  const SLOWEST_GAP_MS = 4000;

  let lastStart = -Infinity;
  let sent = 0;
  let queue: Promise<unknown> = Promise.resolve();

  /** Waits for this request's turn, then marks its start. Turns are taken in call order. */
  const takeTurn = async (): Promise<void> => {
    const wait = lastStart + gapMs - now();
    if (wait > 0) await sleep(wait);
    lastStart = now();
  };

  const attempt = async (url: string, init: RequestInit): Promise<Response> => {
    let failure = "no attempt made";
    for (let n = 1; n <= attempts; n += 1) {
      await takeTurn();
      sent += 1;
      let wait = backoffMs * 2 ** (n - 1);
      try {
        const response = await base(url, init);
        if (!retryable(response.status)) return response;
        failure = `HTTP ${response.status}`;
        // The server said slow down: stay slower for the rest of the run, never speed back up.
        if (response.status === 429) gapMs = Math.min(gapMs * 2, SLOWEST_GAP_MS);
        wait = retryAfterMs(response, now()) ?? wait;
        await response.body?.cancel();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (n < attempts) await sleep(wait);
    }
    throw new Error(`${url}: ${failure} after ${attempts} attempts`);
  };

  const paced = (async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !allowed.has(parsed.hostname)) {
      throw new Error(`${parsed.protocol}//${parsed.hostname} is not on the allow-list of keyless hosts (${[...allowed].join(", ")})`);
    }
    // One request at a time, in the order asked: chain onto the queue whether the last one worked or not.
    const run = queue.then(() => attempt(url, init));
    queue = run.catch(() => undefined);
    return run;
  }) as PacedFetch;
  Object.defineProperty(paced, "requests", { get: () => sent });
  return paced;
};
