/**
 * Mainnet read-only mode: the same screen, read through FastNEAR's keyless endpoints. It sends no
 * transaction and holds no key; it only asks questions, at 2 a second or fewer.
 */

import { fastnearReader } from "./fastnear.ts";
import { createPacedFetch, type PacedFetch } from "./paced-fetch.ts";
import { jsonRpc } from "./rpc.ts";
import { screenRound, DEFAULT_MIN_NEAR, DEFAULT_SERVICE_THRESHOLD, type ScreenResult } from "./screen.ts";
import { NEAR_ASSET, type RoundToScreen, type ScreenConfig, type ServiceEntry } from "./types.ts";
import { FASTNEAR } from "./fastnear.ts";

/**
 * Accounts mainnet's screen never links through, whatever they have done: the registrar that makes
 * top-level accounts, the Sputnik factory that makes every DAO, Trezu's sponsor that pays for new
 * DAOs, and Trezu's bulk-payment contract. The factory's own key is not listed: it is a measured
 * case (the same key on thousands of DAOs, far over the threshold).
 */
export const MAINNET_SERVICES: readonly ServiceEntry[] = [
  { id: "near", why: "NEAR's registrar, which creates top-level accounts for anyone" },
  { id: "sputnik-dao.near", why: "the Sputnik DAO factory, which creates every DAO" },
  { id: "sponsor.trezu.near", why: "Trezu's sponsor, which pays for new treasuries" },
  { id: "bulkpayment.near", why: "Trezu's bulk-payment contract" },
];

export const mainnetConfig = (extra: readonly ServiceEntry[] = []): ScreenConfig => ({
  serviceThreshold: DEFAULT_SERVICE_THRESHOLD,
  minTransfer: { [NEAR_ASSET]: DEFAULT_MIN_NEAR },
  services: [...MAINNET_SERVICES, ...extra],
});

/** Stands in for a round's DAO or Headcount contract when the list did not come from one. */
export const NOT_APPLICABLE = "not-applicable.invalid";

export interface MainnetScreenInput {
  readonly roundId: string;
  readonly daoId: string;
  readonly tokenId: string;
  readonly recipients: readonly string[];
  readonly extraServices?: readonly ServiceEntry[];
  readonly maxRows?: number;
  /** Tests pass a fake; real runs leave it out and get a real paced fetch. */
  readonly fetch?: PacedFetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface MainnetScreen {
  readonly result: ScreenResult;
  /** Where the reader stopped early; empty means it read every account's whole history. */
  readonly caveats: readonly string[];
  readonly requests: number;
}

export const screenMainnet = async (input: MainnetScreenInput): Promise<MainnetScreen> => {
  const paced = input.fetch ?? createPacedFetch();
  const reader = await fastnearReader({
    fetch: paced,
    ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
  });
  const round: RoundToScreen = {
    roundId: input.roundId,
    daoId: input.daoId,
    tokenId: input.tokenId,
    headcountId: NOT_APPLICABLE,
    recipients: input.recipients,
  };
  const result = await screenRound(round, reader, mainnetConfig(input.extraServices));
  return { result, caveats: reader.caveats(), requests: paced.requests };
};

/** A keyless RPC for the CLI's own view calls (a list, the factory's DAOs), paced like the rest. */
export const pacedRpc = (paced: PacedFetch) => jsonRpc(FASTNEAR.rpc, paced);
