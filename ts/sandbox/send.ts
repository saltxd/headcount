/**
 * Sends many sandbox transactions at once.
 *
 * near-workspaces sends one transaction and waits for it, about 1.5 s each in this sandbox. A
 * seeded world needs a few hundred, so this signs them with explicit nonces (consecutive per key,
 * in the order given), submits them all without waiting, and then waits for every one to be final.
 * Transactions from one key reach the node in nonce order, so they can share a block.
 */

import nearApi from "near-api-js";
import type { KeyPair, transactions as nearTransactions } from "near-api-js";

import { RpcError, mapLimit, type Rpc } from "../screener/rpc.ts";

const { transactions, InMemorySigner, utils } = nearApi;

export type Action = nearTransactions.Action;

export interface TxSpec {
  readonly signerId: string;
  readonly keyPair: KeyPair;
  readonly receiverId: string;
  readonly actions: readonly Action[];
  /** Named in the error if this transaction fails. */
  readonly label: string;
}

interface Outcome {
  readonly status: Record<string, unknown> | string;
}

interface FinalTx {
  readonly status: Record<string, unknown>;
  readonly receipts_outcome: readonly { readonly outcome: Outcome }[];
}

const NETWORK = "sandbox";
/** How long to keep asking for one transaction's final outcome. */
const WAIT_MS = 60_000;

const failureOf = (status: Outcome["status"]): unknown =>
  typeof status === "object" && status !== null && "Failure" in status ? status["Failure"] : undefined;

const waitFinal = async (rpc: Rpc, hash: string, signerId: string): Promise<FinalTx> => {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    try {
      return await rpc.call<FinalTx>("tx", { tx_hash: hash, sender_account_id: signerId, wait_until: "FINAL" });
    } catch (error) {
      const transient = error instanceof RpcError && (error.causeName === "TIMEOUT_ERROR" || error.causeName === "UNKNOWN_TRANSACTION");
      if (!transient || Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
};

/**
 * Signs, submits and waits for `specs`. Returns their hashes in the order given, once every one is
 * final; throws, naming the transaction, if any transaction or any of its receipts failed.
 */
export const sendAll = async (rpc: Rpc, specs: readonly TxSpec[]): Promise<string[]> => {
  const nonces = new Map<string, bigint>();
  for (const spec of specs) {
    const key = `${spec.signerId} ${spec.keyPair.getPublicKey().toString()}`;
    if (nonces.has(key)) continue;
    const view = await rpc.call<{ nonce: number }>("query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: spec.signerId,
      public_key: spec.keyPair.getPublicKey().toString(),
    });
    nonces.set(key, BigInt(view.nonce));
  }
  const block = await rpc.call<{ header: { hash: string } }>("block", { finality: "final" });
  const blockHash = utils.serialize.base_decode(block.header.hash);

  const signed: { hash: string; base64: string; spec: TxSpec }[] = [];
  for (const spec of specs) {
    const publicKey = spec.keyPair.getPublicKey();
    const key = `${spec.signerId} ${publicKey.toString()}`;
    const nonce = (nonces.get(key) ?? 0n) + 1n;
    nonces.set(key, nonce);
    const tx = transactions.createTransaction(spec.signerId, publicKey, spec.receiverId, nonce, [...spec.actions], blockHash);
    const signer = await InMemorySigner.fromKeyPair(NETWORK, spec.signerId, spec.keyPair);
    const [hash, signedTx] = await transactions.signTransaction(tx, signer, spec.signerId, NETWORK);
    signed.push({ hash: utils.serialize.base_encode(hash), base64: Buffer.from(signedTx.encode()).toString("base64"), spec });
  }

  for (const { base64, spec } of signed) {
    try {
      await rpc.call("send_tx", { signed_tx_base64: base64, wait_until: "NONE" });
    } catch (error) {
      throw new Error(`${spec.label}: refused on submit: ${String(error)}`);
    }
  }

  await mapLimit(signed, 16, async ({ hash, spec }) => {
    const final = await waitFinal(rpc, hash, spec.signerId);
    const failures = [failureOf(final.status), ...final.receipts_outcome.map((r) => failureOf(r.outcome.status))].filter(
      (f) => f !== undefined,
    );
    if (failures.length > 0) throw new Error(`${spec.label}: failed: ${JSON.stringify(failures[0])}`);
  });
  return signed.map((s) => s.hash);
};
