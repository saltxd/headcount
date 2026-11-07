/**
 * The mainnet data adapter: answers the screen's `ChainReader` questions from FastNEAR's keyless
 * public endpoints, with a request budget of 2 a second (see paced-fetch.ts).
 *
 *   free.rpc.fastnear.com   block, view_account, view_access_key_list, call_function
 *   tx.main.fastnear.com    /v0/account (an account's transactions by role) and /v0/transactions
 *                           (up to 20 transactions with every receipt)
 *   api.fastnear.com        /v1/public_key/<key> (accounts holding it with full access)
 *
 * The sandbox adapter scans every block, so it sees everything. This one asks per account, so it
 * reads a bounded slice and says so: `caveats()` lists every place it stopped early. Most shortcuts
 * err toward treating an account as a service, which links fewer recipients: an account too busy to
 * read counts as a service, and an implicit account that received NEAR counts as created. Two can
 * link more than the sandbox reader would: FastNEAR's key index lists current holders only, so a key
 * many accounts were created with and later removed is not a service here and can still link two
 * recipients created with it; and an account deleted and created again is read as its first
 * creation, where the block scan takes the latest.
 * A transaction is turned into the same `TxStatus` the block scan reads, so the receipt rules
 * (who created whom, which keys, which transfers) are the very same code.
 */

import { buildIndex, factsFromTx, type Fact, type RpcReceipt, type TxStatus } from "./block-scan.ts";
import { type PacedFetch } from "./paced-fetch.ts";
import { RpcError, jsonRpc, retryingRpc, type Rpc } from "./rpc.ts";
import { NEAR_ASSET, isImplicit, type ChainReader, type Creation, type Transfer } from "./types.ts";

export const FASTNEAR = {
  rpc: "https://free.rpc.fastnear.com",
  tx: "https://tx.main.fastnear.com",
  api: "https://api.fastnear.com",
} as const;

/** FastNEAR's `/v0/transactions` refuses more than this many hashes in one call. */
export const TX_BATCH = 20;
/** FastNEAR's `/v0/account` page size. */
export const ROW_PAGE = 200;

export interface FastNearOptions {
  /** A `createPacedFetch` result: the only way this adapter touches the network. */
  readonly fetch: PacedFetch | ((url: string, init: RequestInit) => Promise<Response>);
  readonly rpcUrl?: string;
  readonly txUrl?: string;
  readonly apiUrl?: string;
  /** Accounts that create accounts for others; `near` on mainnet. */
  readonly registrars?: readonly string[];
  /** The newest this many transactions of each role are read for an account. */
  readonly maxRows?: number;
  /** Waits between retries of an RPC-level error that arrives as a 200. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface FastNearReader extends ChainReader {
  /** Every place the reader stopped before the account's whole history, in plain words. */
  caveats(): readonly string[];
}

/** A transaction as `/v0/transactions` returns it (the fields the adapter reads). */
export interface FastNearTx {
  readonly transaction: TxStatus["transaction"];
  readonly execution_outcome: { readonly block_hash: string; readonly block_height: number; readonly outcome: { readonly receipt_ids: readonly string[] } };
  readonly receipts: readonly {
    readonly execution_outcome: {
      readonly id: string;
      readonly block_hash: string;
      readonly block_height: number;
      readonly outcome: TxStatus["receipts_outcome"][number]["outcome"];
    };
    readonly receipt: Omit<RpcReceipt, "receipt_id"> & { readonly receipt_id: string };
  }[];
}

/** FastNEAR's transaction in the shape `EXPERIMENTAL_tx_status` has, plus a block-hash height table. */
export const toTxStatus = (tx: FastNearTx): { readonly status: TxStatus; readonly heights: ReadonlyMap<string, number> } => {
  const heights = new Map<string, number>([[tx.execution_outcome.block_hash, tx.execution_outcome.block_height]]);
  for (const r of tx.receipts) heights.set(r.execution_outcome.block_hash, r.execution_outcome.block_height);
  const status: TxStatus = {
    transaction: tx.transaction,
    transaction_outcome: { block_hash: tx.execution_outcome.block_hash, outcome: { receipt_ids: tx.execution_outcome.outcome.receipt_ids } },
    receipts: tx.receipts.map((r) => r.receipt),
    receipts_outcome: tx.receipts.map((r) => ({
      id: r.execution_outcome.id,
      block_hash: r.execution_outcome.block_hash,
      outcome: r.execution_outcome.outcome,
    })),
  };
  return { status, heights };
};

interface AccountRow {
  readonly transaction_hash: string;
  readonly is_success?: boolean;
}

interface AccountPage {
  readonly account_txs: readonly AccountRow[];
  readonly resume_token?: string | null;
}

type Role = "creating" | "sent" | "received";

/** The `/v0/account` filters that select each role. Received also takes transactions that only logged the account (token transfers). */
const ROLE_FILTERS: Readonly<Record<Role, readonly Record<string, boolean>[]>> = {
  creating: [{ is_receiver: true }],
  sent: [{ is_predecessor: true }],
  received: [{ is_receiver: true }, { is_event_log: true }],
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const fastnearReader = async (options: FastNearOptions): Promise<FastNearReader> => {
  const http = options.fetch;
  const txUrl = options.txUrl ?? FASTNEAR.tx;
  const apiUrl = options.apiUrl ?? FASTNEAR.api;
  const registrars = new Set(options.registrars ?? ["near"]);
  const maxRows = options.maxRows ?? 400;
  const rpc = retryingRpc(jsonRpc(options.rpcUrl ?? FASTNEAR.rpc, http), options.sleep ?? realSleep);
  const caveats = new Set<string>();
  /** Accounts counted as services because their history was longer than the budget, with the reason. */
  const busy = new Map<string, string>();

  const post = async <T>(url: string, body: unknown): Promise<T> => {
    const response = await http(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return (await response.json()) as T;
  };

  const head = await rpc.call<{ header: { height: number } }>("block", { finality: "final" });
  const headHeight = head.header.height;

  /** The newest `limit` successful transaction hashes where `account` had `role`, newest first. */
  const hashesOf = async (account: string, role: Role, limit: number, order: "asc" | "desc"): Promise<{ hashes: string[]; more: boolean }> => {
    const found = new Set<string>();
    let more = false;
    for (const filter of ROLE_FILTERS[role]) {
      let token: string | null | undefined;
      let have = 0;
      do {
        const page = await post<AccountPage>(`${txUrl}/v0/account`, {
          account_id: account,
          limit: Math.min(ROW_PAGE, Math.max(limit - have, 1)),
          desc: order === "desc",
          is_success: true,
          ...filter,
          ...(token ? { resume_token: token } : {}),
        });
        for (const row of page.account_txs) if (row.is_success !== false) found.add(row.transaction_hash);
        have += page.account_txs.length;
        token = page.resume_token;
        more = Boolean(token) && have >= limit;
      } while (token && have < limit);
      if (more) break;
    }
    return { hashes: [...found], more };
  };

  const txCache = new Map<string, FastNearTx>();
  const fetchTxs = async (hashes: readonly string[]): Promise<FastNearTx[]> => {
    const missing = hashes.filter((h) => !txCache.has(h));
    for (let i = 0; i < missing.length; i += TX_BATCH) {
      const batch = missing.slice(i, i + TX_BATCH);
      const body = await post<{ transactions: readonly FastNearTx[] }>(`${txUrl}/v0/transactions`, { tx_hashes: batch });
      for (const tx of body.transactions) txCache.set(tx.transaction.hash, tx);
    }
    return hashes.flatMap((h) => txCache.get(h) ?? []);
  };

  const factsOf = async (hashes: readonly string[]): Promise<Fact[]> => {
    const facts: Fact[] = [];
    for (const tx of await fetchTxs(hashes)) {
      const { status, heights } = toTxStatus(tx);
      facts.push(...factsFromTx(status, (hash) => heights.get(hash), registrars));
    }
    return facts;
  };

  const sentCache = new Map<string, Promise<Transfer[]>>();
  const transfersFrom = (account: string): Promise<Transfer[]> => {
    let cached = sentCache.get(account);
    if (!cached) {
      cached = (async () => {
        const { hashes, more } = await hashesOf(account, "sent", maxRows, "desc");
        if (more) caveats.add(`${account}: only its newest ${maxRows} outgoing transactions were read`);
        const sent = (await factsOf(hashes)).flatMap((f) => (f.kind === "transfer" && f.transfer.from === account ? [f.transfer] : []));
        return sent.sort((a, b) => a.blockHeight - b.blockHeight);
      })();
      sentCache.set(account, cached);
    }
    return cached;
  };

  const keyCache = new Map<string, Promise<number>>();
  const publicKeyHolders = (key: string): Promise<number> => {
    let cached = keyCache.get(key);
    if (!cached) {
      cached = (async () => {
        const response = await http(`${apiUrl}/v1/public_key/${encodeURIComponent(key)}`, { method: "GET" });
        if (!response.ok) throw new Error(`${apiUrl}/v1/public_key: HTTP ${response.status}`);
        return ((await response.json()) as { account_ids: readonly string[] }).account_ids.length;
      })();
      keyCache.set(key, cached);
    }
    return cached;
  };

  const exists = async (account: string): Promise<boolean> => {
    try {
      await rpc.call("query", { request_type: "view_account", finality: "final", account_id: account });
      return true;
    } catch (error) {
      if (error instanceof RpcError && error.causeName === "UNKNOWN_ACCOUNT") return false;
      throw error;
    }
  };

  /** Pages a role newest first and stops as soon as `enough` says the answer is settled. */
  const countCache = new Map<string, Promise<number>>();
  const counted = (key: string, count: () => Promise<number>): Promise<number> => {
    let cached = countCache.get(key);
    if (!cached) {
      cached = count();
      countCache.set(key, cached);
    }
    return cached;
  };

  /**
   * Reads transactions a page at a time, newest first, until `settled` or the history budget runs
   * out. `truncated` means there was more history than the budget and `settled` never held: the
   * facts cannot show the account is small.
   */
  const scanUntil = async (
    account: string,
    role: Role,
    settled: (facts: readonly Fact[]) => boolean,
  ): Promise<{ readonly facts: readonly Fact[]; readonly truncated: boolean }> => {
    let facts: readonly Fact[] = [];
    for (let rows = ROW_PAGE; ; rows += ROW_PAGE) {
      const { hashes, more } = await hashesOf(account, role, Math.min(rows, maxRows), "desc");
      facts = await factsOf(hashes);
      if (settled(facts)) return { facts, truncated: false };
      if (!more) return { facts, truncated: false };
      if (rows >= maxRows) return { facts, truncated: true };
    }
  };

  /**
   * A count capped at `cap`. When the read was cut short without reaching the cap, the account
   * cannot be shown to be small, so it counts as passing the cap: a service. That errs toward
   * linking fewer recipients, and the caveat names the account.
   */
  const capped = (account: string, role: Role, cap: number, count: (facts: readonly Fact[]) => number): Promise<number> =>
    counted(`${role} ${account} ${cap}`, async () => {
      const { facts, truncated } = await scanUntil(account, role, (f) => count(f) >= cap);
      const seen = count(facts);
      if (truncated && seen < cap) {
        const direction = role === "sent" ? "outgoing" : "incoming";
        caveats.add(`${account}: more than ${maxRows} ${direction} transactions; treated as a service (seen ${seen} so far, cap ${cap})`);
        busy.set(account, `more than ${maxRows} ${direction} transactions, too busy to read, so treated as a service`);
        return cap;
      }
      return Math.min(seen, cap);
    });

  return {
    source: "FastNEAR keyless public endpoints (free RPC, transaction index, key index), at most 2 requests a second",
    headHeight,
    caveats: () => [...caveats].sort(),
    tooBusy: (account) => busy.get(account) ?? null,

    creation: async (account): Promise<Creation | null> => {
      const { hashes } = await hashesOf(account, "creating", 1, "asc");
      const index = buildIndex(await factsOf(hashes));
      return index.creations.get(account) ?? null;
    },

    fullAccessKeys: async (account) => {
      const list = await rpc.call<{ keys: readonly { public_key: string; access_key: { permission: unknown } }[] }>("query", {
        request_type: "view_access_key_list",
        finality: "final",
        account_id: account,
      });
      // A missing account answers with an empty list rather than an error, so ask whether it exists.
      if (list.keys.length === 0 && !(await exists(account))) return null;
      return list.keys
        .filter((k) => k.access_key.permission === "FullAccess")
        .map((k) => k.public_key)
        .sort();
    },

    transfersFrom,

    // Counts are upper bounds on purpose: an implicit account that received NEAR is counted as created.
    createdCount: (account, cap) =>
      capped(account, "sent", cap, (facts) => {
        const explicit = facts.filter((f) => f.kind === "create" && f.creation.creator === account).length;
        const implicit = new Set(
          facts.flatMap((f) => (f.kind === "transfer" && f.transfer.from === account && f.transfer.asset === NEAR_ASSET && isImplicit(f.transfer.to) ? [f.transfer.to] : [])),
        ).size;
        return explicit + implicit;
      }),

    keyHolderCount: async (key, cap) => Math.min(await publicKeyHolders(key), cap),

    senderCount: (account, cap, counts) =>
      capped(
        account,
        "received",
        cap,
        (facts) => new Set(facts.flatMap((f) => (f.kind === "transfer" && f.transfer.to === account && counts(f.transfer) ? [f.transfer.from] : []))).size,
      ),
  };
};
