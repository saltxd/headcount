/**
 * Reading what mainnet holds: a Trezu payment list from `bulkpayment.near` (`view_list`), and the
 * DAOs the Sputnik factory has made (`get_daos`). Both are plain view calls, read-only and keyless.
 */

import { callView, type Rpc } from "./rpc.ts";

export const BULK_PAYMENT = "bulkpayment.near";
export const DAO_FACTORY = "sputnik-dao.near";

/** `bulkpayment.near`'s `PaymentList` (NEAR-DevHub/trezu, contracts/bulk-payment/src/lib.rs), as far as the screen needs it. */
export interface TrezuList {
  readonly listId: string;
  /** The DAO that submitted the list. */
  readonly submitter: string;
  /** `native`, or the token contract. */
  readonly tokenId: string;
  /** `Pending`, `Approved` or `Rejected`. */
  readonly status: string;
  readonly recipients: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const LIST_ID = /^[0-9a-f]{64}$/;

export const fetchTrezuList = async (rpc: Rpc, listId: string): Promise<TrezuList> => {
  if (!LIST_ID.test(listId)) throw new Error(`a Trezu list id is 64 lowercase hex characters, got "${listId}"`);
  const list = await callView(rpc, BULK_PAYMENT, "view_list", { list_id: listId });
  if (!isRecord(list) || !Array.isArray(list["payments"]) || typeof list["submitter"] !== "string" || typeof list["token_id"] !== "string") {
    throw new Error(`${BULK_PAYMENT}.view_list answered with something that is not a payment list`);
  }
  const recipients = list["payments"].map((p: unknown) => {
    if (!isRecord(p) || typeof p["recipient"] !== "string") throw new Error("a payment in the list has no recipient");
    return p["recipient"];
  });
  // The contract writes ListStatus as a bare string ("Pending") in JSON.
  const status = typeof list["status"] === "string" ? list["status"] : "unknown";
  return { listId, submitter: list["submitter"], tokenId: list["token_id"], status, recipients };
};

/** Up to `limit` DAO account ids the factory made, from position `from` (oldest first). */
export const fetchFactoryDaos = async (rpc: Rpc, from: number, limit: number): Promise<readonly string[]> => {
  const daos = await callView(rpc, DAO_FACTORY, "get_daos", { from_index: from, limit });
  if (!Array.isArray(daos) || !daos.every((d): d is string => typeof d === "string")) throw new Error(`${DAO_FACTORY}.get_daos did not answer with a list of accounts`);
  return daos;
};
