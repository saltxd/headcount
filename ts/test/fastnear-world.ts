/**
 * A pretend FastNEAR, for tests: it answers the same URLs with the same JSON shapes (checked
 * against recorded responses in fixtures/fastnear/), from transactions built here. Every account,
 * key and hash is made up. Roles in `/v0/account` are derived from the receipts the way the real
 * index flags them, so a reader that asks for the wrong role gets the wrong rows.
 */

import type { FastNearTx } from "../screener/fastnear.ts";
import type { FetchLike } from "../screener/paced-fetch.ts";

export const FACTORY = "factory.test";
export const FACTORY_KEY = "ed25519:FactoryKeyFactoryKeyFactoryKeyFactoryKey1";

type Action = string | Record<string, unknown>;

interface ReceiptSpec {
  readonly predecessor: string;
  readonly receiver: string;
  readonly actions: readonly Action[];
  readonly logs?: readonly string[];
  readonly failed?: boolean;
}

const ok = { SuccessValue: "" };
const bad = { Failure: { ActionError: { index: 0, kind: "x" } } };

/** A transaction whose receipts are `receipts`; the first is the one the transaction became. */
export const makeTx = (hash: string, height: number, signer: string, receipts: readonly ReceiptSpec[], failed = false): FastNearTx => {
  const block = `block-${height}`;
  const id = (i: number): string => `${hash}-r${i}`;
  const first = receipts[0] as ReceiptSpec;
  return {
    transaction: { hash, signer_id: signer, receiver_id: first.receiver, actions: first.actions } as FastNearTx["transaction"],
    execution_outcome: { block_hash: block, block_height: height, outcome: { receipt_ids: [id(0)] } },
    receipts: receipts.map((r, i) => ({
      execution_outcome: {
        id: id(i),
        block_hash: block,
        block_height: height,
        outcome: { status: failed || r.failed ? bad : ok, logs: r.logs ?? [], receipt_ids: [], executor_id: r.receiver },
      },
      receipt: {
        receipt_id: id(i),
        predecessor_id: r.predecessor,
        receiver_id: r.receiver,
        receipt: { Action: { signer_id: signer, actions: r.actions } },
      },
    })),
  };
};

/** `creator` makes `account` through the factory, with `keys` (full access). */
export const createTx = (hash: string, height: number, creator: string, account: string, keys: readonly string[] = []): FastNearTx =>
  makeTx(hash, height, creator, [
    { predecessor: creator, receiver: FACTORY, actions: [{ FunctionCall: { method_name: "create" } }] },
    {
      predecessor: FACTORY,
      receiver: account,
      actions: ["CreateAccount", { Transfer: { deposit: "1" } }, ...keys.map((k) => ({ AddKey: { public_key: k, access_key: { nonce: 0, permission: "FullAccess" } } }))],
    },
  ]);

/** `creator` makes its own sub-account `account` in one step, so the creator is the account's own parent. */
export const subAccountTx = (hash: string, height: number, creator: string, account: string): FastNearTx =>
  makeTx(hash, height, creator, [{ predecessor: creator, receiver: account, actions: ["CreateAccount", { Transfer: { deposit: "1" } }] }]);

export const transferTx = (hash: string, height: number, from: string, to: string, yocto: bigint): FastNearTx =>
  makeTx(hash, height, from, [{ predecessor: from, receiver: to, actions: [{ Transfer: { deposit: yocto.toString() } }] }]);

/** `from` calls a token contract that logs a NEP-141 transfer to `to`. */
export const tokenTx = (hash: string, height: number, from: string, token: string, to: string, amount: string): FastNearTx =>
  makeTx(hash, height, from, [
    {
      predecessor: from,
      receiver: token,
      actions: [{ FunctionCall: { method_name: "ft_transfer" } }],
      logs: [`EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: from, new_owner_id: to, amount }] })}`],
    },
  ]);

const rolesOf = (tx: FastNearTx, account: string): Record<string, boolean> => ({
  is_predecessor: tx.receipts.some((r) => r.receipt.predecessor_id === account),
  is_receiver: tx.receipts.some((r) => r.receipt.receiver_id === account),
  is_event_log: tx.receipts.some((r) => r.execution_outcome.outcome.logs.some((l) => l.includes(`"${account}"`))),
});

export interface WorldOptions {
  readonly txs: readonly FastNearTx[];
  /** Accounts that exist at the head, with their full-access keys. */
  readonly keys: Readonly<Record<string, readonly string[]>>;
  /** Extra holders of a key that never appear in `keys` (the factory key sits on thousands of DAOs). */
  readonly extraHolders?: Readonly<Record<string, number>>;
}

export interface World {
  readonly fetch: FetchLike;
  /** Every request seen, as `<host><path> <body>`. */
  readonly seen: string[];
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

export const makeWorld = (options: WorldOptions): World => {
  const byHash = new Map(options.txs.map((t) => [t.transaction.hash, t]));
  const seen: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    seen.push(`${u.host}${u.pathname} ${typeof init.body === "string" ? init.body : ""}`);

    if (u.host === "free.rpc.fastnear.com") {
      const params = body["params"] as Record<string, unknown>;
      if (body["method"] === "block") return json({ result: { header: { height: 5000 } } });
      const account = String(params["account_id"]);
      if (params["request_type"] === "view_access_key_list") {
        const keys = options.keys[account] ?? [];
        return json({ result: { keys: keys.map((k) => ({ public_key: k, access_key: { nonce: 0, permission: "FullAccess" } })) } });
      }
      if (params["request_type"] === "view_account") {
        if (account in options.keys) return json({ result: { amount: "1" } });
        return json({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, data: {} } });
      }
    }

    if (u.host === "tx.main.fastnear.com" && u.pathname === "/v0/account") {
      const account = String(body["account_id"]);
      const wanted = ["is_predecessor", "is_receiver", "is_event_log"].filter((k) => body[k] === true);
      let rows = options.txs
        .filter((t) => wanted.length === 0 || wanted.some((k) => rolesOf(t, account)[k]))
        .filter((t) => rolesOf(t, account)["is_predecessor"] || rolesOf(t, account)["is_receiver"] || rolesOf(t, account)["is_event_log"])
        .filter((t) => body["is_success"] !== true || t.receipts.every((r) => !("Failure" in (r.execution_outcome.outcome.status as object))))
        .sort((a, b) => a.execution_outcome.block_height - b.execution_outcome.block_height);
      if (body["desc"] === true) rows = rows.reverse();
      const offset = body["resume_token"] ? Number(body["resume_token"]) : 0;
      const limit = Number(body["limit"] ?? 100);
      if (limit > 200) return new Response("limit too large", { status: 400 });
      const page = rows.slice(offset, offset + limit);
      const next = offset + limit < rows.length ? String(offset + limit) : null;
      return json({
        account_txs: page.map((t) => ({ account_id: account, transaction_hash: t.transaction.hash, tx_block_height: t.execution_outcome.block_height, ...rolesOf(t, account), is_success: true })),
        resume_token: next,
        txs_count: rows.length,
      });
    }

    if (u.host === "tx.main.fastnear.com" && u.pathname === "/v0/transactions") {
      const hashes = body["tx_hashes"] as string[];
      if (hashes.length > 20) return new Response("Limit is 20", { status: 400 });
      return json({ transactions: hashes.flatMap((h) => byHash.get(h) ?? []) });
    }

    if (u.host === "api.fastnear.com" && u.pathname.startsWith("/v1/public_key/")) {
      const key = decodeURIComponent(u.pathname.slice("/v1/public_key/".length));
      const holders = Object.entries(options.keys).filter(([, ks]) => ks.includes(key)).map(([a]) => a);
      const extra = Array.from({ length: options.extraHolders?.[key] ?? 0 }, (_, i) => `other-holder-${i}.test`);
      return json({ public_key: key, account_ids: [...holders, ...extra] });
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  };
  return { fetch, seen };
};
