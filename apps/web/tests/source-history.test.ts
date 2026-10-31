import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import {
    LibrarySnapshotDetailSchema,
    LibrarySnapshotSchema,
    parseContract,
    type SessionResponse,
} from '@scova/models';
import { createMemoryHistory } from 'vue-router';
import { createSessionLifecycle } from '@/api/session';
import {
    sourceHistoryId,
    sourceSnapshotEndpoint,
    sourceSnapshotsEndpoint,
    validateSnapshotDetail,
    type SnapshotDetail,
    type SourceSnapshot,
} from '@/api/source-history';
import {
    snapshotBody,
    snapshotClockNow,
    snapshotPage,
    sourceHistoryError,
    useSourceHistory,
    type SnapshotRead,
} from '@/composables/useSourceHistory';
import libraryRoutes from '@/router/pages/library';
import { createWorkbenchRouter } from '@/router';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = '开头😀\n<script>保存的原文</script>\n末尾';
const quote = '<script>保存的原文</script>';
const sourceId = id(1);
const snapshotId = id(2);
const currentWall = Date.parse('2026-10-31T10:00:00Z');
function urlText(url: RequestInfo | URL) {
    return typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString();
}
function snapshotFixture(n = 2): SourceSnapshot {
    return parseContract(LibrarySnapshotSchema, {
        id: id(n),
        sourceId,
        observationId: id(3),
        runId: id(4),
        title: '保存快照',
        canonicalUrl: 'https://example.test/canonical',
        originalUrl: 'https://example.test/original',
        fetchedUrl: 'https://example.test/final',
        contentHash: 'a'.repeat(64),
        extractorVersion: 'reader-v1',
        observedAt: '2026-10-31T09:00:00Z',
        publishedAt: null,
        textExpiresAt: '2099-01-01T00:00:00Z',
        bodyStatus: 'available',
        mode: 'demo',
        truncated: true,
    });
}
function detailFixture(n = 2): SnapshotDetail {
    return parseContract(LibrarySnapshotDetailSchema, {
        snapshot: snapshotFixture(n),
        textBody: text,
        quotes: [
            {
                id: id(5),
                runId: id(6),
                quote,
                quoteHash: 'b'.repeat(64),
                selector: {
                    type: 'text_offset',
                    start: text.indexOf(quote),
                    end: text.indexOf(quote) + quote.length,
                    extractorVersion: 'reader-v1',
                },
            },
        ],
        quotesTruncated: false,
    });
}
function readFixture(detail = detailFixture(), headers: Record<string, string> = {}): SnapshotRead {
    return {
        data: detail,
        status: 200,
        headers,
        url: '/snapshot',
        receivedWall: currentWall,
        receivedMonotonic: 100,
    };
}
const account: SessionResponse = {
    user: {
        id: id(100),
        email: 'qa@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'test-only',
};
const disposals: (() => void)[] = [];
function setup(fetcher: typeof fetch) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    disposals.push(lifecycle.dispose);
    return lifecycle;
}
function mount(
    fetcher: typeof fetch,
    selected: unknown = snapshotId,
    source: unknown = sourceId,
    clock = { wall: () => currentWall, monotonic: () => 100 },
) {
    const lifecycle = setup(fetcher);
    const selectedRef = ref(selected),
        sourceRef = ref(source);
    const scope = effectScope();
    const state = scope.run(() => useSourceHistory(sourceRef, selectedRef, lifecycle, clock))!;
    disposals.push(() => scope.stop());
    return { lifecycle, state, selected: selectedRef, source: sourceRef };
}
function failure(status: number, code = 'TEST_FAILURE') {
    return Response.json({ code, message: 'sample', requestId: 'sample' }, { status });
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function defaultResponse(url: string) {
    return Response.json(
        url.includes(`/snapshots/${snapshotId}`)
            ? detailFixture()
            : { items: [snapshotFixture()], nextCursor: null },
    );
}
afterEach(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
    vi.useRealTimers();
});

describe('source history contracts and existing report route', () => {
    it('adds optional snapshot route without replacing library or run details', () => {
        const router = createWorkbenchRouter(createMemoryHistory(), libraryRoutes);
        expect(router.resolve('/library').name).toBe('library');
        expect(router.resolve(`/library/sources/${sourceId}/snapshots`).name).toBe(
            'source-history',
        );
        expect(
            router.resolve(`/library/sources/${sourceId}/snapshots/${snapshotId}`).params
                .snapshotId,
        ).toBe(snapshotId);
        expect('navigation' in libraryRoutes[0]!.meta).toBe(false);
    });
    it.each(['bad', '../source', [sourceId], '', null])('rejects invalid UUID %s', (value) =>
        expect(sourceHistoryId(value)).toBeUndefined(),
    );
    it('preserves distinct snapshot identity, latest successful observation and independent quote run', () => {
        const detail = validateSnapshotDetail(detailFixture());
        expect(detail.snapshot.id).toBe(snapshotId);
        expect(detail.snapshot.runId).not.toBe(detail.quotes[0]!.runId);
        expect(detail.snapshot.publishedAt).toBeNull();
        const later = {
            ...detail.snapshot,
            observationId: id(90),
            observedAt: '2026-11-01T09:00:00Z',
            runId: id(91),
        };
        expect(later.id).toBe(detail.snapshot.id);
        expect(later.contentHash).toBe(detail.snapshot.contentHash);
        expect(snapshotPage({ items: [later], nextCursor: null }, sourceId).items).toHaveLength(1);
    });
    it.each([
        'available-null',
        'expired-body',
        'selector-length',
        'selector-position',
        'extractor',
        'duplicate-quote',
    ])('rejects detail protocol contradiction %s', (kind) => {
        const detail = detailFixture();
        if (kind === 'available-null') detail.textBody = null;
        if (kind === 'expired-body') detail.snapshot.bodyStatus = 'expired';
        if (kind === 'selector-length') detail.quotes[0]!.selector.end++;
        if (kind === 'selector-position') {
            detail.quotes[0]!.selector.start++;
            detail.quotes[0]!.selector.end++;
        }
        if (kind === 'extractor') detail.quotes[0]!.selector.extractorVersion = 'reader-v2';
        if (kind === 'duplicate-quote') detail.quotes.push(detail.quotes[0]!);
        parseContract(LibrarySnapshotDetailSchema, detail);
        expect(() => validateSnapshotDetail(detail)).toThrow();
    });
    it('retains quotes, hashes and UTF16 selectors after body expiration without claiming full text', () => {
        const detail = detailFixture();
        detail.snapshot.bodyStatus = 'expired';
        detail.textBody = null;
        expect(validateSnapshotDetail(detail).quotes[0]!.quote).toBe(quote);
        expect(detail.quotes[0]!.selector.start).toBe('开头😀\n'.length);
        expect(detail.quotes[0]!.quoteHash).toBe('b'.repeat(64));
    });
    it('supports zero or at most100 returned quotes and does not invent quote paging', () => {
        const detail = detailFixture();
        detail.quotes = [];
        detail.quotesTruncated = false;
        expect(validateSnapshotDetail(detail).quotes).toEqual([]);
        const base = detailFixture().quotes[0]!;
        detail.quotes = Array.from({ length: 100 }, (_, n) => ({ ...base, id: id(200 + n) }));
        detail.quotesTruncated = true;
        expect(
            validateSnapshotDetail(parseContract(LibrarySnapshotDetailSchema, detail)).quotes,
        ).toHaveLength(100);
        expect(() =>
            parseContract(LibrarySnapshotDetailSchema, {
                ...detail,
                quotes: [...detail.quotes, { ...base, id: id(500) }],
            }),
        ).toThrow();
    });
    it.each(['wrong-source', 'duplicate', 'same-cursor', 'empty-cursor', 'too-many'])(
        'rejects list %s',
        (kind) => {
            const page = { items: [snapshotFixture()], nextCursor: null as string | null };
            if (kind === 'wrong-source') page.items[0]!.sourceId = id(99);
            if (kind === 'duplicate') page.items.push(snapshotFixture());
            if (kind === 'same-cursor') page.nextCursor = 'current';
            if (kind === 'empty-cursor') page.nextCursor = '';
            if (kind === 'too-many')
                page.items = Array.from({ length: 21 }, (_, n) => snapshotFixture(n + 20));
            expect(() => snapshotPage(page, sourceId, 'current')).toThrow();
        },
    );
});

describe('known expiry with optional strict Date and monotonic elapsed time', () => {
    it('hides at exact deadline even without Date header, keeping the saved quote', () => {
        const detail = detailFixture();
        detail.snapshot.textExpiresAt = '2026-10-31T10:00:01Z';
        const response = readFixture(detail);
        expect(snapshotBody(response, currentWall + 999, 1099)).toBe(text);
        expect(snapshotBody(response, currentWall + 1000, 1100)).toBeNull();
        expect(response.data.quotes[0]!.quote).toBe(quote);
    });
    it('cannot reveal body by moving the wall clock backward after receipt', () => {
        const detail = detailFixture();
        detail.snapshot.textExpiresAt = '2026-10-31T10:00:01Z';
        expect(snapshotBody(readFixture(detail), currentWall - 60_000, 1100)).toBeNull();
    });
    it('uses canonical Date only as an additional conservative bound and never invents serverNow', () => {
        const detail = detailFixture();
        detail.snapshot.textExpiresAt = '2026-10-31T10:00:01Z';
        const response = readFixture(detail, { date: 'Sat, 31 Oct 2026 10:00:00 GMT' });
        expect(snapshotClockNow(response, currentWall - 60_000, 100)).toBe(currentWall + 1000);
        expect(snapshotBody(response, currentWall - 60_000, 100)).toBeNull();
        for (const date of ['tomorrow', '2026-10-31', 'Sat, 31 Oct 2026 10:00:00 UTC'])
            expect(snapshotClockNow(readFixture(detail, { date }), currentWall, 100)).toBe(
                currentWall,
            );
    });
    it('reopened cached body already past its deadline is hidden immediately', () => {
        const detail = detailFixture();
        detail.snapshot.textExpiresAt = '2026-10-31T09:59:59Z';
        expect(snapshotBody(readFixture(detail), currentWall, 100)).toBeNull();
    });
    it('supports explicit no-time-limit body and already expired server status', () => {
        const detail = detailFixture();
        detail.snapshot.textExpiresAt = null;
        expect(snapshotBody(readFixture(detail), currentWall + 999_999, 999_999)).toBe(text);
        detail.snapshot.bodyStatus = 'expired';
        detail.textBody = null;
        expect(snapshotBody(readFixture(detail), currentWall, 100)).toBeNull();
    });
    it('removes an open body at the scheduled deadline without a refetch or quote loss', async () => {
        const detail = detailFixture();
        detail.snapshot.textExpiresAt = '2026-10-31T10:00:01Z';
        let wall = currentWall,
            mono = 100;
        const fetcher = vi.fn<typeof fetch>(async (url) =>
            Response.json(
                urlText(url).endsWith(`/snapshots/${snapshotId}`)
                    ? detail
                    : { items: [detail.snapshot], nextCursor: null },
            ),
        );
        const { state } = mount(fetcher, snapshotId, sourceId, {
            wall: () => wall,
            monotonic: () => mono,
        });
        await vi.waitFor(() => expect(state.body.value).toBe(text));
        vi.useFakeTimers();
        // Install the final detail once fake timers are active so its deadline timer is controlled.
        await state.detail.refetch();
        wall += 1000;
        mono += 1000;
        await vi.advanceTimersByTimeAsync(2000);
        expect(state.body.value).toBeNull();
        expect(state.snapshot.value?.quotes[0]!.quote).toBe(quote);
        expect(
            fetcher.mock.calls.filter((call) =>
                urlText(call[0]!).endsWith(`/snapshots/${snapshotId}`),
            ),
        ).toHaveLength(2);
    });
});

describe('actual same-origin requestlane source history', () => {
    it('uses exactly two GET endpoints with opaque cursor unchanged and no fetch writes', async () => {
        const cursor = 'opaque-time-2026-10-31T09:00:00.123456Z';
        const fetcher = vi.fn<typeof fetch>(async (url) => defaultResponse(urlText(url)));
        const lifecycle = setup(fetcher);
        await lifecycle.capture().request(sourceSnapshotsEndpoint, {
            params: { sourceId },
            query: { limit: 20, cursor },
        });
        await lifecycle
            .capture()
            .request(sourceSnapshotEndpoint, { params: { sourceId, snapshotId } });
        const firstCall = fetcher.mock.calls[0];
        expect(firstCall).toBeDefined();
        const url = new URL(urlText(firstCall![0]), 'https://scova.test');
        expect(url.searchParams.get('cursor')).toBe(cursor);
        expect(url.searchParams.get('limit')).toBe('20');
        expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['GET', 'GET']);
        expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
    });
    it('rejects malformed request IDs before transport and malformed detail body before rendering', async () => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json({ ...detailFixture(), extra: true }),
        );
        const lifecycle = setup(fetcher);
        await expect(
            lifecycle
                .capture()
                .request(sourceSnapshotEndpoint, { params: { sourceId: '../bad', snapshotId } }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
        await expect(
            lifecycle
                .capture()
                .request(sourceSnapshotEndpoint, { params: { sourceId, snapshotId } }),
        ).rejects.toThrow();
    });
});

describe('source list/detail cache, paging and account lifecycle', () => {
    it.each([
        ['bad', snapshotId],
        [sourceId, 'bad'],
        [[sourceId], snapshotId],
    ])('does not request invalid route %s/%s', async (source, selected) => {
        const fetcher = vi.fn<typeof fetch>();
        const { state } = mount(fetcher, selected, source);
        await nextTick();
        expect(state.valid.value).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('reads no detail by default and does not manufacture a selected latest snapshot', async () => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json({ items: [snapshotFixture()], nextCursor: null }),
        );
        const { state } = mount(fetcher, '');
        await vi.waitFor(() => expect(state.items.value).toHaveLength(1));
        expect(state.snapshot.value).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(['id', 'source'])('hides wrong detail %s', async (kind) => {
        const detail = detailFixture();
        if (kind === 'id') detail.snapshot.id = id(99);
        else detail.snapshot.sourceId = id(99);
        const { state } = mount(async (url) =>
            Response.json(
                urlText(url).includes(`/snapshots/${snapshotId}`)
                    ? detail
                    : { items: [snapshotFixture()], nextCursor: null },
            ),
        );
        await vi.waitFor(() => expect(state.detail.isError.value).toBe(true));
        expect(state.snapshot.value).toBeUndefined();
        expect(state.body.value).toBeNull();
    });
    it.each([403, 404, 409, 503])(
        'hides prior detail body on reread HTTP%s rather than serving cached full text',
        async (status) => {
            let details = 0;
            const { state } = mount(async (url) => {
                if (urlText(url).includes(`/snapshots/${snapshotId}`)) {
                    details++;
                    return details === 1
                        ? Response.json(detailFixture())
                        : failure(
                              status,
                              status === 409 ? 'INVALID_SOURCE_SNAPSHOT' : 'TEST_FAILURE',
                          );
                }
                return Response.json({ items: [snapshotFixture()], nextCursor: null });
            });
            await vi.waitFor(() => expect(state.body.value).toBe(text));
            await state.detail.refetch();
            expect(state.body.value).toBeNull();
            expect(state.snapshot.value).toBeUndefined();
            if (status === 409)
                expect(sourceHistoryError(state.detail.error.value)).toContain('校验失败');
        },
    );
    it('source permission failure hides cached detail and list together', async () => {
        let lists = 0;
        const { state } = mount(async (url) => {
            if (urlText(url).includes(`/snapshots/${snapshotId}`))
                return Response.json(detailFixture());
            lists++;
            return lists === 1
                ? Response.json({ items: [snapshotFixture()], nextCursor: null })
                : failure(404);
        });
        await vi.waitFor(() => expect(state.body.value).toBe(text));
        await state.query.refetch();
        await nextTick();
        expect(state.blocked.value).toBe(true);
        expect(state.items.value).toEqual([]);
        expect(state.snapshot.value).toBeUndefined();
        expect(state.body.value).toBeNull();
    });
    it('uses previous-page cache but first-page recovery actually GETs after cursor400', async () => {
        let firstCalls = 0;
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const parsed = new URL(urlText(url), 'https://scova.test');
            if (parsed.searchParams.has('cursor')) return failure(400, 'INVALID_CURSOR');
            firstCalls++;
            return Response.json({ items: [snapshotFixture()], nextCursor: 'cursor-a' });
        });
        const { state } = mount(fetcher, '');
        await vi.waitFor(() => expect(state.items.value).toHaveLength(1));
        state.next();
        await vi.waitFor(() => expect(state.query.isError.value).toBe(true));
        await state.first();
        expect(firstCalls).toBe(2);
        expect(state.previous.value).toEqual([]);
        expect(state.query.isSuccess.value).toBe(true);
    });
    it('rejects cross-page duplicate snapshots and cursor loops without further requests', async () => {
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const parsed = new URL(urlText(url), 'https://scova.test');
            return Response.json({
                items: [snapshotFixture()],
                nextCursor: parsed.searchParams.has('cursor') ? 'cursor-b' : 'cursor-a',
            });
        });
        const { state } = mount(fetcher, '');
        await vi.waitFor(() => expect(state.items.value).toHaveLength(1));
        state.next();
        await vi.waitFor(() => expect(state.pageProblem.value).toBeTruthy());
        expect(state.items.value).toEqual([]);
        state.next();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('detects a next cursor returning to an earlier page', async () => {
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const cursor = new URL(urlText(url), 'https://scova.test').searchParams.get('cursor');
            return Response.json({
                items: [snapshotFixture(cursor === 'a' ? 20 : cursor === 'b' ? 21 : 2)],
                nextCursor: cursor === 'a' ? 'b' : 'a',
            });
        });
        const { state } = mount(fetcher, '');
        await vi.waitFor(() => expect(state.items.value).toHaveLength(1));
        state.next();
        await vi.waitFor(() => expect(state.items.value[0]?.id).toBe(id(20)));
        state.next();
        await vi.waitFor(() => expect(state.items.value[0]?.id).toBe(id(21)));
        state.next();
        expect(state.paginationError.value).toContain('重复');
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it('clears previous source and prevents old snapshot late response from replacing selection', async () => {
        const pending = deferred<Response>();
        const { state, selected } = mount(async (url) => {
            if (urlText(url).endsWith(`/snapshots/${snapshotId}`)) return pending.promise;
            if (urlText(url).endsWith(`/snapshots/${id(9)}`))
                return Response.json(detailFixture(9));
            return Response.json({ items: [snapshotFixture()], nextCursor: null });
        });
        selected.value = id(9);
        await vi.waitFor(() => expect(state.snapshot.value?.snapshot.id).toBe(id(9)));
        pending.resolve(Response.json(detailFixture()));
        await nextTick();
        expect(state.snapshot.value?.snapshot.id).toBe(id(9));
    });
    it.each([200, 401])(
        'old owner late HTTP%s cannot reveal content or clear the replacement account',
        async (status) => {
            const pending = deferred<Response>();
            let requests = 0;
            const { state, lifecycle } = mount(async (_url) => {
                requests++;
                if (requests <= 2) return pending.promise;
                return failure(404);
            });
            await vi.waitFor(() => expect(requests).toBe(2));
            lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(101) } });
            pending.resolve(status === 401 ? failure(401) : Response.json(detailFixture()));
            await vi.waitFor(() => expect(state.detail.isError.value).toBe(true));
            expect(state.snapshot.value).toBeUndefined();
            expect(state.body.value).toBeNull();
            expect(lifecycle.session.user?.id).toBe(id(101));
        },
    );
});
