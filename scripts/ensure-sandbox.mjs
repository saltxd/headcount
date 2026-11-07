#!/usr/bin/env node
/**
 * Puts a neard new enough for Sputnik DAO v3.2 where near-workspaces looks for its sandbox binary.
 *
 * near-workspaces 5.0.0 ships neard 2.6.2 (protocol 77). Sputnik v3.2 is built with near-sdk's
 * `global-contracts` feature, whose host functions arrived in a later protocol, so on 2.6.2 the DAO
 * fails to link: "UnknownImportError { module: "env", name: "promise_batch_action_deploy_global_contract" }".
 * This fetches neard 2.13.4 (protocol 86) from NEAR's official release bucket, the bucket
 * near-sandbox itself downloads from, checks the tarball against the SHA-256 pinned below, and
 * replaces the bundled binary.
 *
 * Unlike a best-effort setup step, a failure here stops the run: the tests need this binary, and a
 * skipped sandbox test is not a passing one.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WANT = "2.13.4";
/** SHA-256 of near-sandbox.tar.gz for each platform, as downloaded on 2026-11-06. */
const TARBALL_SHA256 = {
  "Darwin-arm64": "158cedb02e5a83d51b47c16e13cd04a84abf493f1f38688ee257cb0263450631",
  "Linux-x86_64": "5690a4635172263cf026683f75965cac09dd916912584f12709974fed620163f",
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "node_modules", "near-sandbox", "bin", "near-sandbox");

const platformTriple = () => {
  if (process.platform === "darwin" && process.arch === "arm64") return "Darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "Linux-x86_64";
  throw new Error(`NEAR publishes no near-sandbox build for ${process.platform} ${process.arch}`);
};

const currentVersion = () => {
  if (!existsSync(BIN)) return null;
  try {
    const out = execFileSync(BIN, ["--version"], { encoding: "utf8" });
    return out.match(/release (\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

const current = currentVersion();
if (current === WANT) {
  console.log(`near-sandbox ${WANT} already in place`);
  process.exit(0);
}

const triple = platformTriple();
const url = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${triple}/${WANT}/near-sandbox.tar.gz`;
console.log(`near-sandbox is ${current ?? "missing"}; fetching ${WANT} (Sputnik v3.2 needs protocol >= 83)`);
console.log(`  ${url}`);

const response = await fetch(url);
if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
const tarball = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(tarball).digest("hex");
if (digest !== TARBALL_SHA256[triple]) {
  throw new Error(`near-sandbox.tar.gz has SHA-256 ${digest}, expected ${TARBALL_SHA256[triple]}`);
}

const scratch = mkdtempSync(join(tmpdir(), "near-sandbox-"));
try {
  const file = join(scratch, "near-sandbox.tar.gz");
  writeFileSync(file, tarball);
  execFileSync("tar", ["xzf", file, "-C", scratch]);
  mkdirSync(dirname(BIN), { recursive: true });
  copyFileSync(join(scratch, triple, "near-sandbox"), BIN);
  chmodSync(BIN, 0o755);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const installed = currentVersion();
if (installed !== WANT) throw new Error(`installed near-sandbox reports ${installed}, expected ${WANT}`);
console.log(`installed near-sandbox ${WANT} (tarball SHA-256 checked)`);
