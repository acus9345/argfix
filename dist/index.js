import { checkJsonSchema } from "./json-schema.js";
/** Fix `value` to match `schema`. Takes any Standard Schema or a JSON Schema. */
export async function coerce(schema, value, options = {}) {
    const steps = repair(checker(schema), value, options);
    let step = steps.next();
    while (!step.done)
        step = steps.next(await step.value);
    return step.value;
}
/** Same as `coerce`, for schemas that validate synchronously. Throws on an async one. */
export function coerceSync(schema, value, options = {}) {
    const steps = repair(checker(schema), value, options);
    let step = steps.next();
    while (!step.done) {
        const checked = step.value;
        if (isThenable(checked))
            throw new TypeError("This schema validates asynchronously. Use coerce() instead");
        step = steps.next(checked);
    }
    return step.value;
}
function checker(schema) {
    const isStandard = (typeof schema === "object" || typeof schema === "function") && schema !== null && "~standard" in schema;
    if (!isStandard)
        return (value) => ({ problems: checkJsonSchema(schema, value) });
    const { validate } = schema["~standard"];
    const read = (result) => (result.issues && result.issues.length > 0 ? { problems: result.issues.map(problem) } : { problems: [], output: result.value });
    return (value) => {
        const result = validate(value);
        return isThenable(result) ? result.then(read) : read(result);
    };
}
function isThenable(value) {
    return (typeof value === "object" || typeof value === "function") && value !== null && typeof value.then === "function";
}
function problem(issue) {
    const path = (issue.path ?? []).map((part) => (typeof part === "object" && part !== null ? part.key : part));
    return { path: path.filter((part) => typeof part === "string" || typeof part === "number"), message: issue.message };
}
/**
 * Tries a fix at each place the schema complains about, and keeps the ones that clear the
 * complaint without causing a new one elsewhere. Because the schema judges every attempt, this
 * needs no knowledge of its internals, and it only ever touches values that are already wrong.
 */
function* repair(check, input, options) {
    const skip = new Set(options.skip);
    const maxChanges = options.maxChanges ?? 100;
    const changes = [];
    let value = input;
    let current = yield check(value);
    search: while (current.problems.length > 0 && changes.length < maxChanges) {
        const deepestFirst = [...current.problems].sort((a, b) => b.path.length - a.path.length);
        for (const issue of deepestFirst) {
            const path = reachable(value, issue.path);
            if (!path)
                continue;
            const from = getAt(value, path);
            const isProperty = path.length > 0 && !Array.isArray(getAt(value, path.slice(0, -1)));
            for (const candidate of candidates(from, issue, isProperty)) {
                if (skip.has(candidate.rule))
                    continue;
                const next = candidate.drop ? removeAt(value, path) : setAt(value, path, candidate.value);
                const after = yield check(next);
                if (!improved(current.problems, after.problems, path))
                    continue;
                value = next;
                current = after;
                changes.push({ path, from, to: candidate.drop ? undefined : candidate.value, rule: candidate.rule });
                continue search;
            }
        }
        break;
    }
    const result = { ok: current.problems.length === 0, value, changes, issues: current.problems.map(({ path, message }) => ({ path, message })) };
    if ("output" in current)
        result.output = current.output;
    return result;
}
/** The complaint at `path` is gone, and nothing got worse outside it. */
function improved(before, after, path) {
    const same = (other) => other.length === path.length && other.every((part, i) => part === path[i]);
    const inside = (other) => other.length >= path.length && path.every((part, i) => part === other[i]);
    if (after.some((item) => same(item.path)))
        return false;
    const outside = (list) => list.filter((item) => !inside(item.path)).length;
    return outside(after) <= outside(before);
}
/** The deepest part of `path` that holds a value. A missing key has nothing to fix. */
function reachable(root, path) {
    if (path.includes("__proto__"))
        return undefined;
    let node = root;
    for (let i = 0; i < path.length; i++) {
        if (typeof node !== "object" || node === null)
            return path.slice(0, i);
        const key = path[i];
        if (!Object.hasOwn(node, key))
            return undefined;
        node = node[key];
    }
    return node === undefined ? undefined : path;
}
function getAt(root, path) {
    return path.reduce((node, key) => node[key], root);
}
function setAt(root, path, value) {
    if (path.length === 0)
        return value;
    const [key, ...rest] = path;
    const copy = Array.isArray(root) ? [...root] : { ...root };
    copy[key] = setAt(copy[key], rest, value);
    return copy;
}
function removeAt(root, path) {
    const [key, ...rest] = path;
    const copy = Array.isArray(root) ? [...root] : { ...root };
    if (rest.length === 0)
        delete copy[key];
    else
        copy[key] = removeAt(copy[key], rest);
    return copy;
}
/** Fixes worth trying for a wrong value, most likely first. */
function candidates(value, issue, isProperty) {
    const wrap = { rule: "wrap-array", value: [value] };
    if (typeof value === "string")
        return stringCandidates(value, issue, isProperty, wrap);
    if (typeof value === "number") {
        return [{ rule: "number-to-string", value: String(value) }, ...(value === 0 || value === 1 ? [{ rule: "number-to-boolean", value: value === 1 }] : []), wrap];
    }
    if (typeof value === "boolean")
        return [{ rule: "boolean-to-string", value: String(value) }, wrap];
    if (value === null)
        return isProperty ? [{ rule: "drop-null", value: undefined, drop: true }] : [];
    const json = toJsonString(value);
    const asJson = json === undefined ? [] : [{ rule: "to-json-string", value: json }];
    if (Array.isArray(value)) {
        return [...(value.length === 1 ? [{ rule: "unwrap-array", value: value[0] }] : []), ...asJson];
    }
    return [wrap, ...asJson];
}
function toJsonString(value) {
    try {
        const json = JSON.stringify(value);
        return typeof json === "string" ? json : undefined;
    }
    catch {
        return undefined;
    }
}
function stringCandidates(value, issue, isProperty, wrap) {
    const text = value.trim();
    const list = [];
    if (text !== value)
        list.push({ rule: "trim", value: text });
    for (const fixed of enumMatches(text, issue))
        list.push({ rule: "enum-case", value: fixed });
    const number = toNumber(text);
    if (number !== undefined)
        list.push({ rule: "string-to-number", value: number });
    const boolean = toBoolean(text);
    if (boolean !== undefined)
        list.push({ rule: "string-to-boolean", value: boolean });
    if (/^(null|none|nil|undefined)$/i.test(text)) {
        list.push({ rule: "string-to-null", value: null });
        if (isProperty)
            list.push({ rule: "drop-null", value: undefined, drop: true });
    }
    if (/^[[{"]/.test(text)) {
        try {
            list.push({ rule: "json-string", value: JSON.parse(text) });
        }
        catch {
            // Broken JSON text is a job for a repair library, not this one.
        }
    }
    list.push(wrap);
    return list;
}
function enumMatches(text, issue) {
    const key = (item) => item.toLowerCase().replace(/[\s_-]+/g, "");
    if (issue.enum)
        return issue.enum.filter((item) => typeof item === "string" && item !== text && key(item) === key(text));
    const words = text.split(/[\s_-]+/);
    const forms = [text.toLowerCase(), text.toUpperCase(), text.charAt(0).toUpperCase() + text.slice(1).toLowerCase(), words.join("_").toLowerCase(), words.join("-").toLowerCase(), words.join("_").toUpperCase()];
    return [...new Set(forms)].filter((form) => form !== text);
}
function toNumber(text) {
    const plain = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replaceAll(",", "") : text;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(plain))
        return undefined;
    const number = Number(plain);
    if (!Number.isFinite(number))
        return undefined;
    // A long id would silently lose digits.
    return Number.isInteger(number) && !Number.isSafeInteger(number) ? undefined : number;
}
function toBoolean(text) {
    const word = text.toLowerCase();
    if (["true", "yes", "on", "1"].includes(word))
        return true;
    if (["false", "no", "off", "0"].includes(word))
        return false;
    return undefined;
}
