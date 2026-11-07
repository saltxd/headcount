/**
 * The opt-in live check, run by hand: `npm run screen:live`. It reads public DAOs (organizations,
 * never people) from the Sputnik factory on mainnet, screens them at 2 requests a second or fewer,
 * and fails unless the screen finishes and links none of them, because the factory and its key are
 * services. Read-only and keyless; not part of `npm test`, whose tests never touch the network (its
 * build makes one keyless mainnet read, the Sputnik factory bytes).
 *
 *   LIVE_FROM=0 LIVE_COUNT=6 LIVE_MAX_ROWS=100   (the defaults: the first six DAOs, which hold the factory's key)
 *
 * The factory's list only grows, so the same range is the same DAOs next week. A different range can
 * link a pair for a real reason: two DAOs that paid the same account are linked by S5, which is the
 * rule working, not the factory being mistaken for a link (positions 1 to 12 do exactly that: two of
 * those DAOs paid the same account).
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { writeBoard } from "./board.ts";
import { DAO_FACTORY } from "./trezu-list.ts";

/** The key the Sputnik factory gives the DAOs it made early on; thousands of DAOs hold it. */
const FACTORY_KEY = "ed25519:2gtDEwdLuUBawzFLAnCS9gUso3Ph76bRzMpVrtb66f3J";
import { main } from "./cli.ts";
import { readFileSync } from "node:fs";

const env = (name: string, fallback: number): number => {
  const value = process.env[name];
  return value === undefined ? fallback : Number(value);
};

const run = async (): Promise<void> => {
  const from = env("LIVE_FROM", 0);
  const count = env("LIVE_COUNT", 6);
  const out = resolve("out", "live-check");
  const started = Date.now();
  await main(["screen", "--factory-daos", `${from}:${count}`, "--max-rows", String(env("LIVE_MAX_ROWS", 100)), "--out", out]);

  const report = JSON.parse(readFileSync(resolve(out, "report.json"), "utf8")) as {
    summary: { held_groups: number; cleared: number };
    groups: { accounts: string[]; signals: string[]; links: { detail: string }[] }[];
    round: { recipients: number };
    services_met: { id: string; why: string }[];
  };
  const run = JSON.parse(readFileSync(resolve(out, "run.json"), "utf8")) as { requests: number };
  const problems: string[] = [];
  if (report.round.recipients !== count) problems.push(`screened ${report.round.recipients} accounts, expected ${count}`);
  if (report.summary.held_groups !== 0) problems.push(`${report.summary.held_groups} groups were linked; none should be`);
  if (!report.services_met.some((s) => s.id === DAO_FACTORY)) problems.push(`${DAO_FACTORY} was not treated as a service`);
  for (const g of report.groups) console.log(`LINKED ${g.accounts.join(" + ")} (${g.signals.join(", ")}): ${g.links.map((l) => l.detail).join("; ")}`);
  if (from === 0 && !report.services_met.some((s) => s.id === FACTORY_KEY)) problems.push("the factory's key was not treated as a service");
  const seconds = (Date.now() - started) / 1000;
  const rate = run.requests / seconds;
  if (rate > 2) problems.push(`sent ${run.requests} requests in ${seconds.toFixed(0)} s (${rate.toFixed(2)}/s), over 2 a second`);
  console.log(`services met: ${report.services_met.map((s) => `${s.id} (${s.why})`).join("; ")}`);
  console.log(`${run.requests} requests in ${seconds.toFixed(0)} s (${rate.toFixed(2)}/s); board: ${writeBoard([out], out)}`);
  if (problems.length > 0) throw new Error(`live check failed: ${problems.join("; ")}`);
  console.log("live check passed: finished, nothing linked");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
