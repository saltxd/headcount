#!/usr/bin/env node
/**
 * Prepares Sputnik DAO v3.2 (`sputnikdao2`) and the NEP-141 test token for the sandbox. The DAO is
 * the exact bytes the NEAR mainnet factory stores for v3.2 (fetched with one keyless view call and
 * checked against the factory's recorded code hash); the token is built from source at the commit
 * the factory names for v3.2.
 *
 * Why this commit: `sputnik-dao.near` reports `get_default_version` = [3, 2] and
 * `get_default_code_hash` = DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF, and its
 * `get_contracts_metadata` maps that hash to commit 2b0f34a3 of near-daos/sputnik-dao-contract.
 *
 * Steps:
 *   1. Fetch that one commit with git into target/sputnik/src and check HEAD is the pinned commit.
 *      Git names content by hash, so the checked-out commit id pins every byte of the source.
 *   2. Install Sputnik's own toolchain (its rust-toolchain.toml says Rust 1.86 with the wasm
 *      target) and `cargo build --locked`, so the dependency tree is the one in Sputnik's
 *      Cargo.lock (near-sdk 5.24.1).
 *   3. Lower the post-MVP WebAssembly features NEAR's VM refuses at deploy time, with the same
 *      `wasm-opt` passes as Headcount's own contract (scripts/wasm.mjs). Doing it directly, as
 *      cargo-near does internally, keeps the toolchain to cargo + npm.
 *   4. Print each wasm's NEAR code hash (base58 of its SHA-256) beside the factory's.
 *
 * A plain cargo build of the DAO never matched the factory's hash (Sputnik releases with a
 * reproducible Docker build), which is why the DAO is fetched, not built.
 *
 * Output: out/sputnikdao2.wasm and out/test_token.wasm, which the sandbox tests deploy.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { OUT, ROOT, WASM_RUSTFLAGS, codeHash, lower } from "./wasm.mjs";

const REPO = "https://github.com/near-daos/sputnik-dao-contract.git";
const COMMIT = "2b0f34a3860460f285307ec2ccf36345acbe05a2";
const FACTORY_V3_2_CODE_HASH = "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF";

const SRC = join(ROOT, "target", "sputnik", "src");
const RELEASE = join(SRC, "target", "wasm32-unknown-unknown", "release");

// The DAO is not built here: it is the factory's own stored bytes (step 1b). Only the test token
// is built from source.
const CRATES = [{ pkg: "test-token", file: "test_token.wasm" }];

// Keyless public RPC; one view call per cold cache.
const RPC = "https://free.rpc.fastnear.com";
const FACTORY = "sputnik-dao.near";
const FACTORY_WASM = join(ROOT, "target", "sputnik", "factory-v3.2.wasm");

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: "inherit", ...options });
const read = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();

const headOf = (dir) => {
  try {
    return read("git", ["-C", dir, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

// 1. The source, pinned by commit.
const tracked = (dir) => read("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
if (headOf(SRC) === COMMIT && tracked(SRC) === "") {
  console.log(`Sputnik source already at ${COMMIT}`);
} else {
  console.log(`Fetching near-daos/sputnik-dao-contract at ${COMMIT}`);
  rmSync(SRC, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  run("git", ["-C", SRC, "init", "--quiet"]);
  run("git", ["-C", SRC, "fetch", "--quiet", "--depth", "1", REPO, COMMIT]);
  run("git", ["-C", SRC, "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"]);
}
const head = headOf(SRC);
if (head !== COMMIT) {
  throw new Error(`target/sputnik/src is at ${head}, expected ${COMMIT}`);
}

// 1b. The exact v3.2 bytes: the factory's `get_code(code_hash)` returns what it stores and
// deploys. They are accepted only if their hash is the one the factory records, so a bad RPC
// answer cannot get in. MIT-licensed, but fetched rather than committed (out/ is gitignored).
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

mkdirSync(OUT, { recursive: true });
let dao = existsSync(FACTORY_WASM) ? readFileSync(FACTORY_WASM) : null;
if (dao === null || codeHash(dao) !== FACTORY_V3_2_CODE_HASH) {
  console.log(`Fetching ${FACTORY}'s stored v3.2 code (${FACTORY_V3_2_CODE_HASH})`);
  dao = await fetchFactoryCode();
  if (codeHash(dao) !== FACTORY_V3_2_CODE_HASH) {
    throw new Error(`${FACTORY} returned code hashing to ${codeHash(dao)}, expected ${FACTORY_V3_2_CODE_HASH}`);
  }
  mkdirSync(dirname(FACTORY_WASM), { recursive: true });
  writeFileSync(FACTORY_WASM, dao);
}
writeFileSync(join(OUT, "sputnikdao2.wasm"), dao);

// 2. Sputnik's toolchain, then the two crates, with the wasm flags every contract here gets
// (WASM_RUSTFLAGS in scripts/wasm.mjs says what each flag does).
try {
  run("rustup", ["toolchain", "install", "--no-self-update"], { cwd: SRC });
} catch {
  console.warn("WARN: could not run `rustup toolchain install`; using whichever cargo is on PATH");
}
run(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    ...CRATES.flatMap(({ pkg }) => ["-p", pkg]),
  ],
  { cwd: SRC, env: { ...process.env, RUSTFLAGS: WASM_RUSTFLAGS } },
);

// 3. Lower to what NEAR's VM accepts.
for (const { file } of CRATES) {
  const built = join(RELEASE, file);
  if (!existsSync(built)) throw new Error(`cargo reported success but ${built} is missing`);
  lower(built, join(OUT, file));
}

// 4. What was built.
const rustc = read("rustc", ["--version"], { cwd: SRC });
console.log(`\nSputnik DAO v3.2: factory bytes, code hash ${codeHash(dao)} (the factory's); test token built from ${COMMIT.slice(0, 8)} with ${rustc}:`);
console.log(`  out/sputnikdao2.wasm  ${dao.length} bytes`);
for (const { file } of CRATES) {
  const bytes = readFileSync(join(OUT, file));
  console.log(`  out/${file}  ${bytes.length} bytes  code hash ${codeHash(bytes)}`);
}
