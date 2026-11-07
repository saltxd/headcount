/**
 * The three Trezu custom proposal templates in templates/: each is a manifest Trezu accepts, and
 * the proposal each one files is exactly the proposal Trezu's own engine builds from it.
 *
 * fixtures/trezu-template-proposals.json holds, for each template and a set of form values, the
 * `{ kind, description }` that Trezu's `buildTemplateProposal` returned, and Trezu's own
 * `parseManifest` verdict on the manifest; both were run outside this repository. ts/src/templates.ts
 * must reproduce every vector to the byte, so the demo and the sandbox test file what Trezu would.
 *
 *     npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTemplateProposal,
  checkManifest,
  retargetManifest,
  type FieldValues,
  type Manifest,
  type TemplateProposal,
} from "../src/templates.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATES = join(ROOT, "templates");

const TEMPLATE_IDS = ["headcount-fund-round-usdc", "headcount-name-screener", "headcount-resolve-group"];

interface Vector {
  readonly template: string;
  readonly what: string;
  readonly values: FieldValues;
  readonly proposal: TemplateProposal;
}

interface Fixture {
  readonly manifests: Readonly<Record<string, { readonly sha256: string; readonly trezu_parse_manifest: string }>>;
  readonly vectors: readonly Vector[];
}

const fixture = JSON.parse(readFileSync(join(ROOT, "fixtures", "trezu-template-proposals.json"), "utf8")) as Fixture;

const load = (id: string): Manifest => JSON.parse(readFileSync(join(TEMPLATES, `${id}.json`), "utf8")) as Manifest;

/** SHA-256 of a manifest's JSON with no whitespace, the form the fixture's hashes were taken of. */
const manifestHash = (manifest: unknown): string => createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

const argsOf = (proposal: TemplateProposal): unknown =>
  JSON.parse(Buffer.from(proposal.kind.FunctionCall.actions[0]!.args, "base64").toString("utf8"));

test("templates/ holds the three manifests the design names, each one a manifest Trezu accepts", () => {
  const files = readdirSync(TEMPLATES).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, TEMPLATE_IDS.map((id) => `${id}.json`));
  for (const id of TEMPLATE_IDS) {
    const manifest = load(id);
    assert.equal(manifest.id, id, "the file is named after the template id");
    assert.deepEqual(checkManifest(manifest), [], `${id} breaks no rule of Trezu's manifest format`);
    const recorded = fixture.manifests[id];
    assert.ok(recorded, `the fixture records Trezu's verdict on ${id}`);
    assert.equal(recorded.trezu_parse_manifest, "accepted");
    assert.equal(manifestHash(manifest), recorded.sha256, `${id} is the manifest Trezu's engine was run on`);
  }
});

test("each template files exactly the proposal Trezu's own buildTemplateProposal built from it", () => {
  assert.ok(fixture.vectors.length >= 3);
  for (const id of TEMPLATE_IDS) {
    assert.ok(fixture.vectors.some((v) => v.template === id), `a vector for ${id}`);
  }
  for (const vector of fixture.vectors) {
    assert.deepEqual(buildTemplateProposal(load(vector.template), vector.values), vector.proposal, vector.what);
  }
});

test("the three templates call configure, ft_transfer_call and resolve_group with the arguments the contract takes", () => {
  const byTemplate = (id: string): Vector => fixture.vectors.find((v) => v.template === id)!;

  const name = byTemplate("headcount-name-screener");
  const named = buildTemplateProposal(load(name.template), name.values);
  assert.equal(named.kind.FunctionCall.receiver_id, "headcount.test.near");
  assert.equal(named.kind.FunctionCall.actions[0]!.method_name, "configure");
  assert.deepEqual(argsOf(named), {
    dao_id: "dao.test.near",
    screener_id: "screener.test.near",
    verdict_window_sec: 172_800,
    hold_window_sec: 172_800,
  });

  const fund = byTemplate("headcount-fund-round-usdc");
  const funded = buildTemplateProposal(load(fund.template), fund.values);
  assert.equal(funded.kind.FunctionCall.receiver_id, "token.test.near", "the token's own ft_transfer_call");
  assert.equal(funded.kind.FunctionCall.actions[0]!.method_name, "ft_transfer_call");
  assert.equal(funded.kind.FunctionCall.actions[0]!.deposit, "1", "NEP-141's 1 yoctoNEAR");
  assert.ok(BigInt(funded.kind.FunctionCall.actions[0]!.gas) >= 100_000_000_000_000n, "at least 100 TGas");
  assert.deepEqual(argsOf(funded), {
    receiver_id: "headcount.test.near",
    amount: "114275001",
    msg: "90a14b05d807a3cfd0823c90d3cc04646d2332ffa01bd0687125295f4282d1c5",
  });

  const resolve = byTemplate("headcount-resolve-group");
  const resolved = buildTemplateProposal(load(resolve.template), resolve.values);
  assert.equal(resolved.kind.FunctionCall.actions[0]!.method_name, "resolve_group");
  assert.ok(BigInt(resolved.kind.FunctionCall.actions[0]!.gas) >= 50_000_000_000_000n, "a refund leg needs about 35 TGas");
  assert.deepEqual(argsOf(resolved), {
    round_id: "90a14b05d807a3cfd0823c90d3cc04646d2332ffa01bd0687125295f4282d1c5",
    group: 1,
    decision: { ReleaseOne: { account_id: "r01.test.near" } },
  });
});

test("the decision field takes each of the contract's three decisions, typed as resolve_group reads them", () => {
  const manifest = load("headcount-resolve-group");
  const decisionOf = (text: string): unknown =>
    (argsOf(buildTemplateProposal(manifest, { round_id: "ab".repeat(32), group: "2", decision: text })) as { decision: unknown })
      .decision;
  assert.equal(decisionOf('"ReleaseAll"'), "ReleaseAll");
  assert.equal(decisionOf('"Refund"'), "Refund");
  assert.deepEqual(decisionOf('{"ReleaseOne": {"account_id": "alice.near"}}'), { ReleaseOne: { account_id: "alice.near" } });
  const group = (argsOf(buildTemplateProposal(manifest, { round_id: "ab".repeat(32), group: "2", decision: '"Refund"' })) as {
    group: unknown;
  }).group;
  assert.equal(group, 2, "a number field typed as text still reaches the contract as a JSON number");
});

test("placeholders: a lone number, bool or json field is typed; amounts, text and composed strings stay strings", () => {
  const manifest: Manifest = {
    version: 1,
    id: "typing",
    title: "Typing",
    binding: { receiver_id: "c.near", method_name: "m", deposit: "0", gas: "30000000000000" },
    fields: [
      { name: "n", label: "N", type: "number" },
      { name: "b", label: "B", type: "bool" },
      { name: "j", label: "J", type: "json" },
      { name: "a", label: "A", type: "amount" },
      { name: "t", label: "T", type: "text" },
    ],
    args: { n: "{{n}}", b: "{{b}}", j: "{{j}}", a: "{{a}}", composed: "{{t}}/{{n}}", kept: 7, literal: "{{{{t}}}}", nested: { t: "{{t}}" } },
  };
  assert.deepEqual(checkManifest(manifest), []);
  const args = argsOf(buildTemplateProposal(manifest, { n: "3", b: true, j: '{"x":[1]}', a: "340282366920938463463374607431768211455", t: "hi" }));
  assert.deepEqual(args, {
    n: 3,
    b: true,
    j: { x: [1] },
    a: "340282366920938463463374607431768211455",
    composed: "hi/3",
    kept: 7,
    literal: "{{t}}",
    nested: { t: "hi" },
  });
});

test("checkManifest refuses what Trezu's manifest format refuses", () => {
  const good = load("headcount-name-screener");
  const broken = (change: (m: Record<string, unknown>) => void): string[] => {
    const copy = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    change(copy);
    return checkManifest(copy as unknown as Manifest);
  };
  const binding = (m: Record<string, unknown>) => m["binding"] as Record<string, unknown>;
  const fields = (m: Record<string, unknown>) => m["fields"] as Record<string, unknown>[];
  const cases: [string, (m: Record<string, unknown>) => void][] = [
    ["a placeholder no field declares", (m) => ((m["args"] as Record<string, unknown>)["extra"] = "{{nobody}}")],
    ["a receiver that is not a NEAR account id", (m) => (binding(m)["receiver_id"] = "Headcount Contract")],
    ["a method name with a space", (m) => (binding(m)["method_name"] = "con figure")],
    ["a deposit in NEAR with decimals", (m) => (binding(m)["deposit"] = "0.01")],
    ["gas as a JSON number", (m) => (binding(m)["gas"] = 30_000_000_000_000)],
    ["a reserved id", (m) => (m["id"] = "new")],
    ["an id that is not a slug", (m) => (m["id"] = "name the screener")],
    ["version 2", (m) => (m["version"] = 2)],
    ["options on a field that is not a select", (m) => (fields(m)[0]!["options"] = ["a"])],
    ["a numeric bound on an account field", (m) => (fields(m)[0]!["validation"] = { min: "1" })],
    ["a default that does not match the type", (m) => (fields(m)[2]!["default"] = "172800")],
    ["two fields with one name", (m) => (fields(m)[1]!["name"] = "dao_id")],
    ["required on a bool", (m) => fields(m).push({ name: "ok", label: "OK", type: "bool", required: true })],
    ["an unknown field type", (m) => (fields(m)[0]!["type"] = "address")],
  ];
  for (const [what, change] of cases) {
    assert.ok(broken(change).length > 0, `refused: ${what}`);
  }
});

test("retargetManifest points a template at a real deployment, and leaves no sandbox account behind", () => {
  const to = { headcount: "headcount.example.near", token: "usdc.example.near" };
  for (const id of TEMPLATE_IDS) {
    const retargeted = retargetManifest(load(id), to);
    assert.deepEqual(checkManifest(retargeted), [], id);
    assert.ok(!JSON.stringify(retargeted).includes(".test.near"), `${id} names no sandbox account`);
  }
  const fund = retargetManifest(load("headcount-fund-round-usdc"), to);
  assert.equal(fund.binding.receiver_id, "usdc.example.near");
  assert.equal((fund.args as { receiver_id: string }).receiver_id, "headcount.example.near");
  assert.equal(retargetManifest(load("headcount-resolve-group"), to).binding.receiver_id, "headcount.example.near");
  assert.throws(() => retargetManifest(load("headcount-name-screener"), { headcount: "Not An Account", token: "usdc.example.near" }), /not a NEAR account id/);
});
