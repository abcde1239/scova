import { createHash } from 'node:crypto';
import type { ErrorObject } from 'ajv';
import type { ModelSchemaIssue } from './types.ts';

const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
function at(schema: unknown, path: string): unknown {
    return path
        .replace(/^#\/?/, '')
        .split('/')
        .filter(Boolean)
        .reduce<unknown>((node, key) => {
            const decoded = key.replace(/~1/g, '/').replace(/~0/g, '~');
            return object(node) || Array.isArray(node)
                ? (node as Record<string, unknown>)[decoded]
                : undefined;
        }, schema);
}
export function modelSchemaHash(schema: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

/** Read expected values from the trusted schema only, never AJV response data/messages. */
export function modelSchemaIssues(
    schema: Record<string, unknown>,
    errors: ErrorObject[],
): ModelSchemaIssue[] {
    const result: ModelSchemaIssue[] = [];
    for (const error of errors) {
        const union = /^(.*)\/anyOf\/(\d+)\/const$/.exec(error.schemaPath);
        let schemaPath = union ? `${union[1]}/anyOf` : error.schemaPath;
        const node = at(schema, union ? union[1]! : schemaPath.replace(/\/[^/]+$/, ''));
        const variants = object(node) && Array.isArray(node.anyOf) ? node.anyOf : [];
        const values =
            union || error.keyword === 'anyOf'
                ? variants.map((item: unknown) => (object(item) ? item.const : undefined))
                : object(node)
                  ? node.enum
                  : undefined;
        const allowedValues =
            Array.isArray(values) &&
            values.length <= 30 &&
            values.every((v) => typeof v === 'string' && v.length <= 80)
                ? (values as string[])
                : undefined;
        const keyword =
            (union || error.keyword === 'anyOf') && allowedValues ? 'enum' : error.keyword;
        const limit =
            object(node) &&
            ['maxItems', 'minItems', 'maxLength', 'minLength', 'maximum', 'minimum'].includes(
                keyword,
            )
                ? node[keyword]
                : undefined;
        const missing =
            error.keyword === 'required' ? (error.params.missingProperty as unknown) : undefined;
        const requiredProperty =
            typeof missing === 'string' &&
            object(node) &&
            object(node.properties) &&
            Object.hasOwn(node.properties, missing)
                ? missing
                : undefined;
        const properties =
            error.keyword === 'additionalProperties' && object(node) && object(node.properties)
                ? Object.keys(node.properties)
                : undefined;
        const allowedProperties =
            properties && properties.length <= 30 && properties.every((name) => name.length <= 80)
                ? properties
                : undefined;
        schemaPath = schemaPath.slice(0, 240);
        if (
            result.some(
                (issue) =>
                    issue.schemaPath === schemaPath &&
                    issue.keyword === keyword &&
                    issue.requiredProperty === requiredProperty,
            )
        )
            continue;
        result.push({
            schemaPath,
            keyword,
            ...(allowedValues ? { allowedValues } : {}),
            ...(typeof limit === 'number' ? { limit } : {}),
            ...(requiredProperty ? { requiredProperty } : {}),
            ...(allowedProperties ? { allowedProperties } : {}),
        });
        if (result.length === 6) break;
    }
    return result;
}
