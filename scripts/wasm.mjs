/**
 * What every contract this repository builds goes through after cargo: the same wasm-opt lowering
 * and the same code-hash printout, so Sputnik DAO and Headcount are prepared for NEAR's VM alike.
 *
 * Lowering: Rust still emits post-MVP WebAssembly features (sign-extension, reference-types,
 * multivalue) and its precompiled std carries bulk-memory and non-trapping float-to-int, which
 * NEAR's VM refuses at deploy time ("PrepareError: Deserialization"). wasm-opt lowers them, which is
 * what cargo-near does internally (it also runs binaryen).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(ROOT, "out");
const WASM_OPT = join(ROOT, "node_modules", ".bin", "wasm-opt");

/**
 * Flags for the wasm32 cargo build. RUSTFLAGS replaces rustflags from any cargo config file, so
 * nothing outside the command changes how a contract compiles.
 *   --cfg near           near-sdk's on-chain host path, the same flag cargo-near sets; without it
 *                        contract panics trap as a bare `unreachable` and lose their message.
 *   -C target-cpu=mvp    trims post-MVP features up front; wasm-opt lowers what std still carries.
 */
export const WASM_RUSTFLAGS = "--cfg near -C target-cpu=mvp";

const LOWERING = [
  "-Oz",
  "--signext-lowering",
  "--llvm-memory-copy-fill-lowering",
  "--llvm-nontrapping-fptoint-lowering",
  "--disable-reference-types",
  "--disable-multivalue",
  "--strip-target-features",
];

/** Lowers `input` to what NEAR's VM accepts, writing `output`. */
export const lower = (input, output) => {
  execFileSync(WASM_OPT, [input, "-o", output, ...LOWERING], { stdio: "inherit" });
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

/** A contract's NEAR code hash: base58 of the SHA-256 of its wasm. */
export const codeHash = (bytes) => base58(createHash("sha256").update(bytes).digest());
