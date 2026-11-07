/**
 * The local board: one static HTML page over finished screens, for a treasurer to read. It is built
 * from the files a screen writes (report.json and run.json) and loads nothing from the network, so
 * it can be opened from a disk or a USB stick. Every account id and reason is escaped.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the board reads from `report.json` (headcount-screen-report/1). */
interface ReportView {
  readonly round: { readonly round_id: string; readonly dao_id: string; readonly token_id: string; readonly recipients: number };
  readonly read: { readonly source: string; readonly screened_at_block: number };
  readonly summary: { readonly held_groups: number; readonly held_accounts: number; readonly cleared: number };
  readonly groups: readonly { readonly accounts: readonly string[]; readonly signals: readonly string[]; readonly links: readonly { readonly detail: string }[] }[];
  readonly not_linked: readonly { readonly detail: string; readonly why: string; readonly via: string | null }[];
  readonly services_met: readonly { readonly id: string; readonly why: string }[];
  readonly limits: string;
}

/** What `run.json` carries beside a report: facts about the run that must not change the report's bytes. */
export interface RunInfo {
  readonly title: string;
  readonly list: string;
  readonly requests: number;
  readonly caveats: readonly string[];
}

export interface BoardEntry {
  readonly report: ReportView;
  readonly run: RunInfo;
}

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const li = (items: readonly string[]): string => (items.length === 0 ? "<p class=none>None.</p>" : `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`);

const entryHtml = ({ report, run }: BoardEntry): string => {
  const e = escapeHtml;
  const verdict =
    report.summary.held_groups === 0
      ? `<span class="pill clear">All ${report.round.recipients} cleared</span>`
      : `<span class="pill held">${report.summary.held_groups} group${report.summary.held_groups === 1 ? "" : "s"} held, ${report.summary.held_accounts} accounts</span>`;
  const groups = report.groups.map(
    (g) =>
      `<b>${e(g.signals.join(", "))}</b>: ${g.accounts.map((a) => `<code>${e(a)}</code>`).join(", ")}` +
      li(g.links.map((l) => e(l.detail))),
  );
  return `<section>
<h2>${e(run.title)} ${verdict}</h2>
<p class=meta>${e(run.list)}. Read up to block ${report.read.screened_at_block}, ${report.round.recipients} accounts, ${run.requests} requests. Source: ${e(report.read.source)}.</p>
<h3>Held groups</h3>${report.groups.length === 0 ? "<p class=none>None. No two of these accounts are linked.</p>" : groups.join("")}
<h3>Seen, but not linked</h3>${li(report.not_linked.map((n) => `${e(n.detail)}. Not linked: ${e(n.why)}`))}
<h3>Services met</h3>${li(report.services_met.map((s) => `<code>${e(s.id)}</code>: ${e(s.why)}`))}
${run.caveats.length === 0 ? "" : `<h3>Where the read stopped early</h3>${li(run.caveats.map(e))}`}
<p class=limits>${e(report.limits)}</p>
</section>`;
};

export const renderBoard = (entries: readonly BoardEntry[]): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Headcount board</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mute:#666;--line:#ddd;--ok:#1a7f37;--hold:#b35900}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mute:#999;--line:#333;--ok:#4ade80;--hold:#f0a050}}
body{margin:0;padding:1rem;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:52rem;margin:0 auto}section{border-top:1px solid var(--line);padding:1rem 0}
h1{font-size:1.4rem}h2{font-size:1.1rem}h3{font-size:.9rem;margin:1rem 0 .2rem;color:var(--mute);text-transform:uppercase}
code{font-size:.85em;word-break:break-all}.meta,.limits,.none{color:var(--mute)}
.pill{font-size:.8rem;border-radius:1em;padding:.1em .7em;border:1px solid currentColor;white-space:nowrap}.clear{color:var(--ok)}.held{color:var(--hold)}
</style></head><body><main>
<h1>Headcount board</h1>
<p class=meta>${entries.length} screen${entries.length === 1 ? "" : "s"}. Read-only: nothing here sends a transaction or holds a key.</p>
${entries.map(entryHtml).join("\n")}
</main></body></html>
`;

/** Reads the screens in `dirs` (each holds report.json and run.json) and writes `board.html` into `outDir`. */
export const writeBoard = (dirs: readonly string[], outDir: string): string => {
  const entries = dirs.map((dir): BoardEntry => {
    for (const name of ["report.json", "run.json"]) if (!existsSync(join(dir, name))) throw new Error(`${dir} has no ${name}; is it a screen's output folder?`);
    return {
      report: JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as ReportView,
      run: JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunInfo,
    };
  });
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "board.html");
  writeFileSync(file, renderBoard(entries), "utf8");
  return file;
};
