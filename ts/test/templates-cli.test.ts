/**
 * `npm run templates`: writes the three manifests pointed at a real deployment, ready to paste into
 * Trezu (New template, Code tab).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkManifest, type Manifest } from "../src/templates.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "ts", "src", "templates-cli.ts");

const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });

test("templates CLI: writes the three manifests for the given Headcount and token, each one valid", () => {
  const out = mkdtempSync(join(tmpdir(), "headcount-templates-"));
  try {
    const result = run("--headcount", "headcount.example.near", "--token", "usdc.example.near", "--out", out);
    assert.equal(result.status, 0, result.stderr);
    const files = readdirSync(out).sort();
    assert.deepEqual(files, ["headcount-fund-round-usdc.json", "headcount-name-screener.json", "headcount-resolve-group.json"]);
    for (const file of files) {
      const manifest = JSON.parse(readFileSync(join(out, file), "utf8")) as Manifest;
      assert.deepEqual(checkManifest(manifest), [], file);
      assert.ok(!JSON.stringify(manifest).includes(".test.near"), `${file} names no sandbox account`);
    }
    assert.match(result.stdout, /headcount\.example\.near/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("templates CLI: refuses to guess either account", () => {
  const missing = run("--headcount", "headcount.example.near");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--token/);
  const bad = run("--headcount", "Headcount!", "--token", "usdc.example.near");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /not a NEAR account id/);
});
