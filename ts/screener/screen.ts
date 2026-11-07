/**
 * The screen: rule `hold-linked-v1` (design section 6.1).
 *
 * Two recipients are linked when S1, S2, S4 or S5 connects them:
 *   S1 same-funder       the same account created them
 *   S2 shared-key        they hold, or were created with, the same full-access key
 *   S4 direct-transfer   one sent the other a material amount
 *   S5 shared-collector  both sent material amounts to the same account outside the list
 * S3 (same-parent: `x.p.near` and `y.p.near`) never links; it only labels a group already linked.
 *
 * Nothing links through a service: an account or key on the configured list (registrars, the
 * DAO factory, an exclusions file) or one of the round's own (its DAO, token and Headcount
 * contract), a creator that created more accounts than the threshold, a collector that received
 * from more accounts than the threshold, or a key held by more accounts than the threshold. Each
 * such shape is still reported, with the reason it did not link.
 *
 * Groups are the connected components of the links; every group of two or more is held.
 */

import { createHash } from "node:crypto";

import { buildReportJson, buildReportMd } from "./report.ts";
import { mapLimit } from "./rpc.ts";
import {
  NEAR_ASSET,
  RULE,
  SIGNAL_ORDER,
  VERDICT_BOUNDS,
  byteOrder,
  isImplicit,
  type ChainReader,
  type Creation,
  type RoundToScreen,
  type ScreenConfig,
  type ServiceEntry,
  type Signal,
  type Transfer,
  type Verdict,
} from "./types.ts";

/** One shape that connects recipients: a creator, key or collector they share, or a direct transfer. */
export interface Link {
  readonly signal: Signal;
  /** The account or key they share; null for a direct transfer. */
  readonly via: string | null;
  /** The recipients it connects, in byte order. */
  readonly accounts: readonly string[];
  /** Transaction hashes, or `key:<public key>`. */
  readonly evidence: readonly string[];
  /** The connection in plain words, about accounts only. */
  readonly detail: string;
}

/** A shape that would have linked recipients, but runs through a service. */
export interface NotLinked extends Link {
  readonly why: string;
}

export interface Group {
  readonly accounts: readonly string[];
  readonly signals: readonly Signal[];
  /** Every piece of evidence; the verdict carries as many as `post_verdict` accepts. */
  readonly evidence: readonly string[];
  readonly links: readonly Link[];
}

/** What the screen read about one recipient. */
export interface RecipientFacts {
  readonly account: string;
  readonly exists: boolean;
  readonly creation: {
    readonly creator: string;
    readonly how: string;
    readonly tx: string;
    readonly block: number;
    readonly initial_keys: readonly string[];
  } | null;
  readonly full_access_keys: readonly string[];
  readonly material_transfers_out: number;
}

export interface Screen {
  readonly round: RoundToScreen;
  readonly source: string;
  readonly screenedAtBlock: number;
  readonly config: ScreenConfig;
  readonly recipients: readonly RecipientFacts[];
  readonly groups: readonly Group[];
  readonly cleared: readonly string[];
  readonly notLinked: readonly NotLinked[];
  readonly labels: readonly Link[];
  /** Every service the screen met, listed or measured, with why. */
  readonly services: readonly ServiceEntry[];
}

export interface ScreenResult {
  readonly screen: Screen;
  /** The exact report.json text; `verdict.report_sha256` is the SHA-256 of its UTF-8 bytes. */
  readonly reportJson: string;
  readonly reportMd: string;
  readonly verdict: Verdict;
}

/** The design's "N", unless a config says otherwise. */
export const DEFAULT_SERVICE_THRESHOLD = 20;
/** 0.01 NEAR: a transfer below it is a tip or dust, not material. */
export const DEFAULT_MIN_NEAR = 10n ** 22n;
/** Accounts every screen treats as services, whatever the config says. */
const ALWAYS: readonly ServiceEntry[] = [{ id: "system", why: "NEAR's system account, which pays gas refunds" }];

const sortedUnique = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(byteOrder);

/**
 * The account a named account sits under, for S3. A top-level parent (`near`, `tg`, `testnet`)
 * is never a private one: only NEAR's registrar creates top-level accounts, for wallets and apps.
 */
const parentOf = (id: string): string | null => {
  if (isImplicit(id)) return null;
  const parent = id.slice(id.indexOf(".") + 1);
  return id.includes(".") && parent.includes(".") ? parent : null;
};

const ONE_NEAR = 10n ** 24n;
/** An amount in plain words: NEAR in NEAR, a token in its smallest unit. */
const amountText = (t: Transfer): string => {
  if (t.asset !== NEAR_ASSET) return `${t.amount} units of ${t.asset}`;
  const whole = t.amount / ONE_NEAR;
  const fraction = (t.amount % ONE_NEAR).toString().padStart(24, "0").replace(/0+$/, "").slice(0, 6);
  return `${whole}${fraction ? `.${fraction}` : ""} NEAR`;
};

const listText = (ids: readonly string[]): string =>
  ids.length <= 2 ? ids.join(" and ") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;

interface Facts {
  readonly account: string;
  readonly creation: Creation | null;
  readonly keys: readonly string[] | null;
  readonly sent: readonly Transfer[];
}

/** A shape before the service check: a link, unless `why` names a service it runs through. */
interface Candidate extends Link {
  readonly why: () => Promise<string | null>;
}

const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/** Screens a round's recipients and returns the report and the verdict for `post_verdict`. */
export const screenRound = async (round: RoundToScreen, reader: ChainReader, config: ScreenConfig): Promise<ScreenResult> => {
  const recipients = sortedUnique(round.recipients);
  const listed = new Set(recipients);
  const threshold = config.serviceThreshold;

  const listedServices = new Map<string, string>();
  const roundServices: ServiceEntry[] = [
    { id: round.daoId, why: "this round's DAO" },
    { id: round.headcountId, why: "the Headcount contract" },
    ...(round.tokenId === "native" ? [] : [{ id: round.tokenId, why: "this round's token" }]),
  ];
  for (const entry of [...config.services, ...roundServices, ...ALWAYS]) {
    if (!listedServices.has(entry.id)) listedServices.set(entry.id, entry.why);
  }
  const met = new Map<string, string>();
  const meet = (id: string, why: string | null): string | null => {
    if (why !== null) met.set(id, why);
    return why;
  };

  const material = (t: Transfer): boolean => t.amount > 0n && t.amount >= (config.minTransfer[t.asset] ?? 1n);

  const facts: Facts[] = await mapLimit(recipients, 8, async (account) => {
    const [creation, keys, sent] = await Promise.all([
      reader.creation(account),
      reader.fullAccessKeys(account),
      reader.transfersFrom(account),
    ]);
    return { account, creation, keys, sent: sent.filter(material) };
  });

  const measured = new Map<string, string | null>();
  const accountServiceWhy = async (id: string): Promise<string | null> => {
    const listedWhy = listedServices.get(id);
    if (listedWhy !== undefined) return meet(id, listedWhy);
    if (!measured.has(id)) {
      let why: string | null = null;
      if ((await reader.createdCount(id, threshold + 1)) > threshold) why = `created more than ${threshold} accounts`;
      else if ((await reader.senderCount(id, threshold + 1, material)) > threshold) {
        why = `received funds from more than ${threshold} accounts`;
      }
      measured.set(id, why);
    }
    return meet(id, measured.get(id) ?? null);
  };
  const keyServiceWhy = async (key: string): Promise<string | null> => {
    const listedWhy = listedServices.get(key);
    if (listedWhy !== undefined) return meet(key, listedWhy);
    if (!measured.has(key)) {
      measured.set(key, (await reader.keyHolderCount(key, threshold + 1)) > threshold ? `held by more than ${threshold} accounts` : null);
    }
    return meet(key, measured.get(key) ?? null);
  };

  const candidates: Candidate[] = [];

  // S1: recipients created by the same account; a creator that is itself on the list joins them.
  const byCreator = new Map<string, { account: string; creation: Creation }[]>();
  for (const { account, creation } of facts) if (creation) pushTo(byCreator, creation.creator, { account, creation });
  for (const [creator, members] of byCreator) {
    const created = members.map((m) => m.account);
    const accounts = sortedUnique(listed.has(creator) ? [...created, creator] : created);
    if (accounts.length < 2) continue;
    candidates.push({
      signal: "same-funder",
      via: creator,
      accounts,
      evidence: members.map((m) => m.creation.txHash),
      detail: listed.has(creator)
        ? `${listText(created)} ${created.length === 1 ? "was" : "were"} created by ${creator}, which is also on the list`
        : `${listText(created)}: created by the same account, ${creator}`,
      why: () => accountServiceWhy(creator),
    });
  }

  // S2: recipients that hold, or were created with, the same full-access key.
  const byKey = new Map<string, { account: string; now: boolean; creationTx: string | null }[]>();
  for (const f of facts) {
    const now = new Set(f.keys ?? []);
    for (const key of new Set([...now, ...(f.creation?.initialKeys ?? [])])) {
      pushTo(byKey, key, { account: f.account, now: now.has(key), creationTx: f.creation?.txHash ?? null });
    }
  }
  for (const [key, holders] of byKey) {
    if (holders.length < 2) continue;
    const formerly = holders.filter((h) => !h.now);
    candidates.push({
      signal: "shared-key",
      via: key,
      accounts: sortedUnique(holders.map((h) => h.account)),
      evidence: [`key:${key}`, ...formerly.flatMap((h) => (h.creationTx ? [h.creationTx] : []))],
      detail:
        `${listText(holders.map((h) => h.account))} share a full-access key, ${key}` +
        (formerly.length > 0
          ? `; ${listText(formerly.map((h) => h.account))} ${formerly.length === 1 ? "was" : "were"} created with it and no longer ${formerly.length === 1 ? "holds" : "hold"} it`
          : ""),
      why: () => keyServiceWhy(key),
    });
  }

  // S4: one recipient sent another a material amount.
  const byPair = new Map<string, Transfer[]>();
  for (const f of facts) {
    for (const t of f.sent) if (listed.has(t.to) && t.to !== f.account) pushTo(byPair, sortedUnique([f.account, t.to]).join(" "), t);
  }
  for (const [pair, transfers] of byPair) {
    const accounts = pair.split(" ");
    candidates.push({
      signal: "direct-transfer",
      via: null,
      accounts,
      evidence: [...new Set(transfers.map((t) => t.txHash))],
      detail: transfers.map((t) => `${t.from} sent funds to ${t.to} (${amountText(t)})`).join("; "),
      why: async () => {
        const service = accounts.find((a) => listedServices.has(a));
        const why = service === undefined ? null : meet(service, listedServices.get(service) ?? null);
        return why === null ? null : `${service} counts as a service here (${why})`;
      },
    });
  }

  // S5: recipients that sent material amounts to the same account outside the list.
  const byCollector = new Map<string, Map<string, Transfer>>();
  for (const f of facts) {
    for (const t of f.sent) {
      if (listed.has(t.to)) continue;
      const senders = byCollector.get(t.to) ?? new Map<string, Transfer>();
      if (!senders.has(f.account)) senders.set(f.account, t);
      byCollector.set(t.to, senders);
    }
  }
  for (const [collector, senders] of byCollector) {
    if (senders.size < 2) continue;
    const first = [...senders.values()].sort((a, b) => byteOrder(a.from, b.from));
    const accounts = first.map((t) => t.from);
    candidates.push({
      signal: "shared-collector",
      via: collector,
      accounts,
      evidence: first.map((t) => t.txHash),
      detail: `${listText(accounts)}: sent funds to the same account, ${collector}`,
      why: () => accountServiceWhy(collector),
    });
  }

  const links: Link[] = [];
  const notLinked: NotLinked[] = [];
  for (const { why, ...shape } of candidates) {
    const reason = await why();
    if (reason === null) links.push(shape);
    else notLinked.push({ ...shape, why: reason });
  }
  const linkOrder = (a: Link, b: Link): number =>
    SIGNAL_ORDER.indexOf(a.signal) - SIGNAL_ORDER.indexOf(b.signal) ||
    byteOrder(a.accounts[0] ?? "", b.accounts[0] ?? "") ||
    byteOrder(a.via ?? "", b.via ?? "");
  links.sort(linkOrder);
  notLinked.sort(linkOrder);

  // S3: recipients under the same private parent. A label only.
  const labels: Link[] = [];
  const byParent = new Map<string, string[]>();
  for (const account of recipients) {
    const parent = parentOf(account);
    if (parent !== null) pushTo(byParent, parent, account);
  }
  for (const [parent, accounts] of byParent) {
    if (accounts.length < 2 || (await accountServiceWhy(parent)) !== null) continue;
    labels.push({
      signal: "same-parent",
      via: parent,
      accounts,
      evidence: [],
      detail: `${listText(accounts)} are sub-accounts of the same account, ${parent}`,
    });
  }
  labels.sort(linkOrder);

  const groups = groupsOf(recipients, links, labels);
  const inGroup = new Set(groups.flatMap((g) => g.accounts));
  const screen: Screen = {
    round,
    source: reader.source,
    screenedAtBlock: reader.headHeight,
    config,
    recipients: facts.map((f) => ({
      account: f.account,
      exists: f.keys !== null,
      creation: f.creation && {
        creator: f.creation.creator,
        how: f.creation.how,
        tx: f.creation.txHash,
        block: f.creation.blockHeight,
        initial_keys: f.creation.initialKeys,
      },
      full_access_keys: [...(f.keys ?? [])].sort(byteOrder),
      material_transfers_out: f.sent.length,
    })),
    groups,
    cleared: recipients.filter((r) => !inGroup.has(r)),
    notLinked,
    labels,
    services: [...met].map(([id, why]) => ({ id, why })).sort((a, b) => byteOrder(a.id, b.id)),
  };

  const reportJson = buildReportJson(screen);
  const reportSha256 = createHash("sha256").update(reportJson, "utf8").digest("hex");
  const verdict: Verdict = {
    screened_at_block: reader.headHeight,
    rule: RULE,
    groups: groups.map((g) => ({
      accounts: g.accounts,
      signals: g.signals,
      evidence: g.evidence.filter((e) => e.length <= VERDICT_BOUNDS.maxEvidenceLen).slice(0, VERDICT_BOUNDS.maxEvidence),
    })),
    report_sha256: reportSha256,
    report_url: null,
  };
  return { screen, reportJson, reportMd: buildReportMd(screen, reportSha256), verdict };
};

/** The connected components of `links` with two or more recipients, ordered by their first account. */
const groupsOf = (recipients: readonly string[], links: readonly Link[], labels: readonly Link[]): Group[] => {
  const parent = new Map<string, string>(recipients.map((r) => [r, r]));
  const find = (a: string): string => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(a, root);
    return root;
  };
  for (const link of links) {
    const [first, ...rest] = link.accounts;
    if (first === undefined) continue;
    for (const other of rest) parent.set(find(other), find(first));
  }
  const members = new Map<string, string[]>();
  for (const r of recipients) pushTo(members, find(r), r);

  const groups: Group[] = [];
  for (const accounts of members.values()) {
    if (accounts.length < 2) continue;
    const inside = new Set(accounts);
    const own = links.filter((l) => inside.has(l.accounts[0] ?? ""));
    const labelled = labels.some((l) => l.accounts.filter((a) => inside.has(a)).length >= 2);
    const signals = SIGNAL_ORDER.filter((s) => own.some((l) => l.signal === s) || (s === "same-parent" && labelled));
    groups.push({ accounts, signals, evidence: [...new Set(own.flatMap((l) => l.evidence))], links: own });
  }
  return groups.sort((a, b) => byteOrder(a.accounts[0] ?? "", b.accounts[0] ?? ""));
};
