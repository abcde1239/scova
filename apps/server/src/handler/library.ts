import type { Context } from 'elysia';
import { parseRevisionEtag, revisionEtag } from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import { requireSession, requireCsrf } from '@/handler/session.ts';
import { createLibraryService } from '@/service/library.ts';
import { ApiError } from '@/utils/errors.ts';

type Http = Pick<Context, 'request' | 'set'>;
export function createLibraryHandlers(services: ApiServices) {
    const library = createLibraryService(services);
    async function owner(request: Request, set: Http['set'], write = false) {
        const session = await requireSession(request, services);
        if (write) requireCsrf(request, session, services);
        set.headers['cache-control'] = 'no-store';
        return session.userId;
    }
    function expected(request: Request) {
        const value = request.headers.get('if-match');
        if (!value)
            throw new ApiError(428, 'REVISION_REQUIRED', '修改或删除笔记必须携带If-Match修订');
        return parseRevisionEtag(value);
    }
    return {
        async bookmarks(this: void, { request, set, query }: Http & { query: unknown }) {
            return library.bookmarks(await owner(request, set), query);
        },
        async createBookmark(this: void, { request, set, body }: Http & { body: unknown }) {
            const result = await library.createBookmark(await owner(request, set, true), body);
            set.status = result.reused ? 200 : 201;
            return result;
        },
        async deleteBookmark(
            this: void,
            { request, set, params }: Http & { params: { bookmarkId: string } },
        ) {
            await library.deleteBookmark(await owner(request, set, true), params.bookmarkId);
            return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        },
        async notes(this: void, { request, set, query }: Http & { query: unknown }) {
            return library.notes(await owner(request, set), query);
        },
        async createNote(this: void, { request, set, body }: Http & { body: unknown }) {
            const userId = await owner(request, set, true),
                key = request.headers.get('idempotency-key');
            if (!key)
                throw new ApiError(428, 'IDEMPOTENCY_REQUIRED', '创建笔记必须携带Idempotency-Key');
            const result = await library.createNote(userId, body, key);
            set.status = result.reused ? 200 : 201;
            set.headers.etag = revisionEtag(result.note.revision);
            return result;
        },
        async note(this: void, { request, set, params }: Http & { params: { noteId: string } }) {
            const result = await library.note(await owner(request, set), params.noteId);
            set.headers.etag = revisionEtag(result.revision);
            return result;
        },
        async patchNote(
            this: void,
            { request, set, params, body }: Http & { params: { noteId: string }; body: unknown },
        ) {
            const userId = await owner(request, set, true);
            const result = await library.patchNote(userId, params.noteId, body, expected(request));
            set.headers.etag = revisionEtag(result.revision);
            return result;
        },
        async deleteNote(
            this: void,
            { request, set, params }: Http & { params: { noteId: string } },
        ) {
            const userId = await owner(request, set, true);
            await library.deleteNote(userId, params.noteId, expected(request));
            return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        },
        async snapshots(
            this: void,
            {
                request,
                set,
                params,
                query,
            }: Http & { params: { sourceId: string }; query: unknown },
        ) {
            return library.snapshots(await owner(request, set), params.sourceId, query);
        },
        async snapshot(
            this: void,
            { request, set, params }: Http & { params: { sourceId: string; snapshotId: string } },
        ) {
            return library.snapshot(await owner(request, set), params.sourceId, params.snapshotId);
        },
        async search(this: void, { request, set, query }: Http & { query: unknown }) {
            return library.search(await owner(request, set), query);
        },
    };
}
