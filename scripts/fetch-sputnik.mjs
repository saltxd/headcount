#!/usr/bin/env node
/**
 * Puts Sputnik DAO v3.2 (`sputnikdao2`) where the sandbox tests deploy it: the exact bytes the NEAR
 * mainnet factory stores and deploys for v3.2, read with one keyless view call and accepted only if
 * they hash to the factory's recorded code hash.
 *
 * Why these bytes: `sputnik-dao.near` reports `get_default_version` = [3, 2] and
 * `get_default_code_hash` = DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF, and its
 * `get_contracts_metadata` maps that hash to commit 2b0f34a3 of near-daos/sputnik-dao-contract.
 * A plain cargo build of the DAO never matched that hash (Sputnik releases with a reproducible
 * Docker build), so the DAO is fetched, not built. The factory's `get_code(code_hash)` returns what
 * it stores; a bad RPC answer cannot get in, because only bytes with the recorded hash are kept.
 * They are MIT licensed, but fetched rather than committed (out/ and target/ are gitignored), and
 * cached under target/ so later runs make no request.
 *
 * Sputnik's NEP-141 test token, the sandbox's round token, is built from source in this workspace
 * (crates/test-token) by scripts/build-contracts.mjs.
 *
 * Output: out/sputnikdao2.wasm.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { OUT, ROOT, codeHash } from "./wasm.mjs";

const FACTORY_V3_2_CODE_HASH = "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF";
const FACTORY = "sputnik-dao.near";
// Keyless public RPC; one view call per cold cache.
const RPC = "https://free.rpc.fastnear.com";
const CACHE = join(ROOT, "target", "sputnik", "factory-v3.2.wasm");

const fetchFactoryCode = async () => {
  const args = Buffer.from(JSON.stringify({ code_hash: FACTORY_V3_2_CODE_HASH })).toString("base64");
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: FACTORY,
        method_name: "get_code",
        args_base64: args,
      },
    }),
  });
  const body = await response.json();
  if (!Array.isArray(body?.result?.result)) {
    throw new Error(`${FACTORY}.get_code failed: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return Buffer.from(body.result.result);
};

let dao = existsSync(CACHE) ? readFileSync(CACHE) : null;
if (dao === null || codeHash(dao) !== FACTORY_V3_2_CODE_HASH) {
  console.log(`Fetching ${FACTORY}'s stored v3.2 code (${FACTORY_V3_2_CODE_HASH})`);
  dao = await fetchFactoryCode();
  if (codeHash(dao) !== FACTORY_V3_2_CODE_HASH) {
    throw new Error(`${FACTORY} returned code hashing to ${codeHash(dao)}, expected ${FACTORY_V3_2_CODE_HASH}`);
  }
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, dao);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "sputnikdao2.wasm"), dao);
console.log(`Sputnik DAO v3.2: out/sputnikdao2.wasm  ${dao.length} bytes  code hash ${codeHash(dao)} (the factory's)`);
