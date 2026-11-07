/**
 * The screener's command line, for mainnet read-only mode.
 *
 *   screen --trezu-list <list id>        the recipients of a Trezu bulk-payment list
 *   screen --accounts a.near,b.near      or an explicit list (--accounts-file reads one id per line)
 *   screen --factory-daos <from>:<n>     or n public DAOs the Sputnik factory made, from position `from`
 *     --out <dir>                        where the three screen files, run.json and board.html go (default out/screens/<name>)
 *     --max-rows <n>                     transactions read per account and role (default 400)
 *     --exclusions <file>                JSON [{"id": "...", "why": "..."}] of accounts and keys never to link through
 *   board [--out dir] <dir>...           one board.html over finished screen folders (default out/board)
 *
 * Read-only: no transaction, no key. 2 requests a second at most, keyless FastNEAR hosts only.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { writeBoard, type RunInfo } from "./board.ts";
import { NOT_APPLICABLE, pacedRpc, screenMainnet } from "./mainnet.ts";
import { createPacedFetch } from "./paced-fetch.ts";
import { writeScreenFiles } from "./report.ts";
import { fetchFactoryDaos, fetchTrezuList } from "./trezu-list.ts";
import type { ServiceEntry } from "./types.ts";

export interface ScreenTarget {
  readonly roundId: string;
  readonly daoId: string;
  readonly tokenId: string;
  readonly recipients: readonly string[];
  readonly title: string;
  readonly list: string;
}

const isServiceEntry = (v: unknown): v is ServiceEntry =>
  typeof v === "object" && v !== null && typeof (v as ServiceEntry).id === "string" && typeof (v as ServiceEntry).why === "string";

export const readExclusions = (path: string): ServiceEntry[] => {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every(isServiceEntry)) throw new Error(`${path} must be a JSON array of {"id": "...", "why": "..."}`);
  return parsed;
};

/** Accounts from a comma-separated list or a file with one id per line (blank lines and # comments skipped). */
export const parseAccounts = (text: string): string[] =>
  [...new Set(text.split(/[\n,]/).map((s) => s.replace(/#.*/, "").trim()).filter((s) => s !== ""))];

const usage = "usage: screen (--trezu-list <id> | --accounts <a,b,..> | --accounts-file <file> | --factory-daos <from>:<n>) [--out dir] [--max-rows n] [--exclusions file]\n       board [--out dir] <dir>...";

/** Runs the CLI; returns the process exit code. `log` is where progress goes. */
export const main = async (argv: readonly string[], log: (line: string) => void = console.log): Promise<number> => {
  const [command, ...rest] = argv;
  if (command === "board") {
    const { values: opts, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { out: { type: "string" } } });
    if (positionals.length === 0) throw new Error(usage);
    log(`wrote ${writeBoard(positionals, resolve(opts.out ?? join("out", "board")))}`);
    return 0;
  }
  if (command !== "screen") throw new Error(usage);

  const { values } = parseArgs({
    args: rest,
    options: {
      "trezu-list": { type: "string" },
      accounts: { type: "string" },
      "accounts-file": { type: "string" },
      "factory-daos": { type: "string" },
      out: { type: "string" },
      "max-rows": { type: "string" },
      exclusions: { type: "string" },
    },
  });
  const sources = ["trezu-list", "accounts", "accounts-file", "factory-daos"].filter((k) => values[k as keyof typeof values] !== undefined);
  if (sources.length !== 1) throw new Error(`give exactly one list source\n${usage}`);

  const paced = createPacedFetch();
  const rpc = pacedRpc(paced);
  let target: ScreenTarget;
  if (values["trezu-list"] !== undefined) {
    const list = await fetchTrezuList(rpc, values["trezu-list"]);
    target = {
      roundId: list.listId,
      daoId: list.submitter,
      tokenId: list.tokenId,
      recipients: list.recipients,
      title: `Trezu list ${list.listId.slice(0, 12)}`,
      list: `Trezu list ${list.listId} (${list.status}) submitted by ${list.submitter}, token ${list.tokenId}`,
    };
  } else if (values["factory-daos"] !== undefined) {
    const [from, count] = values["factory-daos"].split(":").map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(count) || (count as number) < 1) throw new Error("--factory-daos takes <from>:<n>, such as 1000:20");
    const daos = await fetchFactoryDaos(rpc, from as number, count as number);
    target = {
      roundId: `factory-daos-${from}-${count}`,
      daoId: NOT_APPLICABLE,
      tokenId: "native",
      recipients: daos,
      title: `${daos.length} public DAOs`,
      list: `the ${daos.length} DAOs sputnik-dao.near made from position ${from}`,
    };
  } else {
    const text = values.accounts !== undefined ? values.accounts : readFileSync(values["accounts-file"] as string, "utf8");
    const recipients = parseAccounts(text);
    target = { roundId: "accounts", daoId: NOT_APPLICABLE, tokenId: "native", recipients, title: `${recipients.length} accounts`, list: "an explicit account list" };
  }
  if (target.recipients.length === 0) throw new Error("the list has no recipients");

  log(`screening ${target.recipients.length} accounts, at most 2 requests a second; this takes a while`);
  const screened = await screenMainnet({
    roundId: target.roundId,
    daoId: target.daoId,
    tokenId: target.tokenId,
    recipients: target.recipients,
    fetch: paced,
    ...(values["max-rows"] === undefined ? {} : { maxRows: Number(values["max-rows"]) }),
    ...(values.exclusions === undefined ? {} : { extraServices: readExclusions(values.exclusions) }),
  });

  const outDir = resolve(values.out ?? join("out", "screens", target.roundId.slice(0, 24)));
  writeScreenFiles(outDir, screened.result);
  const run: RunInfo = { title: target.title, list: target.list, requests: screened.requests, caveats: screened.caveats };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  const board = writeBoard([outDir], outDir);

  const { screen } = screened.result;
  log(`${screen.groups.length} groups held, ${screen.cleared.length} of ${screen.recipients.length} cleared, ${screened.requests} requests`);
  for (const c of screened.caveats) log(`note: ${c}`);
  log(`wrote ${outDir} (report.md, report.json, verdict.json, run.json) and ${board}`);
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
