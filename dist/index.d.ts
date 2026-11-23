export type Path = (string | number)[];
export type Rule = "trim" | "string-to-number" | "string-to-boolean" | "string-to-null" | "json-string" | "enum-case" | "number-to-string" | "number-to-boolean" | "boolean-to-string" | "to-json-string" | "wrap-array" | "unwrap-array" | "drop-null";
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
    issues?: ReadonlyArray<{
        message: string;
        path?: ReadonlyArray<PropertyKey | {
            key: PropertyKey;
        }> | undefined;
    }> | undefined;
}
export type JsonSchema = boolean | {
    [keyword: string]: unknown;
};
/** Fix `value` to match `schema`. Takes any Standard Schema or a JSON Schema. */
export declare function coerce(schema: StandardSchema | JsonSchema, value: unknown, options?: CoerceOptions): Promise<CoerceResult>;
/** Same as `coerce`, for schemas that validate synchronously. Throws on an async one. */
export declare function coerceSync(schema: StandardSchema | JsonSchema, value: unknown, options?: CoerceOptions): CoerceResult;
export {};
