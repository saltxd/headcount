/**
 * The command line's parts that need no network: reading account lists, the exclusions file, and
 * the local board page (escaping, and what it says about a clean and a held screen).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderBoard, writeBoard, type BoardEntry } from "../screener/board.ts";
import { main, parseAccounts, readExclusions } from "../screener/cli.ts";

const entry = (over: Partial<BoardEntry["report"]> = {}, caveats: string[] = []): BoardEntry => ({
  report: {
    round: { round_id: "r", dao_id: "d.near", token_id: "native", recipients: 3 },
    read: { source: "FastNEAR keyless", screened_at_block: 77 },
    summary: { held_groups: 0, held_accounts: 0, cleared: 3 },
    groups: [],
    not_linked: [{ detail: "x and y: created by the same account, f.near", why: "f.near counts as a service here", via: "f.near" }],
    services_met: [{ id: "f.near", why: "created more than 20 accounts" }],
    limits: "The screen sees accounts, not people.",
    ...over,
  },
  run: { title: "Three DAOs", list: "an explicit account list", requests: 41, caveats },
});

test("parseAccounts: commas, lines, comments and repeats", () => {
  assert.deepEqual(parseAccounts("a.near, b.near\n# a comment\nc.near # trailing\n\nb.near"), ["a.near", "b.near", "c.near"]);
});

test("readExclusions: a JSON array of id and why, nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  writeFileSync(join(dir, "ok.json"), JSON.stringify([{ id: "x.near", why: "an exchange" }]));
  writeFileSync(join(dir, "bad.json"), JSON.stringify([{ id: "x.near" }]));
  assert.deepEqual(readExclusions(join(dir, "ok.json")), [{ id: "x.near", why: "an exchange" }]);
  assert.throws(() => readExclusions(join(dir, "bad.json")), /JSON array/);
});

test("board: a clean screen says all cleared and keeps services and what was not linked", () => {
  const html = renderBoard([entry()]);
  assert.match(html, /All 3 cleared/);
  assert.match(html, /created more than 20 accounts/);
  assert.match(html, /Not linked: f\.near counts as a service here/);
  assert.doesNotMatch(html, /Where the read stopped early/);
  assert.doesNotMatch(html, /https?:\/\//, "loads nothing from the network");
});

test("board: a held group and a caveat show; hostile text is escaped", () => {
  const html = renderBoard([
    entry(
      {
        summary: { held_groups: 1, held_accounts: 2, cleared: 1 },
        groups: [{ accounts: ["a.near", "<img src=x onerror=alert(1)>"], signals: ["same-funder"], links: [{ detail: "a & b: created by the same account" }] }],
      },
      ["busy.near: only its newest 400 outgoing transactions were read"],
    ),
  ]);
  assert.match(html, /1 group held, 2 accounts/);
  assert.match(html, /Where the read stopped early/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /a &amp; b/);
});

test("board: writeBoard reads screen folders and refuses one that is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  assert.throws(() => writeBoard([dir], join(dir, "out")), /has no report\.json/);
  const e = entry();
  writeFileSync(join(dir, "report.json"), JSON.stringify(e.report));
  writeFileSync(join(dir, "run.json"), JSON.stringify(e.run));
  const file = writeBoard([dir], join(dir, "out"));
  assert.match(readFileSync(file, "utf8"), /Three DAOs/);
});

test("cli: exactly one list source, and an unknown command, are refused before any request", async () => {
  await assert.rejects(() => main(["screen"], () => undefined), /exactly one list source/);
  await assert.rejects(() => main(["screen", "--accounts", "a.near", "--trezu-list", "x"], () => undefined), /exactly one list source/);
  await assert.rejects(() => main(["frobnicate"], () => undefined), /usage/);
  await assert.rejects(() => main(["screen", "--factory-daos", "nope"], () => undefined), /<from>:<n>/);
});
