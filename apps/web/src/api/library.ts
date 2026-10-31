import {
    BookmarkCommandResponseSchema,
    BookmarkInputSchema,
    BookmarkListResponseSchema,
    BookmarkSchema,
    PageQuerySchema,
    UuidSchema,
    parseContract,
    type PageQuery,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator, voidValidator } from '@/api/validator';
export type Bookmark = ReturnType<typeof parseContract<typeof BookmarkSchema>>;

export const bookmarksEndpoint = defineApiEndpoint<{
    query: PageQuery;
    data: { items: Bookmark[]; nextCursor: string | null };
}>({
    method: 'GET',
    path: '/bookmarks',
    inputValidators: { query: modelValidator(PageQuerySchema) },
    validator: modelValidator(BookmarkListResponseSchema),
});
export const createBookmarkEndpoint = defineApiEndpoint<{
    body: { sourceId: string };
    data: { bookmark: Bookmark; reused: boolean };
}>({
    method: 'POST',
    path: '/bookmarks',
    inputValidators: { body: modelValidator(BookmarkInputSchema) },
    validator: modelValidator(BookmarkCommandResponseSchema),
});
export const deleteBookmarkEndpoint = defineApiEndpoint<{
    params: { bookmarkId: string };
    data: void;
}>({
    method: 'DELETE',
    path: '/bookmarks/:bookmarkId',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const id =
                    value && typeof value === 'object' && 'bookmarkId' in value
                        ? value.bookmarkId
                        : undefined;
                return { bookmarkId: parseContract(UuidSchema, id) };
            },
        },
    },
    validator: voidValidator,
});
