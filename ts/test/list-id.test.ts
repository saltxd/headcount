/**
 * Headcount names a round by Trezu's list id, so a treasurer screens the exact list they would give
 * Trezu's bulk payments. These tests hold our TypeScript `listId` to ids that Trezu's own code
 * computed: `generateListId` in NEAR-DevHub/trezu `nt-fe/lib/bulk-payment-api.ts` at commit
 * a6aaaf6742099069634a25fb20c4287a2852dd62, run on synthetic lists (fixtures/trezu-list-ids.json
 * says how). The contract's Rust unit tests check the same file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalListJson, listId, parseTrezuCsv, type Payment } from "../src/list-id.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

interface Vector {
  readonly name: string;
  readonly submitter: string;
  readonly token_id: string;
  readonly timestamp: number;
  readonly payments: readonly Payment[];
  readonly list_id: string;
}

interface Divergence extends Omit<Vector, "list_id"> {
  readonly trezu_backend_list_id: string;
  readonly trezu_frontend_list_id_en_us: string;
}

const fixture = JSON.parse(readFileSync(join(FIXTURES, "trezu-list-ids.json"), "utf8")) as {
  readonly vectors: readonly Vector[];
  readonly frontend_backend_divergence: readonly Divergence[];
};

const input = (v: Omit<Vector, "list_id" | "name">) => ({
  submitter: v.submitter,
  tokenId: v.token_id,
  payments: v.payments,
  timestamp: v.timestamp,
});

test("three list ids match what Trezu's own generateListId computed", () => {
  assert.equal(fixture.vectors.length, 3);
  for (const v of fixture.vectors) {
    assert.equal(listId(input(v)), v.list_id, v.name);
  }
});

test("the canonical JSON is compact, sorted by recipient, keys in alphabetical order", () => {
  const json = canonicalListJson({
    submitter: "dao.test.near",
    tokenId: "native",
    payments: [
      { recipient: "b.test.near", amount: "2" },
      { recipient: "a.test.near", amount: "1" },
    ],
    timestamp: 1794009600000,
  });
  assert.equal(
    json,
    '{"payments":[{"amount":"1","recipient":"a.test.near"},{"amount":"2","recipient":"b.test.near"}],' +
      '"submitter":"dao.test.near","timestamp":1794009600000,"token_id":"native"}',
  );
});

test("where Trezu's frontend and backend disagree, Headcount follows the backend, which verifies ids", () => {
  assert.equal(fixture.frontend_backend_divergence.length, 1);
  for (const d of fixture.frontend_backend_divergence) {
    const ours = listId(input(d));
    assert.equal(ours, d.trezu_backend_list_id, d.name);
    assert.notEqual(ours, d.trezu_frontend_list_id_en_us, "the frontend sorts '_' before '-' (localeCompare)");
  }
});

test("listId refuses inputs the contract would write differently", () => {
  const base = { submitter: "dao.test.near", tokenId: "native", timestamp: 1, payments: [] as Payment[] };
  assert.throws(() => listId({ ...base, payments: [{ recipient: "a.test.near", amount: "010" }] }), /amount/);
  assert.throws(() => listId({ ...base, payments: [{ recipient: "a.test.near", amount: "1.5" }] }), /amount/);
  assert.throws(() => listId({ ...base, timestamp: 1.5 }), /timestamp/);
  assert.throws(() => listId({ ...base, timestamp: -1 }), /timestamp/);
});

test("a Trezu-format CSV becomes the 16 payments of the sandbox round", () => {
  const csv = readFileSync(join(FIXTURES, "round-16.csv"), "utf8");
  const sandbox = fixture.vectors.find((v) => v.submitter === "dao.test.near");
  assert.ok(sandbox, "the fixture has the sandbox round");
  const payments = parseTrezuCsv(csv, 6);
  assert.equal(payments.length, 16);
  assert.deepEqual(payments, sandbox.payments);
  assert.equal(listId({ ...input(sandbox), payments }), sandbox.list_id);
});

test("the CSV parser takes Trezu's two columns, with or without a header", () => {
  assert.deepEqual(parseTrezuCsv("alice.test.near, 10.50\r\n\nbob.test.near,3\n", 6), [
    { recipient: "alice.test.near", amount: "10500000" },
    { recipient: "bob.test.near", amount: "3000000" },
  ]);
  assert.deepEqual(parseTrezuCsv("Recipient,Amount\nalice.test.near,0.000001", 6), [
    { recipient: "alice.test.near", amount: "1" },
  ]);
  assert.deepEqual(parseTrezuCsv("alice.test.near,1.5", 24), [
    { recipient: "alice.test.near", amount: "1500000000000000000000000" },
  ]);
});

test("the CSV parser refuses what it cannot pay exactly", () => {
  assert.throws(() => parseTrezuCsv("alice.test.near,1.0000001", 6), /more than 6 decimals/);
  assert.throws(() => parseTrezuCsv("alice.test.near,0", 6), /greater than zero/);
  assert.throws(() => parseTrezuCsv("alice.test.near,-1", 6), /not an amount/);
  assert.throws(() => parseTrezuCsv("alice.test.near,1e3", 6), /not an amount/);
  assert.throws(() => parseTrezuCsv("Alice.near,1", 6), /not a NEAR account/);
  assert.throws(() => parseTrezuCsv("alice.test.near", 6), /two columns/);
  assert.throws(() => parseTrezuCsv("a.test.near,1\nb.test.near,2\na.test.near,3", 6), /listed twice/);
  assert.throws(() => parseTrezuCsv("recipient,amount\n", 6), /no payments/);
});
