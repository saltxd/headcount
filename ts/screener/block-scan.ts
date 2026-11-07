/**
 * The sandbox data adapter: reads a chain by scanning every block over JSON-RPC.
 *
 * A sandbox has no indexer, so this walks it from genesis to the final head: each block, each new
 * chunk in it, each transaction in the chunk, and each transaction's full receipt tree with
 * outcomes (`EXPERIMENTAL_tx_status`). From the receipts that succeeded it indexes who created
 * which account, which full-access keys each account was given or lost, and every NEAR and NEP-141
 * transfer an account made itself. It is the same `ChainReader` the screen reads on mainnet, with
 * a different source.
 */

import { RpcError, mapLimit, type Rpc } from "./rpc.ts";
import { NEAR_ASSET, isImplicit, type ChainReader, type Creation, type Transfer } from "./types.ts";

export interface ScanOptions {
  /**
   * Accounts that create accounts for others: `near` on mainnet, the root account in a sandbox. An
   * account created through one counts as created by whoever called it.
   */
  readonly registrars: readonly string[];
  /** Requests in flight at once. */
  readonly concurrency?: number;
}

export interface ScanStats {
  readonly fromHeight: number;
  readonly toHeight: number;
  readonly blocks: number;
  readonly chunks: number;
  readonly transactions: number;
}

export interface BlockScanReader extends ChainReader {
  readonly stats: ScanStats;
  /**
   * The full-access keys the scan's own record says `account` holds at the head, built from the
   * AddKey and DeleteKey actions it read. `fullAccessKeys` asks the chain instead; the two agreeing
   * is a check that the scan missed no key change.
   */
  heldKeys(account: string): readonly string[];
}

/** An action as NEAR's RPC writes it: `"CreateAccount"`, or `{ "<Kind>": { ...fields } }`. */
export type RpcAction = string | { readonly [kind: string]: unknown };

/** A receipt as `EXPERIMENTAL_tx_status` lists it (the fields the scan reads). */
export interface RpcReceipt {
  readonly receipt_id: string;
  readonly predecessor_id: string;
  readonly receiver_id: string;
  readonly receipt: { readonly Action?: { readonly signer_id: string; readonly actions: readonly RpcAction[] } };
}

/** A transaction's status as `EXPERIMENTAL_tx_status` returns it (the fields the scan reads). */
export interface TxStatus {
  readonly transaction: {
    readonly hash: string;
    readonly signer_id: string;
    readonly receiver_id: string;
    readonly actions: readonly RpcAction[];
  };
  readonly transaction_outcome: { readonly block_hash: string; readonly outcome: { readonly receipt_ids: readonly string[] } };
  readonly receipts?: readonly RpcReceipt[];
  readonly receipts_outcome: readonly {
    readonly id: string;
    readonly block_hash: string;
    readonly outcome: {
      readonly status: unknown;
      readonly logs: readonly string[];
      readonly receipt_ids: readonly string[];
      readonly executor_id: string;
    };
  }[];
}

/** One thing a successful receipt did, at the height of the block that executed it. */
export type Fact =
  | { readonly kind: "create"; readonly account: string; readonly creation: Creation }
  | { readonly kind: "transfer"; readonly transfer: Transfer }
  | { readonly kind: "add-key"; readonly account: string; readonly key: string; readonly blockHeight: number }
  | { readonly kind: "delete-key"; readonly account: string; readonly key: string; readonly blockHeight: number }
  | { readonly kind: "delete-account"; readonly account: string; readonly blockHeight: number };

/** What the scan knows, built from facts in the order the chain executed them. */
export interface ChainIndex {
  readonly creations: ReadonlyMap<string, Creation>;
  /** Creator to the accounts it created. */
  readonly createdBy: ReadonlyMap<string, ReadonlySet<string>>;
  readonly transfersFrom: ReadonlyMap<string, readonly Transfer[]>;
  readonly transfersTo: ReadonlyMap<string, readonly Transfer[]>;
  /** Account to the full-access keys it holds now. */
  readonly keysOf: ReadonlyMap<string, ReadonlySet<string>>;
  /** Key to every account that has held it with full access, then or now. */
  readonly everHeld: ReadonlyMap<string, ReadonlySet<string>>;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const base58 = (bytes: Uint8Array): string => {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
};

/** The ed25519 key a NEAR implicit account's id spells (`ed25519:<base58>`); null for any other id. */
export const impliedKey = (account: string): string | null =>
  /^[0-9a-f]{64}$/.test(account) ? `ed25519:${base58(Buffer.from(account, "hex"))}` : null;

const kindOf = (action: RpcAction): string => (typeof action === "string" ? action : (Object.keys(action)[0] ?? ""));

const fieldsOf = (action: RpcAction): Readonly<Record<string, unknown>> => {
  if (typeof action === "string") return {};
  const fields = action[kindOf(action)];
  return typeof fields === "object" && fields !== null ? (fields as Record<string, unknown>) : {};
};

/** The public key of an AddKey action that grants full access; null for any other action. */
const fullAccessKeyAdded = (action: RpcAction): string | null => {
  if (kindOf(action) !== "AddKey") return null;
  const fields = fieldsOf(action);
  const accessKey = fields["access_key"] as { readonly permission?: unknown } | undefined;
  return accessKey?.permission === "FullAccess" && typeof fields["public_key"] === "string" ? fields["public_key"] : null;
};

const succeeded = (status: unknown): boolean =>
  typeof status === "object" && status !== null && ("SuccessValue" in status || "SuccessReceiptId" in status);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const EVENT_PREFIX = "EVENT_JSON:";

/**
 * NEP-141 transfers in one log line. Any contract can log any event, so a transfer counts only if
 * its sender is the receipt's predecessor: the account itself called the token. That also leaves
 * out the refund leg of `ft_transfer_call`, where the token calls itself.
 */
const tokenTransfers = (log: string, receipt: RpcReceipt, txHash: string, blockHeight: number): Fact[] => {
  if (!log.startsWith(EVENT_PREFIX)) return [];
  let event: unknown;
  try {
    event = JSON.parse(log.slice(EVENT_PREFIX.length));
  } catch {
    return [];
  }
  if (!isRecord(event) || event["standard"] !== "nep141" || event["event"] !== "ft_transfer" || !Array.isArray(event["data"])) return [];
  return event["data"].flatMap((item: unknown): Fact[] => {
    if (!isRecord(item)) return [];
    const { old_owner_id: from, new_owner_id: to, amount } = item;
    if (typeof from !== "string" || typeof to !== "string" || typeof amount !== "string" || !/^\d+$/.test(amount)) return [];
    if (from !== receipt.predecessor_id) return [];
    return [{ kind: "transfer", transfer: { from, to, asset: receipt.receiver_id, amount: BigInt(amount), txHash, blockHeight } }];
  });
};

/** The facts one transaction left, from its receipts that succeeded in blocks `heightOf` knows. */
export const factsFromTx = (
  tx: TxStatus,
  heightOf: (blockHash: string) => number | undefined,
  registrars: ReadonlySet<string>,
): Fact[] => {
  const receipts = new Map<string, RpcReceipt>((tx.receipts ?? []).map((r) => [r.receipt_id, r]));
  // The receipt the transaction became. NEAR's tx status leaves it out when the transaction's
  // signer is also its receiver (a "local" receipt, such as an account changing its own keys), so
  // it is rebuilt from the transaction, which carries the same actions.
  const first = tx.transaction_outcome.outcome.receipt_ids[0];
  if (first !== undefined && !receipts.has(first)) {
    receipts.set(first, {
      receipt_id: first,
      predecessor_id: tx.transaction.signer_id,
      receiver_id: tx.transaction.receiver_id,
      receipt: { Action: { signer_id: tx.transaction.signer_id, actions: tx.transaction.actions } },
    });
  }
  const parentOf = new Map<string, string>();
  for (const o of tx.receipts_outcome) for (const child of o.outcome.receipt_ids) parentOf.set(child, o.id);

  const txHash = tx.transaction.hash;
  const facts: Fact[] = [];
  for (const { id, block_hash, outcome } of tx.receipts_outcome) {
    const receipt = receipts.get(id);
    const action = receipt?.receipt.Action;
    // Data receipts carry no actions; `system` pays gas refunds; a failed receipt changed nothing.
    if (!receipt || !action || receipt.predecessor_id === "system" || !succeeded(outcome.status)) continue;
    const blockHeight = heightOf(block_hash);
    if (blockHeight === undefined) continue;
    const account = receipt.receiver_id;

    if (action.actions.some((a) => kindOf(a) === "CreateAccount")) {
      const viaRegistrar = registrars.has(receipt.predecessor_id);
      // Through a registrar, the creator is whoever called it: the predecessor of the receipt that
      // reached the registrar (the user even when a relayer signed), or the signer when the
      // registrar created the account in its own transaction.
      const caller = receipts.get(parentOf.get(id) ?? "")?.predecessor_id ?? action.signer_id;
      facts.push({
        kind: "create",
        account,
        creation: {
          creator: viaRegistrar ? caller : receipt.predecessor_id,
          how: viaRegistrar ? "via-registrar" : "sub-account",
          txHash,
          blockHeight,
          initialKeys: action.actions.flatMap((a) => fullAccessKeyAdded(a) ?? []),
        },
      });
    }
    for (const a of action.actions) {
      const fields = fieldsOf(a);
      const added = fullAccessKeyAdded(a);
      if (added !== null) facts.push({ kind: "add-key", account, key: added, blockHeight });
      switch (kindOf(a)) {
        case "Transfer": {
          const amount = BigInt(String(fields["deposit"] ?? "0"));
          if (amount > 0n) {
            facts.push({ kind: "transfer", transfer: { from: receipt.predecessor_id, to: account, asset: NEAR_ASSET, amount, txHash, blockHeight } });
          }
          break;
        }
        case "DeleteKey":
          if (typeof fields["public_key"] === "string") facts.push({ kind: "delete-key", account, key: fields["public_key"], blockHeight });
          break;
        case "DeleteAccount":
          facts.push({ kind: "delete-account", account, blockHeight });
          break;
        default:
          break;
      }
    }
    for (const log of outcome.logs) facts.push(...tokenTransfers(log, receipt, txHash, blockHeight));
  }
  return facts;
};

const heightOfFact = (fact: Fact): number =>
  fact.kind === "create" ? fact.creation.blockHeight : fact.kind === "transfer" ? fact.transfer.blockHeight : fact.blockHeight;

const setIn = <V>(map: Map<string, Set<V>>, key: string): Set<V> => {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Set<V>();
  map.set(key, created);
  return created;
};

const listIn = <V>(map: Map<string, V[]>, key: string): V[] => {
  const existing = map.get(key);
  if (existing) return existing;
  const created: V[] = [];
  map.set(key, created);
  return created;
};

/** Indexes facts in execution order. An implicit account's first NEAR transfer is its creation. */
export const buildIndex = (facts: readonly Fact[]): ChainIndex => {
  const creations = new Map<string, Creation>();
  const createdBy = new Map<string, Set<string>>();
  const transfersFrom = new Map<string, Transfer[]>();
  const transfersTo = new Map<string, Transfer[]>();
  const keysOf = new Map<string, Set<string>>();
  const everHeld = new Map<string, Set<string>>();

  const create = (account: string, creation: Creation): void => {
    creations.set(account, creation);
    setIn(createdBy, creation.creator).add(account);
  };
  const addKey = (account: string, key: string): void => {
    setIn(keysOf, account).add(key);
    setIn(everHeld, key).add(account);
  };

  // A stable sort: facts of one block keep the order the scan read them in.
  for (const fact of [...facts].sort((a, b) => heightOfFact(a) - heightOfFact(b))) {
    switch (fact.kind) {
      case "create":
        create(fact.account, fact.creation); // its keys arrive as add-key facts from the same receipt
        break;
      case "transfer": {
        const t = fact.transfer;
        listIn(transfersFrom, t.from).push(t);
        listIn(transfersTo, t.to).push(t);
        if (t.asset === NEAR_ASSET && isImplicit(t.to) && !creations.has(t.to)) {
          const implied = impliedKey(t.to);
          create(t.to, { creator: t.from, how: "first-transfer", txHash: t.txHash, blockHeight: t.blockHeight, initialKeys: implied ? [implied] : [] });
          if (implied) addKey(t.to, implied);
        }
        break;
      }
      case "add-key":
        addKey(fact.account, fact.key);
        break;
      case "delete-key":
        keysOf.get(fact.account)?.delete(fact.key);
        break;
      case "delete-account":
        keysOf.delete(fact.account);
        creations.delete(fact.account);
        break;
    }
  }
  return { creations, createdBy, transfersFrom, transfersTo, keysOf, everHeld };
};

interface BlockView {
  readonly header: { readonly height: number; readonly hash: string };
  readonly chunks: readonly { readonly chunk_hash: string; readonly height_included: number }[];
}

interface ChunkView {
  readonly transactions: readonly { readonly hash: string; readonly signer_id: string }[];
}

interface AccessKeyList {
  readonly keys: readonly { readonly public_key: string; readonly access_key: { readonly permission: unknown } }[];
}

/** Scans every block from genesis to the final head and returns a reader over what it found. */
export const scanChain = async (rpc: Rpc, options: ScanOptions): Promise<BlockScanReader> => {
  const concurrency = options.concurrency ?? 8;
  const registrars = new Set(options.registrars);
  const [status, genesis] = await Promise.all([
    rpc.call<{ sync_info: { earliest_block_height: number } }>("status", []),
    rpc.call<{ genesis_height: number }>("EXPERIMENTAL_genesis_config", {}),
  ]);
  const fromHeight = genesis.genesis_height;
  if (status.sync_info.earliest_block_height > fromHeight) {
    throw new Error(
      `this node keeps blocks only from height ${status.sync_info.earliest_block_height}; a block scan needs every block ` +
        `from genesis (${fromHeight}), or an account creation it never saw could hide a link`,
    );
  }
  const head = await rpc.call<BlockView>("block", { finality: "final" });
  const toHeight = head.header.height;

  const heights = Array.from({ length: toHeight - fromHeight + 1 }, (_, i) => fromHeight + i);
  const blocks = (
    await mapLimit(heights, concurrency, async (height) => {
      try {
        return await rpc.call<BlockView>("block", { block_id: height });
      } catch (error) {
        if (error instanceof RpcError && error.causeName === "UNKNOWN_BLOCK") return null; // no block at this height
        throw error;
      }
    })
  ).filter((block): block is BlockView => block !== null);
  const heightOf = new Map(blocks.map((b) => [b.header.hash, b.header.height]));
  // A block repeats the last chunk of a shard that produced none; only chunks new at this height count.
  const chunkHashes = blocks.flatMap((b) => b.chunks.filter((c) => c.height_included === b.header.height).map((c) => c.chunk_hash));
  const chunks = await mapLimit(chunkHashes, concurrency, (hash) => rpc.call<ChunkView>("chunk", { chunk_id: hash }));
  const transactions = chunks.flatMap((c) => c.transactions);
  const statuses = await mapLimit(transactions, concurrency, (t) =>
    rpc.call<TxStatus>("EXPERIMENTAL_tx_status", { tx_hash: t.hash, sender_account_id: t.signer_id, wait_until: "NONE" }),
  );
  const index = buildIndex(statuses.flatMap((s) => factsFromTx(s, (hash) => heightOf.get(hash), registrars)));

  const stats: ScanStats = { fromHeight, toHeight, blocks: blocks.length, chunks: chunkHashes.length, transactions: transactions.length };
  const exists = async (account: string): Promise<boolean> => {
    try {
      await rpc.call("query", { request_type: "view_account", block_id: toHeight, account_id: account });
      return true;
    } catch (error) {
      if (error instanceof RpcError && error.causeName === "UNKNOWN_ACCOUNT") return false;
      throw error;
    }
  };
  return {
    source: "block scan over JSON-RPC, every block from genesis",
    headHeight: toHeight,
    stats,
    creation: async (account) => index.creations.get(account) ?? null,
    fullAccessKeys: async (account) => {
      if (!(await exists(account))) return null;
      const list = await rpc.call<AccessKeyList>("query", { request_type: "view_access_key_list", block_id: toHeight, account_id: account });
      return list.keys
        .filter((k) => k.access_key.permission === "FullAccess")
        .map((k) => k.public_key)
        .sort();
    },
    transfersFrom: async (account) => index.transfersFrom.get(account) ?? [],
    createdCount: async (account, cap) => Math.min(index.createdBy.get(account)?.size ?? 0, cap),
    keyHolderCount: async (key, cap) => Math.min(index.everHeld.get(key)?.size ?? 0, cap),
    senderCount: async (account, cap, counts) =>
      Math.min(new Set((index.transfersTo.get(account) ?? []).filter(counts).map((t) => t.from)).size, cap),
    heldKeys: (account) => [...(index.keysOf.get(account) ?? [])].sort(),
  };
};
