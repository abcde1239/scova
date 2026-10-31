import {
    ContractValidationError,
    LibrarySnapshotSchema,
    LibrarySnapshotDetailSchema,
    LibrarySnapshotListResponseSchema,
    PageQuerySchema,
    UuidSchema,
    parseContract,
    type PageQuery,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';
export type SourceSnapshot = ReturnType<typeof parseContract<typeof LibrarySnapshotSchema>>;
export type SnapshotDetail = ReturnType<typeof parseContract<typeof LibrarySnapshotDetailSchema>>;
export function invalidSnapshot(message: string): never {
    throw new ContractValidationError([{ path: '/snapshot', message }]);
}
export function sourceHistoryId(value: unknown) {
    try {
        return parseContract(UuidSchema, value).toLowerCase();
    } catch {
        return undefined;
    }
}
const sourceParams = {
    parse(value: unknown) {
        const params = value as Record<string, unknown> | undefined;
        return { sourceId: parseContract(UuidSchema, params?.sourceId) };
    },
};
export const sourceSnapshotsEndpoint = defineApiEndpoint<{
    params: { sourceId: string };
    query: PageQuery;
    data: { items: SourceSnapshot[]; nextCursor: string | null };
}>({
    method: 'GET',
    path: '/library/sources/:sourceId/snapshots',
    inputValidators: { params: sourceParams, query: modelValidator(PageQuerySchema) },
    validator: modelValidator(LibrarySnapshotListResponseSchema),
});
export function validateSnapshotDetail(value: SnapshotDetail) {
    if ((value.snapshot.bodyStatus === 'available') !== (value.textBody !== null))
        invalidSnapshot('正文状态与内容不一致');
    if (new Set(value.quotes.map((quote) => quote.id.toLowerCase())).size !== value.quotes.length)
        invalidSnapshot('保存片段标识重复');
    for (const quote of value.quotes) {
        const selector = quote.selector;
        if (
            selector.end - selector.start !== quote.quote.length ||
            selector.extractorVersion !== value.snapshot.extractorVersion ||
            (value.textBody !== null &&
                value.textBody.slice(selector.start, selector.end) !== quote.quote)
        )
            invalidSnapshot('保存片段与正文、提取版本或字符定位不一致');
    }
    return value;
}
export const sourceSnapshotEndpoint = defineApiEndpoint<{
    params: { sourceId: string; snapshotId: string };
    data: SnapshotDetail;
}>({
    method: 'GET',
    path: '/library/sources/:sourceId/snapshots/:snapshotId',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const params = value as Record<string, unknown> | undefined;
                return {
                    ...sourceParams.parse(value),
                    snapshotId: parseContract(UuidSchema, params?.snapshotId),
                };
            },
        },
    },
    validator: {
        parse(value: unknown) {
            return validateSnapshotDetail(parseContract(LibrarySnapshotDetailSchema, value));
        },
    },
});
