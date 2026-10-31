# argfix

Fix wrong values in LLM tool-call arguments before validation, and get a list of what changed.

[![npm](https://img.shields.io/npm/v/argfix)](https://www.npmjs.com/package/argfix)
[![CI](https://github.com/acus9345/argfix/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/argfix/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/argfix)](LICENSE)

Models get tool arguments almost right. They send `"5"` for a number, `"true"` for a boolean, a JSON string where an object belongs, or `"HIGH"` when the enum says `"high"`. A strict validator rejects all of these, and you pay for a retry over something a line of code could fix.

- **Any schema:** Zod, Valibot, ArkType or anything else with [Standard Schema](https://standardschema.dev), plus plain JSON Schema, which is what most tool definitions already are.
- **The schema decides.** It only touches values your schema rejects, so a string that should stay `"123"` stays `"123"`.
- **Tells you what it did.** Every fix comes back with its path, old value, new value and rule, so you can log how often your model gets it wrong.
- **No side effects.** The input is never changed.
- No dependencies.

## Install

```bash
npm install argfix
```

## Quick start

```ts
import { coerce } from "argfix";
import { z } from "zod";

const schema = z.object({
  limit: z.number(),
  exact: z.boolean(),
  priority: z.enum(["low", "high"]),
  filter: z.object({ minScore: z.number() }),
});

const result = await coerce(schema, {
  limit: "5",
  exact: "true",
  priority: "HIGH",
  filter: '{"minScore":"0.5"}',
});

result.ok; // true
result.value; // { limit: 5, exact: true, priority: "high", filter: { minScore: 0.5 } }
result.changes;
// [
//   { path: ["limit"], from: "5", to: 5, rule: "string-to-number" },
//   { path: ["exact"], from: "true", to: true, rule: "string-to-boolean" },
//   { path: ["priority"], from: "HIGH", to: "high", rule: "enum-case" },
//   { path: ["filter"], from: '{"minScore":"0.5"}', to: { minScore: "0.5" }, rule: "json-string" },
//   { path: ["filter", "minScore"], from: "0.5", to: 0.5, rule: "string-to-number" },
// ]
```

With a tool definition, pass its JSON Schema. `coerceSync` works when the schema validates synchronously:

```ts
import { coerceSync } from "argfix";

const { ok, value, changes, issues } = coerceSync(tool.input_schema, toolCall.input);

if (changes.length > 0) metrics.count("tool_args_fixed", changes.length, { tool: tool.name });
if (!ok) return { error: issues }; // send this back to the model
return runTool(value);
```

## What comes back

| Field | What it is |
| --- | --- |
| `ok` | `true` when the fixed value passes the schema. |
| `value` | The fixed input. If nothing was wrong, this is the same object you passed in. |
| `output` | What a Standard Schema returned, with its defaults and transforms. Only there when `ok`. |
| `changes` | Each fix as `{ path, from, to, rule }`. |
| `issues` | Each remaining problem as `{ path, message }`. |

## Rules

| Rule | Example |
| --- | --- |
| `string-to-number` | `"5"` to `5`, `"1,234.5"` to `1234.5` |
| `string-to-boolean` | `"true"`, `"yes"`, `"on"`, `"1"` to `true`, and their opposites to `false` |
| `string-to-null` | `"null"`, `"none"`, `"nil"` to `null` |
| `json-string` | `'{"a":1}'` to `{ a: 1 }`, including whole arguments sent as one string |
| `enum-case` | `"HIGH"` to `"high"`, `"In Progress"` to `"in_progress"` |
| `trim` | `" high "` to `"high"` |
| `number-to-string` | `42` to `"42"` |
| `number-to-boolean` | `1` to `true`, `0` to `false` |
| `boolean-to-string` | `true` to `"true"` |
| `to-json-string` | `{ a: 1 }` to `'{"a":1}'` |
| `wrap-array` | `"cats"` to `["cats"]` |
| `unwrap-array` | `[7]` to `7` |
| `drop-null` | Removes `exact: null` when `exact` is optional |

Numbers are read carefully. `"0x10"`, `"Infinity"` and `"12 monkeys"` stay as they are, and so does an integer too long to keep its digits.

Turn rules off with `skip`:

```ts
coerceSync(schema, args, { skip: ["drop-null", "number-to-boolean"] });
```

`maxChanges` caps the fixes per call. The default is 100.

## How it works

Standard Schema only offers one thing: validate this value. So `argfix` validates, then at each place the schema complains, it tries the fixes that suit the wrong value. A fix stays only if the schema stops complaining there and nothing gets worse elsewhere. The schema judges every attempt, which is why it needs no knowledge of your validator and works the same across libraries.

This means a call with many wrong values validates many times. It's cheap for normal tool arguments. Watch out for async refinements that hit a database or an API.

## Works with llm-json-mend

The two cover both steps. [llm-json-mend](https://www.npmjs.com/package/llm-json-mend) fixes broken JSON text. `argfix` fixes wrong values inside valid JSON. Mend first, then coerce:

```ts
import { parseJson } from "llm-json-mend";
import { coerce } from "argfix";

const result = await coerce(schema, parseJson(rawText));
```

## Limits

- **A fix can be wrong.** The schema proves that a value fits, not that it's what the model meant. `"no"` for a boolean is safe, but `1` for an enum of `"1"` and `"2"` is a guess. Log `changes`.
- **For JSON Schema, `ok` isn't a full validation.** It checks `type`, `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `prefixItems`, `allOf`, `anyOf`, `oneOf` and local `$ref`. It ignores limits like `minimum` and `pattern`, and treats `oneOf` as `anyOf`. Run your real validator afterwards.
- **It doesn't invent data.** A missing required value stays missing.
- **It doesn't rename keys.** `Limit` won't become `limit`.
- **Enum case for Standard Schema is a guess at common forms** (lower, upper, capitalized, snake and kebab), because the allowed values aren't visible. JSON Schema lists them, so matching there is more accurate.

## License

MIT
