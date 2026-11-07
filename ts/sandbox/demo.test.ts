/**
 * `npm run demo`, run inside `npm test`, so the story a judge runs cannot quietly stop working.
 *
 * ts/demo/story.ts checks every step as it goes; this test runs it with the narration collected
 * rather than printed, and holds its ending to the planted world: four groups held (12 accounts), four
 * cleared, six recipients paid and ten shares returned, and the books closing to the unit.
 *
 * Nothing here touches a network: the sandbox is a local neard with throwaway accounts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDemo } from "../demo/story.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "out");

test("npm run demo tells the whole story and every step checks out", async () => {
  for (const wasm of ["sputnikdao2.wasm", "test_token.wasm", "headcount.wasm"]) {
    assert.ok(existsSync(join(OUT, wasm)), `out/${wasm} is missing. Run npm test, whose pretest builds it.`);
  }
  const lines: string[] = [];
  const result = await runDemo((line = "") => lines.push(line));

  assert.deepEqual(
    [result.groups, result.held, result.cleared, result.paidAccounts, result.returnedAccounts],
    [4, 12, 4, 6, 10],
    "4 groups held (12 accounts), 4 cleared; 6 paid, 10 shares returned",
  );
  assert.equal(result.paid + result.returned, result.total, "paid + returned = funded");
  const steps = lines.filter((l) => /^\d+\. /.test(l));
  assert.equal(steps.length, 10, "ten steps, each with its heading");
  assert.ok(lines.length > 50, "and the narration under each");
  console.log(
    `  DEMO ran end to end in ${result.seconds} s: 10 steps, 4 groups held, 6 recipients paid ` +
      `${result.paid} and ${result.returned} returned of ${result.total} (npm run demo prints the story)`,
  );
});
