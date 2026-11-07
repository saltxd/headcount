/**
 * Trezu's list id, and the CSV Trezu's bulk payments take.
 *
 * A Headcount round is named by the id Trezu would give the same payment list, so a treasurer
 * screens the list they already have. Trezu's formula: the lowercase hex SHA-256 of a compact JSON
 * object with the payments sorted by recipient, its keys in alphabetical order:
 *
 *     {"payments":[{"amount":"<integer>","recipient":"<account>"},...],
 *      "submitter":"<DAO>","timestamp":<integer>,"token_id":"<native | token contract>"}
 *
 * Trezu's backend, which checks every submitted id, sorts recipients in byte order. Its frontend
 * sorts with `localeCompare`, which puts `_` before `-` and `.` and depends on the browser's
 * locale, so the two disagree on some lists. Headcount follows the backend. Account ids are ASCII,
 * where JavaScript's `<` on strings is byte order. fixtures/trezu-list-ids.json holds ids Trezu's
 * own code computed, and both this module and the contract are tested against them.
 */

import { createHash } from "node:crypto";

/** One payment: an account and an amount in the token's smallest unit, as a decimal string. */
export interface Payment {
  readonly recipient: string;
  readonly amount: string;
}

/** The inputs of a list id. `tokenId` is `"native"` for NEAR, as Trezu writes it. */
export interface ListInput {
  readonly submitter: string;
  readonly tokenId: string;
  readonly payments: readonly Payment[];
  /** Trezu uses the list's creation time in milliseconds; to the formula it is any integer. */
  readonly timestamp: number;
}

/** A positive or zero integer with no leading zeros: how the contract writes a `u128`. */
const CANONICAL_AMOUNT = /^(0|[1-9]\d*)$/;

/** NEAR's account id rule (nearcore `AccountId` validation), plus its length bounds. */
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isNearAccount = (id: string): boolean => id.length >= 2 && id.length <= 64 && NEAR_ACCOUNT.test(id);

const byteOrder = (a: Payment, b: Payment): number =>
  a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0;

/** The exact string Trezu hashes. Throws on an input the contract would write differently. */
export const canonicalListJson = (input: ListInput): string => {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new Error(`timestamp must be a non-negative integer, got ${input.timestamp}`);
  }
  for (const p of input.payments) {
    if (!CANONICAL_AMOUNT.test(p.amount)) {
      throw new Error(`amount for ${p.recipient} must be an integer without leading zeros, got "${p.amount}"`);
    }
  }
  return JSON.stringify({
    payments: [...input.payments].sort(byteOrder).map((p) => ({ amount: p.amount, recipient: p.recipient })),
    submitter: input.submitter,
    timestamp: input.timestamp,
    token_id: input.tokenId,
  });
};

/** Trezu's list id for these inputs: lowercase hex SHA-256 of `canonicalListJson`. */
export const listId = (input: ListInput): string =>
  createHash("sha256").update(canonicalListJson(input), "utf8").digest("hex");

/** Whole and fractional digits only: no sign, no exponent, no thousands separators. */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses the CSV Trezu's bulk payments take, `recipient, amount` per line with an optional
 * `recipient,amount` header, into payments in the token's smallest unit. Amounts are in whole
 * tokens (`10.50`); `decimals` is the token's.
 *
 * Where Trezu would round an amount with more decimals than the token has, this refuses it: a
 * payout list should pay exactly what it says. A recipient listed twice is refused too, because a
 * Headcount round pays each account once.
 */
export const parseTrezuCsv = (text: string, decimals: number): Payment[] => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0]?.toLowerCase() ?? "";
  const rows = first.includes("recipient") && first.includes("amount") ? lines.slice(1) : lines;

  const seen = new Set<string>();
  const payments = rows.map((row, i) => {
    const cells = row.split(",").map((cell) => cell.trim());
    const [recipient, amountText] = cells as [string, string | undefined];
    const where = `row ${i + 1} ("${row}")`;
    if (cells.length !== 2 || amountText === undefined) throw new Error(`${where}: need two columns, recipient and amount`);
    if (!isNearAccount(recipient)) throw new Error(`${where}: "${recipient}" is not a NEAR account`);
    if (seen.has(recipient)) throw new Error(`${where}: ${recipient} is listed twice`);
    seen.add(recipient);
    return { recipient, amount: toSmallestUnit(amountText, decimals, where) };
  });
  if (payments.length === 0) throw new Error("the CSV has no payments");
  return payments;
};

const toSmallestUnit = (text: string, decimals: number, where: string): string => {
  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`${where}: "${text}" is not an amount`);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new Error(`${where}: ${text} has more than ${decimals} decimals`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units === 0n) throw new Error(`${where}: the amount must be greater than zero`);
  return units.toString();
};
