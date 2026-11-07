#!/usr/bin/env node
/**
 * Builds the Headcount contract (crates/headcount) to NEAR-deployable wasm: `cargo build --locked`
 * for wasm32 with the pinned Rust 1.86 (rust-toolchain.toml), then the wasm-opt lowering every
 * contract here goes through (scripts/wasm.mjs).
 *
 * Output: out/headcount.wasm, which the sandbox tests deploy next to Sputnik DAO.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OUT, ROOT, WASM_RUSTFLAGS, codeHash, lower } from "./wasm.mjs";

const FILE = "headcount.wasm";
const built = join(ROOT, "target", "wasm32-unknown-unknown", "release", FILE);

execFileSync(
  "cargo",
  ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "-p", "headcount"],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, RUSTFLAGS: WASM_RUSTFLAGS } },
);
if (!existsSync(built)) throw new Error(`cargo reported success but ${built} is missing`);

mkdirSync(OUT, { recursive: true });
lower(built, join(OUT, FILE));

const bytes = readFileSync(join(OUT, FILE));
console.log(`\nBuilt Headcount: out/${FILE}  ${bytes.length} bytes  code hash ${codeHash(bytes)}`);
