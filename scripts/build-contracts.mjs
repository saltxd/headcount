#!/usr/bin/env node
/**
 * Builds the two contracts this workspace compiles to NEAR-deployable wasm: the Headcount contract
 * (crates/headcount) and Sputnik DAO v3.2's NEP-141 test token (crates/test-token), the sandbox's
 * round token. `cargo build --locked` for wasm32 with the pinned Rust 1.86 (rust-toolchain.toml),
 * then the wasm-opt lowering every contract here goes through (scripts/wasm.mjs).
 *
 * One cargo build per contract, on purpose. Built together, cargo would give both one set of
 * near-sdk features, and the token's near-contract-standards turns on `legacy` and `wee_alloc`:
 * Headcount's bytes (even its allocator) would then depend on a test token. Separately, Headcount
 * builds exactly as it does alone, and the two still share one target folder and every dependency
 * whose features match.
 *
 * Output: out/headcount.wasm and out/test_token.wasm, which the sandbox tests deploy.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OUT, ROOT, WASM_RUSTFLAGS, codeHash, lower } from "./wasm.mjs";

const CRATES = [
  { pkg: "headcount", file: "headcount.wasm" },
  { pkg: "test-token", file: "test_token.wasm" },
];
const RELEASE = join(ROOT, "target", "wasm32-unknown-unknown", "release");

for (const { pkg } of CRATES) {
  execFileSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "-p", pkg], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, RUSTFLAGS: WASM_RUSTFLAGS },
  });
}

mkdirSync(OUT, { recursive: true });
console.log();
for (const { file } of CRATES) {
  const built = join(RELEASE, file);
  if (!existsSync(built)) throw new Error(`cargo reported success but ${built} is missing`);
  lower(built, join(OUT, file));
  const bytes = readFileSync(join(OUT, file));
  console.log(`Built out/${file}  ${bytes.length} bytes  code hash ${codeHash(bytes)}`);
}
