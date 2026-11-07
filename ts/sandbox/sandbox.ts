/**
 * Starts the local near-workspaces sandbox every sandbox test and the demo run on.
 *
 * Two changes from near-workspaces' defaults, neither of which changes what runs on chain:
 *   - Blocks every 100 ms instead of neard's default 600 ms. A sandbox call waits for a few blocks,
 *     so this is most of how long the tests take. Gas, fees, storage prices and every protocol rule
 *     are untouched: they come from the genesis and protocol version, not from this setting.
 *   - The sandbox's data folder is removed when it stops (near-workspaces keeps it by default).
 *
 * near-workspaces 5.0.0 runs `neard init` and then starts the node with no hook in between, so the
 * block time is set by wrapping its `start`, which reads `config.json` from the folder `init` wrote.
 * near-workspaces is pinned to that exact version in package.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Worker } from "near-workspaces";
import { SandboxServer } from "near-workspaces/dist/server/server.js";

/** The sandbox's minimum time between blocks. neard's own default is 600 ms. */
export const BLOCK_MS = 100;

interface NeardConfig {
  consensus: { min_block_production_delay: { secs: number; nanos: number } };
}

let wrapped = false;

const setBlockTimeOnStart = (): void => {
  if (wrapped) return;
  wrapped = true;
  const start = SandboxServer.prototype.start;
  SandboxServer.prototype.start = async function (this: SandboxServer): Promise<SandboxServer> {
    const file = join(this.homeDir, "config.json");
    const config = JSON.parse(readFileSync(file, "utf8")) as NeardConfig;
    config.consensus.min_block_production_delay = { secs: 0, nanos: BLOCK_MS * 1_000_000 };
    writeFileSync(file, JSON.stringify(config, null, 2));
    return start.call(this);
  };
};

/**
 * A fresh local sandbox, with its root account `test.near`. Call `tearDown()` when done. Refuses to
 * return a sandbox that is not producing blocks at `BLOCK_MS`, as neard itself reports it.
 */
export const startSandbox = async (): Promise<Worker> => {
  setBlockTimeOnStart();
  const worker = await Worker.init({ rm: true });
  const rpc = worker.provider as unknown as { sendJsonRpc<T>(method: string, params: object): Promise<T> };
  // neard 2.13.4 reports the delay as the text "[secs,nanos]", e.g. "[0,600000000]" by default.
  const config = await rpc.sendJsonRpc<{ min_block_production_delay?: string }>("client_config", {});
  const reported = config.min_block_production_delay ?? "";
  if (reported !== JSON.stringify([0, BLOCK_MS * 1_000_000])) {
    await worker.tearDown();
    throw new Error(`the sandbox reports a minimum block time of ${reported} ([secs,nanos]), not ${BLOCK_MS} ms`);
  }
  return worker;
};
