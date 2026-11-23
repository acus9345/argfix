import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type } from "arktype";
import * as v from "valibot";
import { z } from "zod";
import { coerce, coerceSync, type Rule } from "../dist/index.js";

const rules = (changes: { rule: Rule }[]) => changes.map((change) => change.rule);

const toolSchema = {
  type: "object",
  required: ["query", "limit"],
  additionalProperties: false,
  properties: {
    query: { type: "string" },
    limit: { type: "integer" },
    exact: { type: "boolean" },
    priority: { enum: ["low", "medium", "high"] },
    tags: { type: "array", items: { type: "string" } },
    filter: { type: "object", properties: { minScore: { type: "number" } } },
    note: { type: ["string", "null"] },
  },
};

describe("JSON Schema", () => {
  it("fixes the classic mistakes and lists them", () => {
    const result = coerceSync(toolSchema, {
      query: "cats",
      limit: "5",
      exact: "true",
      priority: "HIGH",
      filter: '{"minScore":"0.5"}',
      tags: "pets",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { query: "cats", limit: 5, exact: true, priority: "high", filter: { minScore: 0.5 }, tags: ["pets"] });
    assert.deepEqual(new Set(rules(result.changes)), new Set(["string-to-number", "string-to-boolean", "enum-case", "json-string", "wrap-array"]));
    assert.deepEqual(
      result.changes.find((change) => change.rule === "string-to-number" && change.path[0] === "limit"),
      { path: ["limit"], from: "5", to: 5, rule: "string-to-number" },
    );
  });

  it("leaves a correct value alone, and returns the same object", () => {
    const input = { query: "5", limit: 5 };
    const result = coerceSync(toolSchema, input);
    assert.equal(result.value, input);
    assert.deepEqual(result.changes, []);
    assert.equal(result.ok, true);
  });

  it("never changes the input", () => {
    const input = { query: "a", limit: "5", filter: { minScore: "1" } };
    const copy = structuredClone(input);
    const result = coerceSync(toolSchema, input);
    assert.deepEqual(input, copy);
    assert.deepEqual(result.value, { query: "a", limit: 5, filter: { minScore: 1 } });
  });

  it("doesn't touch a string that should be a string, even if it looks like a number", () => {
    assert.deepEqual(coerceSync(toolSchema, { query: "123", limit: 1 }).changes, []);
  });

  it("parses whole arguments that arrive as a JSON string", () => {
    const result = coerceSync(toolSchema, '{"query":"a","limit":"2"}');
    assert.deepEqual(result.value, { query: "a", limit: 2 });
    assert.deepEqual(result.changes.map((change) => change.path), [[], ["limit"]]);
  });

  it("drops null from optional fields, and keeps it where it's allowed", () => {
    const result = coerceSync(toolSchema, { query: "a", limit: 1, exact: null, note: null });
    assert.deepEqual(result.value, { query: "a", limit: 1, note: null });
    assert.deepEqual(result.changes, [{ path: ["exact"], from: null, to: undefined, rule: "drop-null" }]);
  });

  it("can't invent a required value", () => {
    const result = coerceSync(toolSchema, { query: "a", limit: null });
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path), [["limit"]]);
  });

  it("reports what it can't fix, and still fixes the rest", () => {
    const result = coerceSync(toolSchema, { query: "a", limit: "lots", exact: "true", priority: "urgent" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path).sort(), [["limit"], ["priority"]]);
    assert.deepEqual(rules(result.changes), ["string-to-boolean"]);
  });

  it("matches enum values by what they say, not just their case", () => {
    const schema = { type: "object", properties: { state: { enum: ["in_progress", "Done"] } } };
    assert.deepEqual(coerceSync(schema, { state: "In Progress" }).value, { state: "in_progress" });
    assert.deepEqual(coerceSync(schema, { state: "DONE" }).value, { state: "Done" });
  });

  it("handles arrays of objects, $ref and unions", () => {
    const schema = {
      type: "object",
      $defs: { item: { type: "object", properties: { qty: { type: "integer" } } } },
      properties: {
        items: { type: "array", items: { $ref: "#/$defs/item" } },
        size: { anyOf: [{ type: "integer" }, { type: "null" }] },
        shape: { oneOf: [{ type: "object", properties: { r: { type: "number" } } }, { type: "string", enum: ["none"] }] },
      },
    };
    const result = coerceSync(schema, { items: [{ qty: "1" }, { qty: "2" }], size: "null", shape: { r: "3" } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { items: [{ qty: 1 }, { qty: 2 }], size: null, shape: { r: 3 } });
  });

  it("fixes multi-field object branches in unions regardless of branch order", () => {
    const schema = {
      type: "object",
      properties: {
        shape: {
          oneOf: [
            { type: "string", enum: ["none"] },
            { type: "object", properties: { r: { type: "number" }, h: { type: "number" } } },
          ],
        },
      },
    };
    const result = coerceSync(schema, { shape: { r: "3", h: "4" } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { shape: { r: 3, h: 4 } });
  });

  it("handles empty unions, cyclic $ref, and URI-encoded $ref safely", () => {
    assert.equal(coerceSync({ anyOf: [] }, "x").ok, false);
    assert.equal(coerceSync({ $ref: "#" }, "x").ok, true);
    const cyclic = {
      $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
      $ref: "#/$defs/a",
    };
    assert.equal(coerceSync(cyclic, "x").ok, true);
    const encoded = {
      type: "object",
      $defs: { "my item": { type: "integer" } },
      properties: { count: { $ref: "#/$defs/my%20item" } },
    };
    assert.deepEqual(coerceSync(encoded, { count: "7" }).value, { count: 7 });
  });

  it("checks enum and const equality structurally without confusing NaN with null", () => {
    assert.equal(coerceSync({ enum: [null] }, Number.NaN).ok, false);
    assert.equal(coerceSync({ const: { a: 1, b: 2 } }, { b: 2, a: 1 }).ok, true);
  });

  it("handles other shapes of mistake", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string" },
        on: { type: "boolean" },
        one: { type: "number" },
        text: { type: "string" },
        flag: { type: "string" },
        list: { type: "array", items: { type: "number" } },
        spaced: { enum: ["a"] },
      },
    };
    const result = coerceSync(schema, { id: 42, on: 1, one: [7], text: { a: 1 }, flag: true, list: "[1,2]", spaced: " a " });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { id: "42", on: true, one: 7, text: '{"a":1}', flag: "true", list: [1, 2], spaced: "a" });
  });

  it("reads numbers carefully", () => {
    const schema = { type: "object", properties: { n: { type: "number" } } };
    const n = (text: string) => (coerceSync(schema, { n: text }).value as { n: unknown }).n;
    assert.equal(n("1,234.5"), 1234.5);
    assert.equal(n(" 1e3 "), 1000);
    assert.equal(n("-.5"), -0.5);
    assert.equal(n("0x10"), "0x10");
    assert.equal(n("Infinity"), "Infinity");
    assert.equal(n("12345678901234567890"), "12345678901234567890");
    assert.equal(n("12 monkeys"), "12 monkeys");
  });

  it("won't turn 5.5 into an integer", () => {
    const result = coerceSync(toolSchema, { query: "a", limit: "5.5" });
    assert.equal(result.ok, false);
    assert.equal((result.value as { limit: unknown }).limit, "5.5");
  });

  it("leaves broken JSON alone", () => {
    const result = coerceSync(toolSchema, { query: "a", limit: 1, filter: "{oops" });
    assert.equal(result.ok, false);
    assert.equal((result.value as { filter: unknown }).filter, "{oops");
  });

  it("flags unknown keys when the schema forbids them", () => {
    assert.equal(coerceSync(toolSchema, { query: "a", limit: 1, extra: 1 }).ok, false);
  });

  it("isn't fooled by a __proto__ key or inherited prototype properties", () => {
    const input = JSON.parse('{"__proto__":{"polluted":"1"},"limit":"1","query":"a"}');
    const schema = { type: "object", additionalProperties: { type: "object", properties: { polluted: { type: "number" } } } };
    const result = coerceSync(schema, input);
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
    assert.equal(result.ok, false);

    const protoRequired = { type: "object", required: ["toString"], properties: { toString: { type: "string" } } };
    const missing = coerceSync(protoRequired, {});
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.changes, []);
    assert.deepEqual(missing.issues.map((issue) => issue.path), [["toString"]]);
  });

  it("doesn't throw on unserializable values like circular objects or BigInt", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(coerceSync({ type: "string" }, circular).ok, false);
    assert.equal(coerceSync({ type: "string" }, 1n).ok, false);
  });
});

describe("options", () => {
  it("skips rules", () => {
    const result = coerceSync(toolSchema, { query: "a", limit: "5" }, { skip: ["string-to-number"] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.changes, []);
  });

  it("respects skip: ['trim'] on enum values", () => {
    const schema = { type: "object", properties: { state: { enum: ["high"] } } };
    const result = coerceSync(schema, { state: " high " }, { skip: ["trim"] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.changes, []);
  });

  it("stops at maxChanges", () => {
    const schema = { type: "array", items: { type: "number" } };
    const result = coerceSync(schema, ["1", "2", "3"], { maxChanges: 2 });
    assert.equal(result.changes.length, 2);
    assert.equal(result.ok, false);
  });
});

describe("Standard Schema", () => {
  const zod = z.object({
    limit: z.number().int(),
    exact: z.boolean().optional(),
    priority: z.enum(["low", "high"]),
    filter: z.object({ min: z.number() }).optional(),
    tags: z.array(z.string()).default([]),
  });

  it("works with Zod", async () => {
    const result = await coerce(zod, { limit: "5", exact: "true", priority: "HIGH", filter: '{"min":"1"}' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { limit: 5, exact: true, priority: "high", filter: { min: 1 } });
    assert.deepEqual(result.output, { limit: 5, exact: true, priority: "high", filter: { min: 1 }, tags: [] });
    assert.equal(result.changes.length, 5);
  });

  it("drops null from optional Zod fields", () => {
    const result = coerceSync(zod, { limit: 1, exact: null, priority: "low" });
    assert.equal(result.ok, true);
    assert.deepEqual(rules(result.changes), ["drop-null"]);
  });

  it("works with Zod unions", () => {
    const schema = z.object({ size: z.union([z.number(), z.null()]), kind: z.literal("x") });
    assert.deepEqual(coerceSync(schema, { size: "4", kind: "X" }).value, { size: 4, kind: "x" });
  });

  it("works with Valibot", () => {
    const schema = v.object({ limit: v.number(), on: v.boolean(), level: v.picklist(["LOW", "HIGH"]), nested: v.array(v.object({ n: v.number() })) });
    const result = coerceSync(schema, { limit: "1", on: "false", level: "high", nested: [{ n: "2" }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { limit: 1, on: false, level: "HIGH", nested: [{ n: 2 }] });
  });

  it("works with ArkType", () => {
    const schema = type({ limit: "number", on: "boolean" });
    const result = coerceSync(schema, { limit: "1", on: "true" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { limit: 1, on: true });
  });

  it("reports what the schema still rejects", () => {
    const schema = z.object({ limit: z.number().max(10) });
    const result = coerceSync(schema, { limit: "50" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path), [["limit"]]);
    assert.deepEqual(result.value, { limit: "50" });
  });

  it("handles async schemas", async () => {
    const schema = z.object({ limit: z.number().refine(async (n) => n > 0) });
    assert.deepEqual((await coerce(schema, { limit: "5" })).value, { limit: 5 });
    assert.throws(() => coerceSync(schema, { limit: "5" }));
  });

  it("works with a bare Standard Schema", async () => {
    const schema = {
      "~standard": {
        validate: async (value: unknown) => (value === 1 ? { value } : { issues: [{ message: "bad", path: [] }] }),
      },
    };
    assert.equal((await coerce(schema, "1")).value, 1);
    assert.throws(() => coerceSync(schema, "1"), /Use coerce\(\)/);
  });

  it("works with a custom thenable Standard Schema", async () => {
    const schema = {
      "~standard": {
        validate: (value: unknown) => ({
          then<TResult1 = { value?: unknown; issues?: { message: string; path: (string | number)[] }[] }, TResult2 = never>(
            onfulfilled?: ((res: { value?: unknown; issues?: { message: string; path: (string | number)[] }[] }) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ): PromiseLike<TResult1 | TResult2> {
            const res = value === 1 ? { value } : { issues: [{ message: "bad", path: [] }] };
            return Promise.resolve(res).then(onfulfilled, onrejected);
          },
        }),
      },
    };
    assert.equal((await coerce(schema, "1")).value, 1);
    assert.throws(() => coerceSync(schema, "1"), /Use coerce\(\)/);
  });

  it("preserves output when a Standard Schema returns an empty issues array", () => {
    const schema = {
      "~standard": {
        validate: (value: unknown) => ({ value: { wrapped: value }, issues: [] }),
      },
    };
    const result = coerceSync(schema, 42);
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { wrapped: 42 });
  });

  it("does not drop elements from arrays when an issue reports a stringified index", () => {
    const schema = {
      "~standard": {
        validate: (value: unknown) =>
          Array.isArray(value) && value.every((item) => typeof item === "string")
            ? { value }
            : { issues: [{ message: "expected string", path: ["0"] }] },
      },
    };
    const result = coerceSync(schema, [null]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.value, [null]);
    assert.deepEqual(result.changes, []);
  });
});
