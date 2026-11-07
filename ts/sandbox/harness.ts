/**
 * Helpers shared by the near-workspaces sandbox tests: the DAO policy Trezu gives every treasury,
 * the JSON shapes Sputnik DAO v3.2 takes for a FunctionCall proposal, and a quieter console.
 */

import assert from "node:assert/strict";

import nearApi from "near-api-js";

/**
 * Keeps the test output to the story lines. near-api-js prints every receipt's logs and failures,
 * including each refusal these tests expect (as "Failure"), and near-workspaces echoes every
 * call's contract logs. Library errors still print. Run with NEAR_PRINT_LOGS=1 to see everything.
 */
export const quietSandboxLogs = (): void => {
  if (process.env.NEAR_PRINT_LOGS) return;
  process.env.NEAR_WORKSPACES_NO_LOGS = "1";
  nearApi.utils.Logger.overrideLogger({
    log: () => undefined,
    warn: () => undefined,
    error: (message: unknown, ...rest: unknown[]) => console.error(message, ...rest),
  });
};

/** Sputnik's `VotePolicy`. `threshold` is a vote count (string) or a [num, denom] ratio. */
export interface VotePolicy {
  readonly weight_kind: "RoleWeight" | "TokenWeight";
  readonly quorum: string;
  readonly threshold: string | readonly [number, number];
}

/** Sputnik's `RolePermission`; `kind` here is always a `Group` of named accounts. */
export interface RolePermission {
  readonly name: string;
  readonly kind: { readonly Group: readonly string[] };
  readonly permissions: readonly string[];
  readonly vote_policy: Readonly<Record<string, VotePolicy>>;
}

/** Sputnik's `Policy`, as `new` and `get_policy` take and return it. */
export interface SputnikPolicy {
  readonly roles: readonly RolePermission[];
  readonly default_vote_policy: VotePolicy;
  readonly proposal_bond: string;
  readonly proposal_period: string;
  readonly bounty_bond: string;
  readonly bounty_forgiveness_period: string;
}

/** Who holds each Trezu role, and how many votes each kind of decision needs. */
export interface TrezuRoles {
  /** Trezu "Requestor": files payment and call proposals, cannot approve them. */
  readonly requestors: readonly string[];
  /** Trezu "Governance" (the policy names the role "Admin"): config, policy, members, upgrades. */
  readonly admins: readonly string[];
  /** Trezu "Finance" (the policy names the role "Approver"): votes on payments and calls. */
  readonly approvers: readonly string[];
  /** Approvals a `call` or `transfer` proposal needs: a count, not a ratio. */
  readonly paymentThreshold: number;
  /** Approvals a governance proposal needs: a count, not a ratio. */
  readonly governanceThreshold: number;
}

const SEVEN_DAYS_NS = "604800000000000";

/** The proposal kinds Trezu's Admin role governs, each with its own vote policy. */
const GOVERNANCE_LABELS = [
  "config",
  "policy",
  "add_member_to_role",
  "remove_member_from_role",
  "upgrade_self",
  "upgrade_remote",
  "set_vote_token",
  "add_bounty",
  "bounty_done",
  "factory_info_update",
  "policy_add_or_update_role",
  "policy_remove_role",
  "policy_update_default_vote_policy",
  "policy_update_parameters",
] as const;

const votes = (count: number): VotePolicy => ({
  weight_kind: "RoleWeight",
  quorum: "0",
  threshold: String(count),
});

/**
 * The Sputnik policy Trezu writes when it creates a treasury: three roles, a zero proposal bond and
 * a seven-day voting period. It mirrors `build_policy` in NEAR-DevHub/trezu,
 * `nt-be/src/handlers/treasury/create.rs` (read at commit a6aaaf67 on 2026-11-06), rewritten here
 * rather than copied: the role names, permission strings and thresholds are the same, so a sandbox
 * DAO behaves like a treasury created on trezu.app.
 */
export const trezuPolicy = (r: TrezuRoles): SputnikPolicy => ({
  roles: [
    {
      name: "Requestor",
      kind: { Group: r.requestors },
      permissions: ["call:AddProposal", "transfer:AddProposal", "call:VoteRemove", "transfer:VoteRemove"],
      vote_policy: { transfer: votes(1), call: votes(1) },
    },
    {
      name: "Admin",
      kind: { Group: r.admins },
      permissions: GOVERNANCE_LABELS.map((label) => `${label}:*`),
      vote_policy: Object.fromEntries(GOVERNANCE_LABELS.map((label) => [label, votes(r.governanceThreshold)])),
    },
    {
      name: "Approver",
      kind: { Group: r.approvers },
      permissions: [
        "call:VoteReject",
        "call:VoteApprove",
        "call:RemoveProposal",
        "call:Finalize",
        "transfer:VoteReject",
        "transfer:VoteApprove",
        "transfer:RemoveProposal",
        "transfer:Finalize",
      ],
      vote_policy: { transfer: votes(r.paymentThreshold), call: votes(r.paymentThreshold) },
    },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: "0",
  proposal_period: SEVEN_DAYS_NS,
  bounty_bond: "0",
  bounty_forgiveness_period: SEVEN_DAYS_NS,
});

/** Gas in TGas, as the bigint near-workspaces takes. */
export const tgas = (n: number): bigint => BigInt(n) * 1_000_000_000_000n;

/** JSON arguments as the base64 string a Sputnik `ActionCall.args` holds. */
export const b64json = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

/** One call inside a FunctionCall proposal. Deposit (yoctoNEAR) and gas are decimal strings. */
export interface ActionCall {
  readonly method_name: string;
  readonly args: string;
  readonly deposit: string;
  readonly gas: string;
}

/** Sputnik's `ProposalKind::FunctionCall`: the DAO itself calls `receiver_id` with `actions`. */
export interface FunctionCallKind {
  readonly FunctionCall: {
    readonly receiver_id: string;
    readonly actions: readonly ActionCall[];
  };
}

/**
 * A FunctionCall proposal that has the DAO pay `amount` of a NEP-141 token to `receiverId` with
 * `ft_transfer`, attaching the 1 yoctoNEAR NEP-141 requires. Only the DAO can move the DAO's own
 * tokens, so a balance change proves the DAO made the call.
 */
export const ftTransferKind = (tokenId: string, receiverId: string, amount: string): FunctionCallKind => ({
  FunctionCall: {
    receiver_id: tokenId,
    actions: [
      {
        method_name: "ft_transfer",
        args: b64json({ receiver_id: receiverId, amount }),
        deposit: "1",
        gas: String(tgas(20)),
      },
    ],
  },
});

/**
 * A FunctionCall proposal for one call: the DAO calls `methodName` on `receiverId` with `args`,
 * attaching `deposit` yoctoNEAR and `gasTgas` TGas.
 */
export const callKind = (
  receiverId: string,
  methodName: string,
  args: unknown,
  deposit: bigint,
  gasTgas: number,
): FunctionCallKind => ({
  FunctionCall: {
    receiver_id: receiverId,
    actions: [{ method_name: methodName, args: b64json(args), deposit: String(deposit), gas: String(tgas(gasTgas)) }],
  },
});

/** A proposal as Sputnik's `get_proposal` returns it (the fields these tests read). */
export interface ProposalView {
  readonly id: number;
  readonly proposer: string;
  readonly description: string;
  readonly kind: unknown;
  readonly status: "InProgress" | "Approved" | "Rejected" | "Removed" | "Expired" | "Moved" | "Failed";
  readonly votes: Readonly<Record<string, string>>;
}

/** Asserts that `fn` rejects and the error text contains `needle`; returns the message. */
export const expectReject = async (fn: () => Promise<unknown>, needle: string): Promise<string> => {
  try {
    await fn();
  } catch (error) {
    const message = String((error as Error).message ?? error);
    assert.ok(message.includes(needle), `expected "${needle}" in the rejection, got:\n${message}`);
    return message;
  }
  assert.fail(`expected a rejection containing "${needle}", but the call succeeded`);
};
