import {
    ContractValidationError,
    LibrarySearchQuerySchema,
    LibrarySearchResponseSchema,
    parseContract,
    type LibrarySearchQuery,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
export type SearchPage = ReturnType<typeof parseContract<typeof LibrarySearchResponseSchema>>;
export type SearchHit = SearchPage['items'][number];
export function invalidSearch(message: string): never {
    throw new ContractValidationError([{ path: '/library/search', message }]);
}
export function searchInputIssue(q: string) {
    if (!q.trim()) return '请输入要搜索的已存资料关键词。';
    if (q.length > 200) return '搜索词过长，请缩短至 200 个字符以内。';
    if (new TextEncoder().encode(q).length > 800) return '搜索词最多 800 个 UTF-8 字节。';
    if (q.trim().split(/\s+/u).length > 8) return '最多使用 8 个空白分隔的关键词。';
    return '';
}
export function searchTarget(hit: SearchHit) {
    if (hit.kind === 'source') {
        if (
            !hit.sourceId ||
            !hit.snapshotId ||
            hit.reportId ||
            hit.id.toLowerCase() !== hit.snapshotId.toLowerCase()
        )
            invalidSearch('来源命中与快照标识不一致');
        return {
            path: `/library/sources/${hit.sourceId}/snapshots/${hit.snapshotId}`,
            label: '查看命中来源快照',
        };
    }
    if (hit.snapshotId || Boolean(hit.sourceId) === Boolean(hit.reportId))
        invalidSearch('笔记关联目标不一致');
    return hit.sourceId
        ? { path: `/library/sources/${hit.sourceId}/snapshots`, label: '查看笔记关联来源' }
        : { path: `/reports/${hit.reportId}`, label: '查看笔记关联报告' };
}
export const searchHitKey = (hit: SearchHit) => `${hit.kind}:${hit.id.toLowerCase()}`;
export function searchPage(value: SearchPage, cursor?: string) {
    if (value.items.length > 20) invalidSearch('搜索页超出请求数量');
    const keys = new Set<string>();
    for (const hit of value.items) {
        searchTarget(hit);
        const key = searchHitKey(hit);
        if (keys.has(key)) invalidSearch('搜索结果标识重复');
        keys.add(key);
    }
    if (
        value.nextCursor !== null &&
        (!value.nextCursor || value.nextCursor === cursor || !value.items.length)
    )
        invalidSearch('搜索分页游标重复或无对应结果');
    return value;
}
export const librarySearchEndpoint = defineApiEndpoint<{
    query: LibrarySearchQuery;
    data: SearchPage;
}>({
    method: 'GET',
    path: '/library/search',
    inputValidators: {
        query: {
            parse(value: unknown) {
                const input = parseContract(LibrarySearchQuerySchema, value);
                const issue = searchInputIssue(input.q);
                if (issue) invalidSearch(issue);
                return input;
            },
        },
    },
    validator: {
        parse: (value: unknown) => searchPage(parseContract(LibrarySearchResponseSchema, value)),
    },
});
