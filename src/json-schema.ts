import type { JsonSchema, Path } from "./index.js";

export interface Problem {
  path: Path;
  message: string;
  /** The allowed values, when the schema lists them. */
  enum?: unknown[];
}

type Node = { [keyword: string]: unknown };

/** Checks what tool arguments usually get wrong: shapes and allowed values. */
export function checkJsonSchema(schema: JsonSchema, value: unknown): Problem[] {
  const problems: Problem[] = [];
  walk(schema, value, [], schema, problems);
  return problems;
}

function walk(schema: JsonSchema | undefined, value: unknown, path: Path, root: JsonSchema, out: Problem[]): void {
  if (schema === undefined || schema === true) return;
  if (schema === false) {
    out.push({ path, message: "not allowed" });
    return;
  }
  if (typeof schema.$ref === "string") walk(resolve(schema.$ref, root), value, path, root, out);

  const types = schema.type === undefined ? undefined : [schema.type].flat().concat(schema.nullable === true ? ["null"] : []);
  if (types && !types.some((type) => matchesType(type, value))) {
    out.push({ path, message: `expected ${types.join(" or ")}`, ...allowed(schema) });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => equal(item, value))) {
    out.push({ path, message: `expected one of ${JSON.stringify(schema.enum)}`, enum: schema.enum });
    return;
  }
  if ("const" in schema && !equal(schema.const, value)) {
    out.push({ path, message: `expected ${JSON.stringify(schema.const)}`, enum: [schema.const] });
    return;
  }

  for (const branch of (schema.allOf ?? []) as JsonSchema[]) walk(branch, value, path, root, out);
  const options = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (options) union(options, value, path, root, out);

  if (Array.isArray(value)) walkArray(schema, value, path, root, out);
  else if (typeof value === "object" && value !== null) walkObject(schema, value as Node, path, root, out);
}

/** When the closest branch fails deeper down, report those failures, since they can be fixed. */
function union(options: JsonSchema[], value: unknown, path: Path, root: JsonSchema, out: Problem[]): void {
  const results = options.map((option) => {
    const found: Problem[] = [];
    walk(option, value, path, root, found);
    return found;
  });
  if (results.some((found) => found.length === 0)) return;
  const closest = results.reduce((best, found) => (found.length < best.length ? found : best));
  if (closest.every((item) => item.path.length > path.length)) {
    out.push(...closest);
    return;
  }
  const values = results.flatMap((found) => found.flatMap((item) => (item.path.length === path.length ? (item.enum ?? []) : [])));
  out.push({ path, message: "matches none of the allowed shapes", ...(values.length > 0 ? { enum: values } : {}) });
}

function walkObject(schema: Node, value: Node, path: Path, root: JsonSchema, out: Problem[]): void {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const key of (schema.required ?? []) as string[]) {
    if (value[key] === undefined) out.push({ path: [...path, key], message: "required" });
  }
  for (const [key, item] of Object.entries(value)) {
    const known = Object.hasOwn(properties, key);
    if (known) walk(properties[key], item, [...path, key], root, out);
    else if (schema.additionalProperties !== undefined) walk(schema.additionalProperties as JsonSchema, item, [...path, key], root, out);
  }
}

function walkArray(schema: Node, value: unknown[], path: Path, root: JsonSchema, out: Problem[]): void {
  const prefix = (schema.prefixItems ?? []) as JsonSchema[];
  value.forEach((item, i) => walk(prefix[i] ?? (schema.items as JsonSchema | undefined), item, [...path, i], root, out));
}

function allowed(schema: Node): { enum?: unknown[] } {
  if (Array.isArray(schema.enum)) return { enum: schema.enum };
  return "const" in schema ? { enum: [schema.const] } : {};
}

function resolve(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith("#")) return true;
  const parts = ref.slice(2).split("/").filter(Boolean);
  return parts.reduce<any>((node, part) => node?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function matchesType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string":
    case "boolean":
      return typeof value === type;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function equal(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
