#!/usr/bin/env node
/**
 * Builds Sputnik DAO v3.2 (`sputnikdao2`) and the NEP-141 test token from source, at the exact
 * commit the NEAR mainnet factory names for v3.2.
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
 *   3. Lower the post-MVP WebAssembly features NEAR's VM refuses at deploy time ("PrepareError:
 *      Deserialization"). Rust still emits sign-extension, reference-types and multivalue, and its
 *      precompiled std carries bulk-memory and non-trapping float-to-int; `wasm-opt` lowers them,
 *      which is what cargo-near does internally (it also runs binaryen). Doing it directly keeps
 *      the toolchain to cargo + npm.
 *   4. Print each wasm's NEAR code hash (base58 of its SHA-256) beside the factory's.
 *
 * This is an ordinary cargo build, not Sputnik's reproducible Docker build, so the code hash
 * differs from the factory's: the source is identical, the compiler environment is not.
 *
 * Output: out/sputnikdao2.wasm and out/test_token.wasm, which the sandbox tests deploy.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/near-daos/sputnik-dao-contract.git";
const COMMIT = "2b0f34a3860460f285307ec2ccf36345acbe05a2";
const FACTORY_V3_2_CODE_HASH = "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "target", "sputnik", "src");
const RELEASE = join(SRC, "target", "wasm32-unknown-unknown", "release");
const OUT = join(ROOT, "out");
const WASM_OPT = join(ROOT, "node_modules", ".bin", "wasm-opt");

const CRATES = [
  { pkg: "sputnikdao2", file: "sputnikdao2.wasm" },
  { pkg: "test-token", file: "test_token.wasm" },
];

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: "inherit", ...options });
const read = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();

const headOf = (dir) => {
  try {
    return read("git", ["-C", dir, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (bytes) => {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) out += "1";
  for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58[digits[i]];
  return out;
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

// 2. Sputnik's toolchain, then the two crates. RUSTFLAGS replaces any rustflags from cargo config
// files, so nothing outside the checkout changes how Sputnik compiles.
//   --cfg near           near-sdk's on-chain host path, the same flag cargo-near sets; without it
//                        contract panics trap as a bare `unreachable` and lose their message.
//   -C target-cpu=mvp    trims post-MVP features up front; wasm-opt lowers what std still carries.
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
  { cwd: SRC, env: { ...process.env, RUSTFLAGS: "--cfg near -C target-cpu=mvp" } },
);

// 3. Lower to what NEAR's VM accepts.
mkdirSync(OUT, { recursive: true });
const LOWERING = [
  "-Oz",
  "--signext-lowering",
  "--llvm-memory-copy-fill-lowering",
  "--llvm-nontrapping-fptoint-lowering",
  "--disable-reference-types",
  "--disable-multivalue",
  "--strip-target-features",
];
for (const { file } of CRATES) {
  const built = join(RELEASE, file);
  if (!existsSync(built)) throw new Error(`cargo reported success but ${built} is missing`);
  run(WASM_OPT, [built, "-o", join(OUT, file), ...LOWERING]);
}

// 4. What was built.
const rustc = read("rustc", ["--version"], { cwd: SRC });
console.log(`\nBuilt Sputnik DAO v3.2 from ${COMMIT.slice(0, 8)} with ${rustc}:`);
for (const { file } of CRATES) {
  const bytes = readFileSync(join(OUT, file));
  const codeHash = base58(createHash("sha256").update(bytes).digest());
  console.log(`  out/${file}  ${bytes.length} bytes  code hash ${codeHash}`);
}
console.log(`  mainnet factory v3.2 code hash ${FACTORY_V3_2_CODE_HASH} (Sputnik's reproducible Docker build)`);
