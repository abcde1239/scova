import { createHash } from 'node:crypto';
import { InstantSchema, UuidSchema, parseContract } from '@scova/contracts';
import { ApiError } from '@/utils/errors.ts';

export interface LibraryCursor {
    id: string;
    time: string;
    kind?: 'source' | 'note';
}
export const libraryScope = (userId: string, resource: string, filters: unknown) =>
    createHash('sha256')
        .update(JSON.stringify([userId, resource, filters]))
        .digest('hex');
export const invalidLibraryCursor = () =>
    new ApiError(400, 'INVALID_CURSOR', '分页游标无效或与查询范围不一致');
export function readLibraryCursor(
    value: string | undefined,
    scope: string,
): LibraryCursor | undefined {
    if (!value) return undefined;
    try {
        const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (
            cursor.scope !== scope ||
            typeof cursor.time !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.time) ||
            (cursor.kind !== undefined && cursor.kind !== 'source' && cursor.kind !== 'note')
        )
            throw invalidLibraryCursor();
        parseContract(UuidSchema, cursor.id);
        parseContract(InstantSchema, cursor.time);
        return { id: cursor.id, time: cursor.time, ...(cursor.kind ? { kind: cursor.kind } : {}) };
    } catch {
        throw invalidLibraryCursor();
    }
}
export function writeLibraryCursor(cursor: LibraryCursor, scope: string) {
    // The six fractional digits come from PostgreSQL. Never round them through JS Date.
    return Buffer.from(JSON.stringify({ ...cursor, scope })).toString('base64url');
}
export function librarySearchTerms(value: string) {
    const terms = value.trim().split(/\s+/u);
    if (Buffer.byteLength(value, 'utf8') > 800 || terms.length > 8)
        throw new ApiError(422, 'SEARCH_QUERY_TOO_LARGE', '搜索最多800字节和8个空白分隔关键词');
    return terms;
}
export function libraryExcerpt(value: string, terms: string[]): string {
    const lower = value.toLowerCase();
    const positions = terms
        .map((term) => lower.indexOf(term.toLowerCase()))
        .filter((index) => index >= 0);
    const start = positions.length ? Math.max(0, Math.min(...positions) - 80) : 0;
    return value.slice(start, start + 500);
}
