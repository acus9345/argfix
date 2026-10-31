import type { JsonSchema, Path } from "./index.js";
export interface Problem {
    path: Path;
    message: string;
    /** The allowed values, when the schema lists them. */
    enum?: unknown[];
}
/** Checks what tool arguments usually get wrong: shapes and allowed values. */
export declare function checkJsonSchema(schema: JsonSchema, value: unknown): Problem[];
