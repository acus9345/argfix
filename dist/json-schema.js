/** Checks what tool arguments usually get wrong: shapes and allowed values. */
export function checkJsonSchema(schema, value) {
    const problems = [];
    walk(schema, value, [], schema, problems, new Set());
    return problems;
}
function walk(schema, value, path, root, out, seenRefs) {
    if (schema === undefined || schema === true)
        return;
    if (schema === false) {
        out.push({ path, message: "not allowed" });
        return;
    }
    if (typeof schema !== "object" || schema === null)
        return;
    if (typeof schema.$ref === "string" && !seenRefs.has(schema.$ref)) {
        const nextRefs = new Set(seenRefs);
        nextRefs.add(schema.$ref);
        walk(resolve(schema.$ref, root), value, path, root, out, nextRefs);
    }
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
    for (const branch of (schema.allOf ?? []))
        walk(branch, value, path, root, out, seenRefs);
    if (Array.isArray(schema.anyOf))
        union(schema.anyOf, value, path, root, out, seenRefs);
    if (Array.isArray(schema.oneOf))
        union(schema.oneOf, value, path, root, out, seenRefs);
    if (Array.isArray(value))
        walkArray(schema, value, path, root, out);
    else if (typeof value === "object" && value !== null)
        walkObject(schema, value, path, root, out);
}
/** When the closest branch fails deeper down, report those failures, since they can be fixed. */
function union(options, value, path, root, out, seenRefs) {
    if (options.length === 0) {
        out.push({ path, message: "matches none of the allowed shapes" });
        return;
    }
    const results = options.map((option) => {
        const found = [];
        walk(option, value, path, root, found, seenRefs);
        return found;
    });
    if (results.some((found) => found.length === 0))
        return;
    const deep = results.filter((found) => found.every((item) => item.path.length > path.length));
    if (deep.length > 0) {
        const closest = deep.reduce((best, found) => (found.length < best.length ? found : best));
        out.push(...closest);
        return;
    }
    const values = results.flatMap((found) => found.flatMap((item) => (item.path.length === path.length ? (item.enum ?? []) : [])));
    out.push({ path, message: "matches none of the allowed shapes", ...(values.length > 0 ? { enum: values } : {}) });
}
function walkObject(schema, value, path, root, out) {
    const properties = (schema.properties ?? {});
    for (const key of (schema.required ?? [])) {
        if (!Object.hasOwn(value, key) || value[key] === undefined)
            out.push({ path: [...path, key], message: "required" });
    }
    for (const [key, item] of Object.entries(value)) {
        const known = Object.hasOwn(properties, key);
        if (known)
            walk(properties[key], item, [...path, key], root, out, new Set());
        else if (schema.additionalProperties !== undefined)
            walk(schema.additionalProperties, item, [...path, key], root, out, new Set());
    }
}
function walkArray(schema, value, path, root, out) {
    const prefix = (schema.prefixItems ?? []);
    value.forEach((item, i) => walk(prefix[i] ?? schema.items, item, [...path, i], root, out, new Set()));
}
function allowed(schema) {
    if (Array.isArray(schema.enum))
        return { enum: schema.enum };
    return "const" in schema ? { enum: [schema.const] } : {};
}
function resolve(ref, root) {
    if (ref === "#")
        return root;
    if (!ref.startsWith("#/"))
        return true;
    const parts = ref.slice(2).split("/");
    let node = root;
    for (const raw of parts) {
        if (typeof node !== "object" || node === null)
            return undefined;
        const part = decodePointer(raw).replaceAll("~1", "/").replaceAll("~0", "~");
        if (!Object.hasOwn(node, part))
            return undefined;
        node = node[part];
    }
    return node;
}
function decodePointer(segment) {
    try {
        return decodeURIComponent(segment);
    }
    catch {
        return segment;
    }
}
function matchesType(type, value) {
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
function equal(a, b) {
    if (a === b)
        return true;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null)
        return false;
    if (Array.isArray(a)) {
        return Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
    }
    if (Array.isArray(b))
        return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length)
        return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
