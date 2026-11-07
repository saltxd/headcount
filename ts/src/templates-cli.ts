/**
 * Writes the three Trezu templates in templates/ pointed at a real deployment, ready to paste into
 * Trezu (open the DAO, Custom, New template, Code tab). Authoring a template there needs the DAO's
 * ChangePolicy permission.
 *
 *     npm run templates -- --headcount <Headcount contract> --token <round token> [--out <folder>]
 *
 * Both accounts are required: the manifests in templates/ name the sandbox's accounts, and nothing
 * here guesses a real one. A NEAR round cannot be a template (Trezu fixes a template's deposit, and a
 * NEAR round's deposit is its total), so it is funded with a FunctionCall proposal of its own.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { checkManifest, retargetManifest, type Manifest } from "./templates.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATES = join(ROOT, "templates");

const main = (): void => {
  const { values } = parseArgs({
    options: { headcount: { type: "string" }, token: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  for (const flag of ["headcount", "token"] as const) {
    if (!values[flag]) throw new Error(`--${flag} <account> is required: the templates are not pointed at any account by default`);
  }
  const out = values.out ?? join(ROOT, "out", "templates");
  mkdirSync(out, { recursive: true });
  for (const file of readdirSync(TEMPLATES).filter((f) => f.endsWith(".json")).sort()) {
    const manifest = JSON.parse(readFileSync(join(TEMPLATES, file), "utf8")) as Manifest;
    const retargeted = retargetManifest(manifest, { headcount: values.headcount!, token: values.token! });
    const problems = checkManifest(retargeted);
    if (problems.length > 0) throw new Error(`${file}: ${problems.join("; ")}`);
    const path = join(out, file);
    writeFileSync(path, `${JSON.stringify(retargeted, null, 2)}\n`);
    console.log(`${relative(process.cwd(), path) || path}: "${retargeted.title}", calls ${retargeted.binding.receiver_id}.${retargeted.binding.method_name}`);
  }
  console.log(`Headcount: ${values.headcount}; round token: ${values.token}. Paste each file into Trezu: New template, Code tab.`);
};

try {
  main();
} catch (error) {
  console.error(`templates: ${(error as Error).message}`);
  process.exit(1);
}
