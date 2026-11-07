/**
 * The screen's three files (design section 6.3): report.json with every link and its evidence,
 * report.md for people, and verdict.json, the exact argument `post_verdict` takes. The verdict
 * carries the SHA-256 of report.json's bytes, so anyone holding the report can check it is the one
 * the screener posted.
 *
 * Wording, in everything a recipient may read: "created by the same account", "share a full-access
 * key", "sent funds to the same account". The report describes accounts and never the people
 * behind them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Link, Screen, ScreenResult } from "./screen.ts";
import { RULE, byteOrder } from "./types.ts";

export const REPORT_FORMAT = "headcount-screen-report/1";

const LIMITS =
  "The screen sees accounts, not people. A family or a team's own accounts can be linked for good reasons, " +
  "which is why a held group goes to a council vote and is never forfeited.";

const linkJson = (link: Link): object => ({
  signal: link.signal,
  via: link.via,
  accounts: link.accounts,
  evidence: link.evidence,
  detail: link.detail,
});

/** report.json: every fact the verdict rests on, in a fixed order, so the same chain gives the same bytes. */
export const buildReportJson = (screen: Screen): string => {
  const { round, config } = screen;
  const report = {
    format: REPORT_FORMAT,
    rule: RULE,
    round: {
      round_id: round.roundId,
      dao_id: round.daoId,
      token_id: round.tokenId,
      headcount_id: round.headcountId,
      recipients: screen.recipients.length,
    },
    read: { source: screen.source, screened_at_block: screen.screenedAtBlock },
    settings: {
      service_threshold: config.serviceThreshold,
      min_transfer: Object.fromEntries(
        Object.entries(config.minTransfer)
          .sort(([a], [b]) => byteOrder(a, b))
          .map(([asset, amount]) => [asset, amount.toString()]),
      ),
      listed_services: [...config.services].sort((a, b) => byteOrder(a.id, b.id)).map(({ id, why }) => ({ id, why })),
    },
    summary: {
      held_groups: screen.groups.length,
      held_accounts: screen.groups.reduce((n, g) => n + g.accounts.length, 0),
      cleared: screen.cleared.length,
    },
    groups: screen.groups.map((g) => ({
      accounts: g.accounts,
      signals: g.signals,
      evidence: g.evidence,
      links: g.links.map(linkJson),
    })),
    cleared: screen.cleared,
    not_linked: screen.notLinked.map((n) => ({ ...linkJson(n), why: n.why })),
    labels: screen.labels.map(linkJson),
    services_met: screen.services,
    recipients: screen.recipients,
    limits: LIMITS,
  };
  return `${JSON.stringify(report, null, 2)}\n`;
};

/** report.md: the same screen for people, ending with the hash the verdict carries. */
export const buildReportMd = (screen: Screen, reportSha256: string): string => {
  const { round } = screen;
  const held = screen.groups.reduce((n, g) => n + g.accounts.length, 0);
  const lines: string[] = [
    `# Headcount screen of round ${round.roundId}`,
    "",
    `- Rule \`${RULE}\`, read up to block ${screen.screenedAtBlock} (${screen.source})`,
    `- DAO ${round.daoId}, token ${round.tokenId}, ${screen.recipients.length} recipients: ` +
      `${screen.groups.length} groups held (${held} accounts), ${screen.cleared.length} cleared`,
    "",
    LIMITS,
    "",
    "## Held groups",
    "",
  ];
  if (screen.groups.length === 0) lines.push("None: every recipient is cleared.", "");
  for (const [i, group] of screen.groups.entries()) {
    lines.push(`### Group ${i + 1}: ${group.accounts.length} accounts (${group.signals.join(", ")})`, "");
    for (const account of group.accounts) lines.push(`- ${account}`);
    lines.push("", "Why:", "");
    for (const link of group.links) lines.push(`- ${link.detail}. Evidence: ${link.evidence.join(", ")}`);
    const label = screen.labels.find((l) => l.accounts.filter((a) => group.accounts.includes(a)).length >= 2);
    if (label) lines.push(`- Also: ${label.detail} (a label, not a link)`);
    lines.push("");
  }
  lines.push("## Cleared", "");
  if (screen.cleared.length === 0) lines.push("None.");
  for (const account of screen.cleared) lines.push(`- ${account}`);
  lines.push("", "## Seen, but not linked", "");
  if (screen.notLinked.length === 0) lines.push("Nothing.");
  for (const n of screen.notLinked) {
    lines.push(`- ${n.detail}. Not linked: ${n.via === null ? n.why : `${n.via} counts as a service here (${n.why})`}`);
  }
  lines.push("", "## Labels (never a link on their own)", "");
  if (screen.labels.length === 0) lines.push("None.");
  for (const label of screen.labels) lines.push(`- ${label.detail}`);
  const missing = screen.recipients.filter((r) => !r.exists);
  if (missing.length > 0) {
    lines.push("", "## Recipients the chain does not know", "");
    for (const r of missing) lines.push(`- ${r.account} does not exist at block ${screen.screenedAtBlock}`);
  }
  lines.push("", "---", "", `report.json SHA-256: \`${reportSha256}\`. The verdict posted on chain carries this hash.`, "");
  return lines.join("\n");
};

export interface WrittenFiles {
  readonly reportJson: string;
  readonly reportMd: string;
  readonly verdictJson: string;
}

/** Writes report.json, report.md and verdict.json into `dir`, creating it if needed. */
export const writeScreenFiles = (dir: string, result: ScreenResult): WrittenFiles => {
  mkdirSync(dir, { recursive: true });
  const files = {
    reportJson: join(dir, "report.json"),
    reportMd: join(dir, "report.md"),
    verdictJson: join(dir, "verdict.json"),
  };
  writeFileSync(files.reportJson, result.reportJson, "utf8");
  writeFileSync(files.reportMd, result.reportMd, "utf8");
  writeFileSync(files.verdictJson, `${JSON.stringify(result.verdict, null, 2)}\n`, "utf8");
  return files;
};
