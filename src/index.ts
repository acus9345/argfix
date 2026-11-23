import { checkJsonSchema, type Problem } from "./json-schema.js";

export type Path = (string | number)[];

export type Rule =
  | "trim"
  | "string-to-number"
  | "string-to-boolean"
  | "string-to-null"
  | "json-string"
  | "enum-case"
  | "number-to-string"
  | "number-to-boolean"
  | "boolean-to-string"
  | "to-json-string"
  | "wrap-array"
  | "unwrap-array"
  | "drop-null";

export interface Change {
  /** Where the value sits, such as `["filters", 0, "limit"]`. Empty for the whole input. */
  path: Path;
  from: unknown;
  /** `undefined` when the key was removed. */
  to: unknown;
  rule: Rule;
}

export interface Issue {
  path: Path;
  message: string;
}

export interface CoerceResult {
  /** True when the fixed value passes the schema. */
  ok: boolean;
  /** The fixed input. The original is never changed. */
  value: unknown;
  /** What a Standard Schema returned for the fixed value, with its defaults and transforms. */
  output?: unknown;
  /** Every fix, in the order it was made. */
  changes: Change[];
  /** What's still wrong. Empty when `ok`. */
  issues: Issue[];
}

export interface CoerceOptions {
  /** Rules to leave out. */
  skip?: Rule[];
  /** Stop after this many fixes. Default 100. */
  maxChanges?: number;
}

/** The part of Standard Schema that argfix uses. Zod, Valibot, ArkType and others all have it. */
export interface StandardSchema {
  "~standard": {
    validate(value: unknown): StandardResult | PromiseLike<StandardResult>;
  };
}

interface StandardResult {
  value?: unknown;
  issues?: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined }> | undefined;
}

export type JsonSchema = boolean | { [keyword: string]: unknown };

interface Checked {
  problems: Problem[];
  output?: unknown;
}

interface Candidate {
  rule: Rule;
  value: unknown;
  drop?: boolean;
}

type Check = (value: unknown) => Checked | PromiseLike<Checked>;

/** Fix `value` to match `schema`. Takes any Standard Schema or a JSON Schema. */
export async function coerce(schema: StandardSchema | JsonSchema, value: unknown, options: CoerceOptions = {}): Promise<CoerceResult> {
  const steps = repair(checker(schema), value, options);
  let step = steps.next();
  while (!step.done) step = steps.next(await step.value);
  return step.value;
}

/** Same as `coerce`, for schemas that validate synchronously. Throws on an async one. */
export function coerceSync(schema: StandardSchema | JsonSchema, value: unknown, options: CoerceOptions = {}): CoerceResult {
  const steps = repair(checker(schema), value, options);
  let step = steps.next();
  while (!step.done) {
    const checked = step.value;
    if (isThenable<Checked>(checked)) throw new TypeError("This schema validates asynchronously. Use coerce() instead");
    step = steps.next(checked);
  }
  return step.value;
}

function checker(schema: StandardSchema | JsonSchema): Check {
  const isStandard = (typeof schema === "object" || typeof schema === "function") && schema !== null && "~standard" in schema;
  if (!isStandard) return (value) => ({ problems: checkJsonSchema(schema as JsonSchema, value) });
  const { validate } = (schema as StandardSchema)["~standard"];
  const read = (result: StandardResult): Checked => (result.issues && result.issues.length > 0 ? { problems: result.issues.map(problem) } : { problems: [], output: result.value });
  return (value) => {
    const result = validate(value);
    return isThenable<StandardResult>(result) ? result.then(read) : read(result);
  };
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function problem(issue: NonNullable<StandardResult["issues"]>[number]): Problem {
  const path = (issue.path ?? []).map((part) => (typeof part === "object" && part !== null ? part.key : part));
  return { path: path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"), message: issue.message };
}

/**
 * Tries a fix at each place the schema complains about, and keeps the ones that clear the
 * complaint without causing a new one elsewhere. Because the schema judges every attempt, this
 * needs no knowledge of its internals, and it only ever touches values that are already wrong.
 */
function* repair(check: Check, input: unknown, options: CoerceOptions): Generator<Checked | PromiseLike<Checked>, CoerceResult, Checked> {
  const skip = new Set(options.skip);
  const maxChanges = options.maxChanges ?? 100;
  const changes: Change[] = [];
  let value = input;
  let current: Checked = yield check(value);

  search: while (current.problems.length > 0 && changes.length < maxChanges) {
    const deepestFirst = [...current.problems].sort((a, b) => b.path.length - a.path.length);
    for (const issue of deepestFirst) {
      const path = reachable(value, issue.path);
      if (!path) continue;
      const from = getAt(value, path);
      const isProperty = path.length > 0 && !Array.isArray(getAt(value, path.slice(0, -1)));
      for (const candidate of candidates(from, issue, isProperty)) {
        if (skip.has(candidate.rule)) continue;
        const next = candidate.drop ? removeAt(value, path) : setAt(value, path, candidate.value);
        const after: Checked = yield check(next);
        if (!improved(current.problems, after.problems, path)) continue;
        value = next;
        current = after;
        changes.push({ path, from, to: candidate.drop ? undefined : candidate.value, rule: candidate.rule });
        continue search;
      }
    }
    break;
  }

  const result: CoerceResult = { ok: current.problems.length === 0, value, changes, issues: current.problems.map(({ path, message }) => ({ path, message })) };
  if ("output" in current) result.output = current.output;
  return result;
}

/** The complaint at `path` is gone, and nothing got worse outside it. */
function improved(before: Problem[], after: Problem[], path: Path): boolean {
  const same = (other: Path) => other.length === path.length && other.every((part, i) => part === path[i]);
  const inside = (other: Path) => other.length >= path.length && path.every((part, i) => part === other[i]);
  if (after.some((item) => same(item.path))) return false;
  const outside = (list: Problem[]) => list.filter((item) => !inside(item.path)).length;
  return outside(after) <= outside(before);
}

/** The deepest part of `path` that holds a value. A missing key has nothing to fix. */
function reachable(root: unknown, path: Path): Path | undefined {
  if (path.includes("__proto__")) return undefined;
  let node = root;
  for (let i = 0; i < path.length; i++) {
    if (typeof node !== "object" || node === null) return path.slice(0, i);
    const key = path[i]!;
    if (!Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node === undefined ? undefined : path;
}

function getAt(root: unknown, path: Path): unknown {
  return path.reduce<any>((node, key) => node[key], root);
}

function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const [key, ...rest] = path as [string | number, ...Path];
  const copy: any = Array.isArray(root) ? [...root] : { ...(root as object) };
  copy[key] = setAt(copy[key], rest, value);
  return copy;
}

function removeAt(root: unknown, path: Path): unknown {
  const [key, ...rest] = path as [string | number, ...Path];
  const copy: any = Array.isArray(root) ? [...root] : { ...(root as object) };
  if (rest.length === 0) delete copy[key];
  else copy[key] = removeAt(copy[key], rest);
  return copy;
}

/** Fixes worth trying for a wrong value, most likely first. */
function candidates(value: unknown, issue: Problem, isProperty: boolean): Candidate[] {
  const wrap: Candidate = { rule: "wrap-array", value: [value] };
  if (typeof value === "string") return stringCandidates(value, issue, isProperty, wrap);
  if (typeof value === "number") {
    return [{ rule: "number-to-string", value: String(value) }, ...(value === 0 || value === 1 ? [{ rule: "number-to-boolean" as const, value: value === 1 }] : []), wrap];
  }
  if (typeof value === "boolean") return [{ rule: "boolean-to-string", value: String(value) }, wrap];
  if (value === null) return isProperty ? [{ rule: "drop-null", value: undefined, drop: true }] : [];
  const json = toJsonString(value);
  const asJson: Candidate[] = json === undefined ? [] : [{ rule: "to-json-string", value: json }];
  if (Array.isArray(value)) {
    return [...(value.length === 1 ? [{ rule: "unwrap-array" as const, value: value[0] }] : []), ...asJson];
  }
  return [wrap, ...asJson];
}

function toJsonString(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : undefined;
  } catch {
    return undefined;
  }
}

function stringCandidates(value: string, issue: Problem, isProperty: boolean, wrap: Candidate): Candidate[] {
  const text = value.trim();
  const list: Candidate[] = [];
  if (text !== value) list.push({ rule: "trim", value: text });
  for (const fixed of enumMatches(text, issue)) list.push({ rule: "enum-case", value: fixed });

  const number = toNumber(text);
  if (number !== undefined) list.push({ rule: "string-to-number", value: number });
  const boolean = toBoolean(text);
  if (boolean !== undefined) list.push({ rule: "string-to-boolean", value: boolean });
  if (/^(null|none|nil|undefined)$/i.test(text)) {
    list.push({ rule: "string-to-null", value: null });
    if (isProperty) list.push({ rule: "drop-null", value: undefined, drop: true });
  }
  if (/^[[{"]/.test(text)) {
    try {
      list.push({ rule: "json-string", value: JSON.parse(text) });
    } catch {
      // Broken JSON text is a job for a repair library, not this one.
    }
  }
  list.push(wrap);
  return list;
}

function enumMatches(text: string, issue: Problem): string[] {
  const key = (item: string) => item.toLowerCase().replace(/[\s_-]+/g, "");
  if (issue.enum) return issue.enum.filter((item): item is string => typeof item === "string" && item !== text && key(item) === key(text));
  const words = text.split(/[\s_-]+/);
  const forms = [text.toLowerCase(), text.toUpperCase(), text.charAt(0).toUpperCase() + text.slice(1).toLowerCase(), words.join("_").toLowerCase(), words.join("-").toLowerCase(), words.join("_").toUpperCase()];
  return [...new Set(forms)].filter((form) => form !== text);
}

function toNumber(text: string): number | undefined {
  const plain = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replaceAll(",", "") : text;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(plain)) return undefined;
  const number = Number(plain);
  if (!Number.isFinite(number)) return undefined;
  // A long id would silently lose digits.
  return Number.isInteger(number) && !Number.isSafeInteger(number) ? undefined : number;
}

function toBoolean(text: string): boolean | undefined {
  const word = text.toLowerCase();
  if (["true", "yes", "on", "1"].includes(word)) return true;
  if (["false", "no", "off", "0"].includes(word)) return false;
  return undefined;
}
