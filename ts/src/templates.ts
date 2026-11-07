/**
 * Trezu custom proposal templates: the manifests in templates/, the proposal each one files, and
 * how to point them at a real deployment.
 *
 * Trezu (NEAR DevHub's treasury app) turns a JSON manifest into a form; a member fills it and Trezu
 * files one Sputnik `FunctionCall` proposal. This module follows Trezu's published format
 * (docs/CUSTOM_PROPOSAL_TEMPLATES.md and docs/trezu-custom-proposal-template/SKILL.md in
 * NEAR-DevHub/trezu) and the behaviour of its engine, written here from that description. Trezu
 * publishes no license, so none of its code is copied: fixtures/trezu-template-proposals.json holds
 * what Trezu's own code produced for our manifests, and ts/test/templates.test.ts holds this module
 * to those bytes.
 *
 * How a form value reaches the call (Trezu's rule): in `args`, a string that is exactly one
 * `{{field}}` becomes typed JSON when the field is a `number` (a JSON number), a `bool` (true or
 * false) or `json` (the parsed value); every other value, and any string that composes text around
 * placeholders, stays a string. So u128 amounts stay digit strings and never pass through a float.
 */

/** The sandbox accounts the manifests in templates/ name; `retargetManifest` replaces them. */
export const SANDBOX_HEADCOUNT = "headcount.test.near";
export const SANDBOX_TOKEN = "token.test.near";

export const FIELD_TYPES = ["account", "token", "uint", "amount", "text", "number", "select", "bool", "json"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface ManifestField {
  readonly name: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly default?: unknown;
  readonly help?: string;
  readonly options?: readonly string[];
  readonly validation?: { readonly min?: string; readonly max?: string; readonly pattern?: string };
}

export interface Manifest {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: string;
  readonly summary?: string;
  readonly binding: { readonly receiver_id: string; readonly method_name: string; readonly deposit: string; readonly gas: string };
  readonly fields: readonly ManifestField[];
  readonly args: Readonly<Record<string, unknown>>;
}

/** What a member typed into the form, by field name. */
export type FieldValues = Readonly<Record<string, unknown>>;

/** Sputnik's `FunctionCall` proposal kind, as `add_proposal` takes it. */
export interface FunctionCallKind {
  readonly FunctionCall: {
    readonly receiver_id: string;
    readonly actions: readonly { readonly method_name: string; readonly args: string; readonly deposit: string; readonly gas: string }[];
  };
}

/** The proposal a template files: `add_proposal({ proposal: { description, kind } })`. */
export interface TemplateProposal {
  readonly description: string;
  readonly kind: FunctionCallKind;
}

/** NEAR's account id rule: lowercase parts of letters and digits joined by `-` or `_`, separated by dots. */
export const NEAR_ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const METHOD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLUG = /^[a-zA-Z0-9_-]+$/;
const FIELD_NAME = /^[a-zA-Z0-9_]+$/;
const DIGITS = /^\d+$/;
/** Route names Trezu keeps for its own pages, so no template may take them as its id. */
const RESERVED_IDS = ["create", "new", "about"];
const MAX_PATTERN = 200;

/**
 * A placeholder: `{{name}}`, spaces allowed inside the braces. `{{{{text}}}}` is an escaped literal
 * that renders as `{{text}}` and names no field; it is matched first so its inner braces never count.
 */
const placeholderPattern = (): RegExp => /\{\{\{\{([\s\S]*?)\}\}\}\}|\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
/** A string that is one placeholder and nothing else: the case that resolves to typed JSON. */
const LONE_PLACEHOLDER = /^\{\{([a-zA-Z0-9_]+)\}\}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const stringsIn = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (isObject(value)) for (const item of Object.values(value)) stringsIn(item, out);
  return out;
};

/** The field names `value` references as `{{name}}`, anywhere in its strings. */
export const placeholdersIn = (value: unknown): Set<string> => {
  const names = new Set<string>();
  for (const text of stringsIn(value)) {
    for (const match of text.matchAll(placeholderPattern())) if (match[2]) names.add(match[2]);
  }
  return names;
};

const compiles = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

const defaultFits = (field: ManifestField): boolean => {
  const value = field.default;
  if (value === undefined) return true;
  switch (field.type) {
    case "account":
    case "token":
    case "text":
      return typeof value === "string" && value.length > 0;
    case "uint":
    case "amount":
      return typeof value === "string" && DIGITS.test(value);
    case "number":
      return typeof value === "number";
    case "bool":
      return typeof value === "boolean";
    case "select":
      return typeof value === "string" && (field.options ?? []).includes(value);
    case "json":
      return true;
  }
};

const fieldProblems = (field: ManifestField, at: string): string[] => {
  const problems: string[] = [];
  if (typeof field.name !== "string" || !FIELD_NAME.test(field.name.trim())) problems.push(`${at}.name must be letters, digits or _`);
  if (!nonBlank(field.label)) problems.push(`${at}.label must not be blank`);
  if (!(FIELD_TYPES as readonly string[]).includes(field.type)) {
    problems.push(`${at}.type must be one of ${FIELD_TYPES.join(", ")}`);
    return problems;
  }
  if (field.required !== undefined && typeof field.required !== "boolean") problems.push(`${at}.required must be true or false`);
  if (field.type === "bool" && field.required === true) problems.push(`${at}: required has no meaning on a bool`);
  if (field.help !== undefined && typeof field.help !== "string") problems.push(`${at}.help must be text`);
  const isSelect = field.type === "select";
  const hasOptions = Array.isArray(field.options) && field.options.length > 0 && field.options.every((o) => typeof o === "string");
  if (isSelect && !hasOptions) problems.push(`${at}: a select needs options`);
  if (!isSelect && field.options !== undefined) problems.push(`${at}: only a select takes options`);
  const v = field.validation;
  if (v !== undefined) {
    if (!isObject(v)) problems.push(`${at}.validation must be an object`);
    else {
      for (const bound of ["min", "max"] as const) {
        if (v[bound] !== undefined && !(typeof v[bound] === "string" && DIGITS.test(v[bound]))) {
          problems.push(`${at}.validation.${bound} must be an integer string`);
        }
      }
      if ((v.min !== undefined || v.max !== undefined) && !["uint", "amount", "number"].includes(field.type)) {
        problems.push(`${at}: min and max apply only to uint, amount and number fields`);
      }
      if (v.pattern !== undefined) {
        if (typeof v.pattern !== "string" || v.pattern.length > MAX_PATTERN || !compiles(v.pattern)) {
          problems.push(`${at}.validation.pattern must be a regular expression of at most ${MAX_PATTERN} characters`);
        }
        if (field.type !== "text" && field.type !== "number") problems.push(`${at}: a pattern applies only to text and number fields`);
      }
    }
  }
  if (!defaultFits(field)) problems.push(`${at}.default does not match its type ${field.type}`);
  return problems;
};

/**
 * Every rule of Trezu's manifest format this manifest breaks, as readable lines; none means Trezu
 * accepts it. The rules are the ones Trezu's docs and validator state: version 1, a slug id that is
 * not a reserved route, a real account and method in the binding, deposit and gas as integer strings
 * (yoctoNEAR and gas units, never JSON numbers), well-formed fields with unique names, and every
 * `{{placeholder}}` in `args` and `summary` naming a declared field.
 */
export const checkManifest = (manifest: Manifest): string[] => {
  const m = manifest as unknown as Record<string, unknown>;
  const problems: string[] = [];
  if (m["version"] !== 1) problems.push("version must be 1");
  const id = m["id"];
  if (typeof id !== "string" || !SLUG.test(id.trim())) problems.push("id must be a slug of letters, digits, - or _");
  else if (RESERVED_IDS.includes(id.trim().toLowerCase())) problems.push(`id must not be one of ${RESERVED_IDS.join(", ")}`);
  if (!nonBlank(m["title"])) problems.push("title must not be blank");
  for (const key of ["description", "icon", "summary"]) {
    if (m[key] !== undefined && !nonBlank(m[key])) problems.push(`${key} must not be blank when present`);
  }

  const binding = m["binding"];
  if (!isObject(binding)) problems.push("binding must be an object");
  else {
    const receiver = binding["receiver_id"];
    if (!(nonBlank(receiver) && NEAR_ACCOUNT_ID.test(receiver.trim()))) problems.push("binding.receiver_id must be a NEAR account id");
    const method = binding["method_name"];
    if (!(nonBlank(method) && METHOD_NAME.test(method.trim()))) problems.push("binding.method_name must be a method name");
    for (const key of ["deposit", "gas"]) {
      const value = binding[key];
      if (!(typeof value === "string" && DIGITS.test(value))) problems.push(`binding.${key} must be an integer string`);
    }
  }

  const fields = m["fields"];
  if (!Array.isArray(fields)) problems.push("fields must be an array");
  const list = (Array.isArray(fields) ? fields : []) as ManifestField[];
  list.forEach((field, i) => problems.push(...(isObject(field) ? fieldProblems(field, `fields[${i}]`) : [`fields[${i}] must be an object`])));
  const names = list.map((f) => (isObject(f) ? f.name : undefined));
  if (new Set(names).size !== names.length) problems.push("field names must be unique");

  if (!isObject(m["args"])) problems.push("args must be an object");
  const declared = new Set(names);
  for (const [where, value] of [["args", m["args"]], ["summary", m["summary"]]] as const) {
    for (const name of placeholdersIn(value)) {
      if (!declared.has(name)) problems.push(`${where} uses {{${name}}}, which no field declares`);
    }
  }
  return problems;
};

/** The text a value puts in place of its placeholder. */
const asText = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};

const substitute = (text: string, values: FieldValues): string =>
  text.replace(placeholderPattern(), (_whole, escaped: string | undefined, name: string | undefined) =>
    escaped !== undefined ? `{{${escaped}}}` : asText(values[name ?? ""]),
  );

/** A lone placeholder of a number, bool or json field, as typed JSON; undefined to keep it text. */
const typed = (text: string, values: FieldValues, types: ReadonlyMap<string, FieldType>): { value: unknown } | undefined => {
  const name = LONE_PLACEHOLDER.exec(text)?.[1];
  if (name === undefined) return undefined;
  const raw = values[name];
  switch (types.get(name)) {
    case "bool":
      return { value: typeof raw === "boolean" ? raw : raw === "true" };
    case "number":
      if (typeof raw === "number") return { value: raw };
      if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return { value: Number(raw) };
      return undefined;
    case "json":
      if (typeof raw !== "string" || raw.trim() === "") return undefined;
      try {
        return { value: JSON.parse(raw) as unknown };
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
};

const fill = (template: unknown, values: FieldValues, types: ReadonlyMap<string, FieldType>): unknown => {
  if (typeof template === "string") {
    const value = typed(template, values, types);
    return value === undefined ? substitute(template, values) : value.value;
  }
  if (Array.isArray(template)) return template.map((item) => fill(item, values, types));
  if (isObject(template)) return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v, values, types)]));
  return template;
};

/**
 * The proposal a member files by filling `manifest`'s form with `values`: the binding's call with
 * the filled `args` (JSON, base64 as Sputnik takes it), and the description Trezu writes, whose
 * `[trezu-tmpl:<id>]` tag lets Trezu show which template filed it.
 */
export const buildTemplateProposal = (manifest: Manifest, values: FieldValues): TemplateProposal => {
  const types = new Map(manifest.fields.map((f) => [f.name, f.type] as const));
  const args = fill(manifest.args, values, types);
  const summary = manifest.summary === undefined ? manifest.title : substitute(manifest.summary, values);
  const lines = ["* Proposal Action: custom", `* Template: [trezu-tmpl:${manifest.id}]`];
  if (summary !== "") lines.push(`* Summary: ${summary}`);
  return {
    description: lines.join(" <br>"),
    kind: {
      FunctionCall: {
        receiver_id: manifest.binding.receiver_id,
        actions: [
          {
            method_name: manifest.binding.method_name,
            args: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
            deposit: manifest.binding.deposit,
            gas: manifest.binding.gas,
          },
        ],
      },
    },
  };
};

/** Where a real deployment lives: the Headcount contract, and the token its rounds pay in. */
export interface Deployment {
  readonly headcount: string;
  readonly token: string;
}

/**
 * `manifest` pointed at a real deployment: every value that names the sandbox's Headcount or token
 * account names `to`'s instead. Both must be NEAR account ids; there are no defaults, so a template
 * never points at an account by accident.
 */
export const retargetManifest = (manifest: Manifest, to: Deployment): Manifest => {
  for (const account of [to.headcount, to.token]) {
    if (!NEAR_ACCOUNT_ID.test(account)) throw new Error(`${JSON.stringify(account)} is not a NEAR account id`);
  }
  const swap = (value: unknown): unknown => {
    if (value === SANDBOX_HEADCOUNT) return to.headcount;
    if (value === SANDBOX_TOKEN) return to.token;
    if (Array.isArray(value)) return value.map(swap);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
    return value;
  };
  return { ...manifest, binding: swap(manifest.binding) as Manifest["binding"], args: swap(manifest.args) as Manifest["args"] };
};
