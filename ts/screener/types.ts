/**
 * What the screen reads, how it is configured, and what it hands the contract.
 *
 * The screen asks a `ChainReader` a few questions about each recipient: who created the account,
 * which full-access keys it holds or was created with, and where it sent money. It asks one more
 * kind of question about whatever two recipients share (a creator, a key, a collector): how many
 * accounts that thing touches, which is how it tells a service from a link. The sandbox reader
 * answers by scanning every block over RPC; a mainnet reader answers from an indexer. The rule
 * that turns answers into held groups does not change between them.
 */

/** The rule the screen applies (design section 6.1), as the verdict names it. */
export const RULE = "hold-linked-v1";

/**
 * S1 same creator or funder, S2 same full-access key, S4 direct transfer, S5 shared collector:
 * each of these links two recipients. S3, the same parent account, only ever labels a group.
 */
export type Signal = "same-funder" | "shared-key" | "direct-transfer" | "shared-collector" | "same-parent";

/** The order a group lists its signals in: the four that link, then the label. */
export const SIGNAL_ORDER: readonly Signal[] = [
  "same-funder",
  "shared-key",
  "direct-transfer",
  "shared-collector",
  "same-parent",
];

/** The asset name a NEAR transfer carries; a token transfer carries its NEP-141 contract. */
export const NEAR_ASSET = "near";

/** Byte order, the order Trezu's list id and the contract sort account ids in (they are ASCII). */
export const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** NEAR implicit (64 hex) and Ethereum-style implicit (0x + 40 hex) accounts: created by a transfer, with no parent. */
export const isImplicit = (id: string): boolean => /^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id);

/** How an account came to exist, as the chain records it. */
export interface Creation {
  /**
   * The account that made it exist: a sub-account's parent; for an account a registrar created
   * (`near` on mainnet), whoever called the registrar; for an implicit account, the sender of the
   * transfer that created it.
   */
  readonly creator: string;
  readonly how: "sub-account" | "via-registrar" | "first-transfer";
  readonly txHash: string;
  readonly blockHeight: number;
  /** Full-access keys it was created with: its creation's AddKey actions, or the key an implicit id spells. */
  readonly initialKeys: readonly string[];
}

/** NEAR or NEP-141 tokens that `from` itself sent to `to`. */
export interface Transfer {
  readonly from: string;
  readonly to: string;
  /** `NEAR_ASSET`, or the token contract. */
  readonly asset: string;
  /** In the asset's smallest unit (yoctoNEAR for NEAR). */
  readonly amount: bigint;
  readonly txHash: string;
  readonly blockHeight: number;
}

/**
 * What a screen reads from the chain. Counting methods stop at `cap`: the screen only needs to
 * know whether a count passes its threshold, and on mainnet every extra count costs requests.
 */
export interface ChainReader {
  /** Where the facts come from, in a few words, for the report. */
  readonly source: string;
  /** The block the facts run up to: the verdict's `screened_at_block`. */
  readonly headHeight: number;
  creation(account: string): Promise<Creation | null>;
  /** Full-access keys the account holds at the head; null if the account does not exist there. */
  fullAccessKeys(account: string): Promise<readonly string[] | null>;
  /** Transfers the account itself sent, NEAR and NEP-141, oldest first. */
  transfersFrom(account: string): Promise<readonly Transfer[]>;
  /** How many accounts `account` created, counted up to `cap`. */
  createdCount(account: string, cap: number): Promise<number>;
  /** How many accounts hold or have held `publicKey` with full access (at creation or since), up to `cap`. */
  keyHolderCount(publicKey: string, cap: number): Promise<number>;
  /** How many distinct accounts sent `account` a transfer that `counts` accepts, up to `cap`. */
  senderCount(account: string, cap: number, counts: (transfer: Transfer) => boolean): Promise<number>;
}

/** An account or key the screen never links through, and why. */
export interface ServiceEntry {
  /** An account id, or a public key such as `ed25519:...`. */
  readonly id: string;
  readonly why: string;
}

export interface ScreenConfig {
  /**
   * A creator or collector that touched more accounts than this, or a key held by more accounts
   * than this, is treated as a service and never links anyone (design section 6.1, "N").
   */
  readonly serviceThreshold: number;
  /**
   * The smallest transfer that counts as material, per asset, in its smallest unit: `near` in
   * yoctoNEAR, a token by its contract. An asset not listed counts at any amount above zero.
   */
  readonly minTransfer: Readonly<Record<string, bigint>>;
  /** Registrars, factories, sponsors and exchanges the screen knows, plus the exclusions file. */
  readonly services: readonly ServiceEntry[];
}

/** A round as the screen needs it: read from Headcount's `get_round`. */
export interface RoundToScreen {
  readonly roundId: string;
  readonly daoId: string;
  /** `native`, or the round's NEP-141 token. */
  readonly tokenId: string;
  /** The Headcount contract the round lives on. */
  readonly headcountId: string;
  readonly recipients: readonly string[];
}

/** One held group, as `post_verdict` takes it (crates/headcount/src/lib.rs, `HeldGroup`). */
export interface HeldGroup {
  readonly accounts: readonly string[];
  readonly signals: readonly string[];
  readonly evidence: readonly string[];
}

/** The verdict `post_verdict` takes (crates/headcount/src/lib.rs, `Verdict`). */
export interface Verdict {
  readonly screened_at_block: number;
  readonly rule: string;
  readonly groups: readonly HeldGroup[];
  readonly report_sha256: string;
  readonly report_url: string | null;
}

/** The bounds `post_verdict` enforces on a verdict (crates/headcount/src/lib.rs, MAX_*). */
export const VERDICT_BOUNDS = {
  maxRuleLen: 64,
  maxSignals: 5,
  maxSignalLen: 32,
  maxEvidence: 32,
  maxEvidenceLen: 128,
} as const;
