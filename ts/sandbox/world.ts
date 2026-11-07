/**
 * The small world scenario 3 screens (design section 7), planted with a known answer.
 *
 * Sixteen recipients. Twelve of them sit in four planted farms, each linked by exactly one signal:
 *   farm A  5 implicit accounts, each created by a transfer from one account (quinn)      same-funder
 *   farm B  3 named accounts created with one shared full-access key; one of them has
 *           since swapped it for a key of its own, so only its creation shows the link    shared-key
 *   farm C  2 accounts, one of which sent the other 1 NEAR                                 direct-transfer
 *   farm D  2 accounts that both sent tokens to the same account (wes)                     shared-collector
 *
 * The other four must be cleared. Every one of them looks linked at first sight:
 *   - h1, h2: created by a wallet sponsor that funded 60 accounts; they and the other 58 also
 *     carry the wallet's shared recovery key and deposit at the same busy exchange. All three
 *     shapes run through a service.
 *   - uma, vik: both deposit at that exchange and both sent the DAO a donation; uma also tipped
 *     vik 0.001 NEAR, below the 0.01 NEAR the screen counts as material.
 *
 * Names are neutral on purpose: the screen reads the chain, never the names. Every named account
 * is created by the sandbox's root account, which plays the part of NEAR's `near` registrar.
 */

import nearApi from "near-api-js";
import type { KeyPair } from "near-api-js";
import { parseNEAR } from "near-workspaces";
import type { NearAccount } from "near-workspaces";

import type { Rpc } from "../screener/rpc.ts";
import type { Signal } from "../screener/types.ts";
import { tgas } from "./harness.ts";
import { sendAll, type Action, type TxSpec } from "./send.ts";

const { KeyPair: KeyPairClass, transactions } = nearApi;

/** NEAR in yoctoNEAR, as the bigint near-api-js takes. */
export const near = (amount: string): bigint => BigInt(parseNEAR(amount));

/** A named account the root creates; a contract is deployed and initialised in the same transaction. */
export interface NamedSpec {
  readonly name: string;
  readonly balance: bigint;
  readonly keyPair: KeyPair;
  readonly contract?: { readonly wasm: Uint8Array; readonly init: string; readonly args: object };
}

const randomKey = (): KeyPair => KeyPairClass.fromRandom("ed25519");

/** A NEAR implicit account: its id is the hex of its ed25519 public key. */
const implicitOf = (key: KeyPair): string => Buffer.from(key.getPublicKey().data).toString("hex");

/** Creates every spec in one batch from the root account and returns a handle for each, keyed by name. */
export const createNamedAccounts = async (
  rpc: Rpc,
  root: NearAccount,
  specs: readonly NamedSpec[],
): Promise<Record<string, NearAccount>> => {
  const rootKey = await root.getKey();
  if (!rootKey) throw new Error("the sandbox root account has no key in the keystore");
  const txs: TxSpec[] = specs.map((spec) => {
    const actions: Action[] = [
      transactions.createAccount(),
      transactions.transfer(spec.balance),
      transactions.addKey(spec.keyPair.getPublicKey(), transactions.fullAccessKey()),
    ];
    if (spec.contract) {
      actions.push(transactions.deployContract(spec.contract.wasm));
      actions.push(transactions.functionCall(spec.contract.init, spec.contract.args, tgas(100), 0n));
    }
    return { signerId: root.accountId, keyPair: rootKey, receiverId: `${spec.name}.${root.accountId}`, actions, label: `create ${spec.name}` };
  });
  await sendAll(rpc, txs);
  const handles: Record<string, NearAccount> = {};
  for (const spec of specs) {
    const account = root.getSubAccount(spec.name);
    await account.setKey(spec.keyPair);
    handles[spec.name] = account;
  }
  return handles;
};

export interface PlantedFarm {
  readonly name: "A" | "B" | "C" | "D";
  readonly signal: Signal;
  /** In byte order. */
  readonly accounts: readonly string[];
  /** The creator, key or collector the farm shares; null for a direct transfer. */
  readonly via: string | null;
  /** What the screen must cite: the planted transactions, or `key:<public key>`. */
  readonly evidence: readonly string[];
}

export interface World {
  /** The round's sixteen recipients, in the order the CSV lists them. */
  readonly recipients: readonly string[];
  /** The round in Trezu's CSV format, amounts in whole tokens. */
  readonly csv: string;
  /** The planted answer: the groups a correct screen holds, ordered by their first account. */
  readonly farms: readonly PlantedFarm[];
  /** Recipients a correct screen clears, in byte order. */
  readonly cleared: readonly string[];
  readonly sponsor: string;
  readonly exchange: string;
  readonly recoveryKey: string;
  /** How many accounts the sponsor funded. */
  readonly sponsorFunded: number;
}

/** How many accounts the wallet sponsor funds: well above any sensible service threshold. */
const SPONSOR_FUNDED = 60;
/** The sandbox token has 6 decimals, like USDC. */
const TOKEN_UNIT = 1_000_000n;

/** The world's accounts and keys, chosen before anything is sent, so its named accounts can join the caller's batch. */
export interface WorldPlan {
  readonly named: readonly NamedSpec[];
  readonly sharedKey: KeyPair;
  readonly omarFreshKey: KeyPair;
  readonly recoveryKey: KeyPair;
  readonly sponsorFunded: readonly KeyPair[];
  readonly farmA: readonly KeyPair[];
}

export const planWorld = (): WorldPlan => {
  const sharedKey = randomKey();
  const named = (name: string, balance: string, keyPair: KeyPair = randomKey()): NamedSpec => ({ name, balance: near(balance), keyPair });
  return {
    named: [
      named("wallet-sponsor", "80"),
      named("exchange", "5"),
      named("quinn", "15"),
      named("wes", "5"),
      named("kai", "5", sharedKey),
      named("lena", "5", sharedKey),
      named("omar", "5", sharedKey),
      named("nia", "5"),
      named("ravi", "5"),
      named("sol", "5"),
      named("tara", "5"),
      named("uma", "5"),
      named("vik", "5"),
    ],
    sharedKey,
    omarFreshKey: randomKey(),
    recoveryKey: randomKey(),
    sponsorFunded: Array.from({ length: SPONSOR_FUNDED }, randomKey),
    farmA: Array.from({ length: 5 }, randomKey),
  };
};

/**
 * Plays the world's history onto the chain, after `createNamedAccounts` has created the plan's
 * named accounts. `token` must already be deployed; `root` mints and registers on it. Returns the
 * round to screen and the planted answer.
 */
export const seedWorld = async (
  rpc: Rpc,
  plan: WorldPlan,
  ctx: { readonly root: NearAccount; readonly daoId: string; readonly tokenId: string },
): Promise<World> => {
  const rootId = ctx.root.accountId;
  const id = (name: string): string => `${name}.${rootId}`;
  const keyOf = (name: string): KeyPair => {
    const spec = plan.named.find((s) => s.name === name);
    if (!spec) throw new Error(`no planned account ${name}`);
    return spec.keyPair;
  };
  const rootKey = await ctx.root.getKey();
  if (!rootKey) throw new Error("the sandbox root account has no key in the keystore");
  const from = (name: string, receiverId: string, actions: Action[], label: string): TxSpec => ({
    signerId: id(name),
    keyPair: keyOf(name),
    receiverId,
    actions,
    label,
  });
  const pay = (amount: bigint): Action[] => [transactions.transfer(amount)];
  const ftTransfer = (to: string, amount: bigint): Action[] => [
    transactions.functionCall("ft_transfer", { receiver_id: to, amount: String(amount) }, tgas(30), 1n),
  ];
  const sponsorIds = plan.sponsorFunded.map(implicitOf);
  const farmAIds = plan.farmA.map(implicitOf);

  // 1. Accounts come to exist and get their first money; the farms and decoys make their moves.
  const step1: TxSpec[] = [
    ...sponsorIds.map((to, i) => from("wallet-sponsor", to, pay(near("1")), `sponsor funds account ${i + 1}`)),
    ...farmAIds.map((to, i) => from("quinn", to, pay(near("2")), `quinn funds farm A account ${i + 1}`)),
    from("nia", id("ravi"), pay(near("1")), "nia pays ravi (farm C)"),
    from("uma", id("exchange"), pay(near("1")), "uma deposits at the exchange"),
    from("uma", id("vik"), pay(near("0.001")), "uma tips vik 0.001 NEAR"),
    from("uma", ctx.daoId, pay(near("0.5")), "uma donates to the DAO"),
    from("vik", id("exchange"), pay(near("1")), "vik deposits at the exchange"),
    from("vik", ctx.daoId, pay(near("0.5")), "vik donates to the DAO"),
    from(
      "omar",
      id("omar"),
      [
        transactions.addKey(plan.omarFreshKey.getPublicKey(), transactions.fullAccessKey()),
        transactions.deleteKey(plan.sharedKey.getPublicKey()),
      ],
      "omar swaps the shared key for one of its own",
    ),
    ...["sol", "tara"].map((name) => ({
      signerId: rootId,
      keyPair: rootKey,
      receiverId: ctx.tokenId,
      actions: [transactions.functionCall("mint", { account_id: id(name), amount: String(100n * TOKEN_UNIT) }, tgas(30), 0n)],
      label: `mint tokens to ${name}`,
    })),
    {
      signerId: rootId,
      keyPair: rootKey,
      receiverId: ctx.tokenId,
      actions: [transactions.functionCall("storage_deposit", { account_id: id("wes") }, tgas(30), near("0.01"))],
      label: "register wes on the token",
    },
  ];
  const step1Hashes = await sendAll(rpc, step1);
  const hashOf = (label: string): string => {
    const i = step1.findIndex((t) => t.label === label);
    const hash = step1Hashes[i];
    if (hash === undefined) throw new Error(`no transaction labelled ${label}`);
    return hash;
  };

  // 2. What depends on step 1: the sponsor's accounts deposit at the exchange and add the wallet's
  // recovery key; farm D sends its tokens to wes.
  const step2: TxSpec[] = [
    ...plan.sponsorFunded.flatMap((key, i) => [
      { signerId: sponsorIds[i]!, keyPair: key, receiverId: id("exchange"), actions: pay(near("0.5")), label: `sponsored account ${i + 1} deposits` },
      {
        signerId: sponsorIds[i]!,
        keyPair: key,
        receiverId: sponsorIds[i]!,
        actions: [transactions.addKey(plan.recoveryKey.getPublicKey(), transactions.fullAccessKey())],
        label: `sponsored account ${i + 1} adds the wallet's recovery key`,
      },
    ]),
    from("sol", ctx.tokenId, ftTransfer(id("wes"), 50n * TOKEN_UNIT), "sol sends tokens to wes"),
    from("tara", ctx.tokenId, ftTransfer(id("wes"), 40n * TOKEN_UNIT), "tara sends tokens to wes"),
  ];
  const step2Hashes = await sendAll(rpc, step2);
  const step2HashOf = (label: string): string => {
    const hash = step2Hashes[step2.findIndex((t) => t.label === label)];
    if (hash === undefined) throw new Error(`no transaction labelled ${label}`);
    return hash;
  };

  const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = (ids: readonly string[]): string[] => [...ids].sort(byteOrder);
  const [h1, h2] = sponsorIds as [string, string];
  const farms: PlantedFarm[] = [
    {
      name: "A",
      signal: "same-funder",
      accounts: sorted(farmAIds),
      via: id("quinn"),
      evidence: farmAIds.map((_, i) => hashOf(`quinn funds farm A account ${i + 1}`)),
    },
    {
      name: "B",
      signal: "shared-key",
      accounts: sorted(["kai", "lena", "omar"].map(id)),
      via: plan.sharedKey.getPublicKey().toString(),
      evidence: [`key:${plan.sharedKey.getPublicKey().toString()}`],
    },
    { name: "C", signal: "direct-transfer", accounts: sorted(["nia", "ravi"].map(id)), via: null, evidence: [hashOf("nia pays ravi (farm C)")] },
    {
      name: "D",
      signal: "shared-collector",
      accounts: sorted(["sol", "tara"].map(id)),
      via: id("wes"),
      evidence: [step2HashOf("sol sends tokens to wes"), step2HashOf("tara sends tokens to wes")],
    },
  ];
  farms.sort((a, b) => byteOrder(a.accounts[0]!, b.accounts[0]!));

  const recipients = [
    ...farmAIds,
    ...["kai", "lena", "omar", "nia", "ravi", "sol", "tara", "uma", "vik"].map(id),
    h1,
    h2,
  ];
  const amounts = ["12.5", "8", "3.75", "10.5", "6", "9.125", "4", "7.5", "2.25", "11", "5.5", "1.000001", "6.75", "8.4", "3", "15"];
  const csv = ["recipient,amount", ...recipients.map((r, i) => `${r}, ${amounts[i]}`)].join("\n") + "\n";

  return {
    recipients,
    csv,
    farms,
    cleared: sorted([h1, h2, id("uma"), id("vik")]),
    sponsor: id("wallet-sponsor"),
    exchange: id("exchange"),
    recoveryKey: plan.recoveryKey.getPublicKey().toString(),
    sponsorFunded: SPONSOR_FUNDED,
  };
};
