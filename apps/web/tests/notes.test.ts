import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, ref } from 'vue';
import {
    NotePatchInputSchema,
    parseContract,
    type LibraryTarget,
    type SessionResponse,
} from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import {
    createNoteEndpoint,
    deleteNoteEndpoint,
    noteEndpoint,
    notesEndpoint,
    patchNoteEndpoint,
    type Note,
} from '@/api/notes';
import { useNoteEditor, useNotes } from '@/composable/useNotes';
import {
    createdNoteResponse,
    noteAttempt,
    notePage,
    noteResponse,
    noteRetryAt,
    noteTextError,
} from '@/utils/notes';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target: LibraryTarget = { kind: 'source', id: id(20) };
const time = '2026-10-31T01:00:00Z';
const account: SessionResponse = {
    user: {
        id: id(100),
        email: 'sample@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: time,
    },
    csrfToken: 'notes-csrf',
};
const disposals: (() => void)[] = [];
function note(overrides: Partial<Note> = {}): Note {
    return {
        id: id(1),
        target,
        body: '服务端原文',
        revision: 1,
        createdAt: time,
        updatedAt: time,
        ...overrides,
    };
}
const detail = (value = note(), tag = `"${value.revision}"`) =>
    Response.json(value, { headers: { etag: tag } });
const created = (value = note(), reused = false) =>
    Response.json(
        { note: value, reused },
        { status: reused ? 200 : 201, headers: { etag: `"${value.revision}"` } },
    );
const failure = (status: number, code = 'TEST_FAILURE', headers?: HeadersInit) =>
    Response.json({ code, message: '受控失败', requestId: 'notes-test' }, { status, headers });
const page = (items: Note[] = [], nextCursor: string | null = null) =>
    Response.json({ items, nextCursor });
function setup(fetcher: typeof fetch, list = false, available = ref(true)) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const filter = ref<LibraryTarget>();
    const state = scope.run(() => useNoteEditor(lifecycle, available))!;
    const notes = list ? scope.run(() => useNotes(filter, true, lifecycle))! : undefined;
    disposals.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { lifecycle, state, notes, filter, available };
}
const method = (init?: RequestInit) => init?.method ?? 'GET';
function requestUrl(input: RequestInfo | URL) {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
function body(init?: RequestInit) {
    if (typeof init?.body !== 'string') throw new TypeError('Expected JSON request body');
    return JSON.parse(init.body) as { body: string; target?: LibraryTarget };
}
afterEach(() => {
    disposals.splice(0).forEach((dispose) => dispose());
    vi.useRealTimers();
});

describe('notes text and transport contract', () => {
    it('preserves raw plain text and enforces the actual UTF16 bound plus front-end control protection', () => {
        const raw = '  <script>sample</script>\r\n# Markdown\t正文  ';
        expect(noteTextError(raw)).toBe('');
        expect(noteAttempt(target, raw).input.body).toBe(raw);
        expect(noteTextError('中'.repeat(20_000))).toBe('');
        expect(new TextEncoder().encode('中'.repeat(20_000))).toHaveLength(60_000);
        expect(noteTextError('😀'.repeat(10_000))).toBe('');
        expect(noteTextError('😀'.repeat(10_001))).not.toBe('');
        expect(() => parseContract(NotePatchInputSchema, { body: '😀'.repeat(10_001) })).toThrow();
        expect(noteTextError('  \r\n\t ')).not.toBe('');
        for (const code of [...Array.from({ length: 32 }, (_, value) => value), 127]) {
            expect(noteTextError(`正文${String.fromCharCode(code)}`) === '').toBe(
                [9, 10, 13].includes(code),
            );
        }
        // Shared schema permits NUL; this Issue's protection does not claim backend enforcement.
        expect(parseContract(NotePatchInputSchema, { body: '正文\u0000' }).body).toBe('正文\u0000');
    });
    it('freezes create target/body/key and permits identical text under independent keys', () => {
        const first = noteAttempt(target, '相同正文', 'first-key');
        const second = noteAttempt(target, '相同正文', 'second-key');
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.input.target)).toBe(true);
        expect(first.input).toEqual(second.input);
        expect(first.key).not.toBe(second.key);
    });
    it('requires exact quoted ETag, detail identity, typed target and response status', () => {
        const response = {
            data: note(),
            status: 200,
            headers: { etag: '"1"' },
            url: '/api/v1/notes',
        };
        expect(noteResponse(response, { id: id(1), target })).toBe(response);
        for (const tag of ['1', 'W/"1"', '"2"', '', '"01"'])
            expect(() => noteResponse({ ...response, headers: { etag: tag } })).toThrow();
        expect(() => noteResponse(response, { id: id(9), target })).toThrow();
        expect(() =>
            noteResponse(response, { target: { kind: 'report', id: target.id } }),
        ).toThrow();
        expect(() => noteResponse({ ...response, status: 201 })).toThrow();
    });
    it('accepts replay current content/revision while validating new create body and status', () => {
        const attempt = noteAttempt(target, '原始稿');
        const response = {
            data: { note: note({ body: '其他标签已编辑', revision: 3 }), reused: true },
            status: 200,
            headers: { etag: '"3"' },
            url: '/api/v1/notes',
        };
        expect(createdNoteResponse(response, attempt)).toBe(response);
        expect(() => createdNoteResponse({ ...response, status: 201 }, attempt)).toThrow();
        expect(() =>
            createdNoteResponse(
                { ...response, data: { ...response.data, reused: false }, status: 201 },
                attempt,
            ),
        ).toThrow();
    });
    it('rejects duplicate pages, wrong filter types and cursor loops', () => {
        expect(() => notePage({ items: [note(), note()], nextCursor: null })).toThrow();
        expect(() =>
            notePage({ items: [note()], nextCursor: null }, undefined, {
                kind: 'report',
                id: target.id,
            }),
        ).toThrow();
        expect(() => notePage({ items: [], nextCursor: 'same' }, 'same')).toThrow();
        expect(() => notePage({ items: [], nextCursor: 'x'.repeat(1025) })).toThrow();
    });
    it('validates targets and exclusive filters before network and keeps all five endpoints uncached', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => page());
        const { lifecycle } = setup(fetcher);
        for (const endpoint of [
            notesEndpoint,
            noteEndpoint,
            createNoteEndpoint,
            patchNoteEndpoint,
            deleteNoteEndpoint,
        ])
            expect(endpoint.options.cache).toBe(false);
        await expect(
            lifecycle
                .capture()
                .request(notesEndpoint, { query: { sourceId: id(20), reportId: id(20) } }),
        ).rejects.toThrow();
        await expect(
            lifecycle.capture().request(noteEndpoint, { params: { noteId: '../invalid' } }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
});

describe('notes create attempts', () => {
    it('preserves unknown attempt and explicitly replays the identical key/target/body without list inference', async () => {
        let posts = 0;
        const raw = ' 原稿\r\n<script>literal</script> ';
        const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
            if (method(init) === 'POST') {
                posts++;
                if (posts === 1) throw new TypeError('lost response');
                return created(note({ body: raw }), true);
            }
            return detail(note({ body: raw }));
        });
        const { state } = setup(fetcher);
        state.begin(target);
        state.draft.value = raw;
        await state.create();
        const original = state.attempt.value;
        expect(original?.input.body).toBe(raw);
        expect(state.canLeave(() => true)).toBe(false);
        await state.create(); // ordinary save cannot replace an unresolved attempt
        expect(posts).toBe(1);
        await state.create(true);
        expect(posts).toBe(2);
        const calls = fetcher.mock.calls.filter(([, init]) => method(init) === 'POST');
        expect(calls.map(([, init]) => new Headers(init?.headers).get('idempotency-key'))).toEqual([
            original!.key,
            original!.key,
        ]);
        expect(calls.map(([, init]) => body(init))).toEqual([original!.input, original!.input]);
        expect(new Headers(calls[0]?.[1]?.headers).get('x-csrf-token')).toBe('notes-csrf');
        expect(state.draft.value).toBe(raw);
        expect(state.lock.value).toBe('review');
        expect(state.canSave.value).toBe(false);
    });
    it('replay current version never overwrites original local draft and requires explicit adoption', async () => {
        let posts = 0;
        const current = note({ body: '另一标签修改后的正文', revision: 4 });
        const { state } = setup(async (_input, init) => {
            if (method(init) === 'POST') {
                if (++posts === 1) return failure(503);
                return created(current, true);
            }
            return detail(current);
        });
        state.begin(target);
        state.draft.value = '原始创建稿';
        await state.create();
        await state.create(true);
        expect(state.draft.value).toBe('原始创建稿');
        expect(state.server.value?.body).toBe(current.body);
        expect(state.canSave.value).toBe(false);
        state.adopt(true);
        expect(state.draft.value).toBe('原始创建稿');
        expect(state.canSave.value).toBe(true);
    });
    it('does not silently replace a deleted-resource idempotency key', async () => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            failure(409, 'IDEMPOTENCY_RESOURCE_DELETED'),
        );
        const { state } = setup(fetcher);
        state.begin(target);
        state.draft.value = '原稿';
        await state.create();
        const key = state.attempt.value?.key;
        expect(state.attemptTerminal.value).toBe(true);
        await state.create(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(state.attempt.value?.key).toBe(key);
        expect(state.endAttempt(() => false)).toBe(false);
        expect(state.attempt.value?.key).toBe(key);
        expect(state.endAttempt(() => true)).toBe(true);
        expect(state.draft.value).toBe('原稿');
    });
    it('success invalidates server lists and same text on a later explicit action gets a new key', async () => {
        let last = note(),
            next = 0;
        const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
            if (method(init) === 'POST') {
                last = note({ id: id(++next), body: body(init).body });
                return created(last);
            }
            return detail(last);
        });
        const { state } = setup(fetcher);
        for (let count = 0; count < 2; count++) {
            state.begin(target);
            state.draft.value = '相同正文';
            await state.create();
        }
        const keys = fetcher.mock.calls
            .filter(([, init]) => method(init) === 'POST')
            .map(([, init]) => new Headers(init?.headers).get('idempotency-key'));
        expect(new Set(keys).size).toBe(2);
        expect(state.mode.value).toBe('edit');
        expect(state.notice.value).toBe('笔记已创建。');
    });
});

describe('notes revision and recovery', () => {
    it('treats old or skipped PATCH revision as unknown rather than a saved draft', async () => {
        for (const revision of [1, 3]) {
            const { state } = setup(async (_input, init) =>
                method(init) === 'PATCH'
                    ? detail(note({ revision, body: body(init).body }))
                    : detail(),
            );
            await state.open(note());
            state.draft.value = '本地稿';
            await state.write();
            expect(state.lock.value).toBe('unknown-patch');
            expect(state.draft.value).toBe('本地稿');
            expect(state.dirty.value).toBe(true);
            expect(state.canSave.value).toBe(false);
        }
    });
    it('never authorizes editing from missing detail ETag or a mismatched response identity', async () => {
        for (const response of [Response.json(note()), detail(note({ id: id(99) }))]) {
            const { state } = setup(async () => response);
            await state.open(note());
            expect(state.canSave.value).toBe(false);
            expect(state.draft.value).toBe('');
            expect(state.lock.value).toBe('read');
        }
    });
    it('keeps malformed successful creation locked to the original attempt', async () => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json({ note: note({ body: '原稿' }), reused: false }, { status: 201 }),
        );
        const { state } = setup(fetcher);
        state.begin(target);
        state.draft.value = '原稿';
        await state.create();
        expect(state.attempt.value?.input.body).toBe('原稿');
        expect(state.canSave.value).toBe(false);
        await state.create();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('reads actual detail before edit, sends raw If-Match and leaves target immutable', async () => {
        const raw = '  修改\r\n**字面文本**  ';
        const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
            method(init) === 'PATCH'
                ? detail(note({ body: body(init).body, revision: 2 }))
                : detail(),
        );
        const { state } = setup(fetcher);
        await state.open(note({ body: '列表旧值', revision: 9 }));
        expect(state.draft.value).toBe('服务端原文');
        state.draft.value = raw;
        await state.write();
        const call = fetcher.mock.calls.find(([, init]) => method(init) === 'PATCH');
        expect(new Headers(call?.[1]?.headers).get('if-match')).toBe('"1"');
        expect(body(call?.[1])).toEqual({ body: raw });
        expect(state.draft.value).toBe(raw);
        expect(state.dirty.value).toBe(false);
    });
    it('409 preserves draft; reread updates only server copy until explicit keep-local rebase', async () => {
        let gets = 0,
            patches = 0;
        const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
            if (method(init) === 'PATCH') {
                if (++patches === 1) return failure(409, 'REVISION_CONFLICT');
                return detail(note({ revision: 3, body: body(init).body }));
            }
            return detail(++gets === 1 ? note() : note({ revision: 2, body: '其他标签正文' }));
        });
        const { state } = setup(fetcher);
        await state.open(note());
        state.draft.value = '我的未保存稿';
        await state.write();
        expect(state.lock.value).toBe('conflict');
        expect(state.draft.value).toBe('我的未保存稿');
        await state.read();
        expect(state.server.value?.body).toBe('其他标签正文');
        expect(state.draft.value).toBe('我的未保存稿');
        expect(state.canSave.value).toBe(false);
        await state.write();
        expect(patches).toBe(1);
        state.adopt(true);
        await state.write();
        const calls = fetcher.mock.calls.filter(([, init]) => method(init) === 'PATCH');
        expect(calls.map(([, init]) => new Headers(init?.headers).get('if-match'))).toEqual([
            '"1"',
            '"2"',
        ]);
        expect(state.draft.value).toBe('我的未保存稿');
    });
    it('explicit adopt replaces local draft only after actual successful reread', async () => {
        const { state } = setup(async () => detail());
        await state.open(note());
        state.draft.value = '本地稿';
        state.adopt(false);
        expect(state.draft.value).toBe('本地稿');
        await state.read();
        expect(state.draft.value).toBe('本地稿');
        state.adopt(false);
        expect(state.draft.value).toBe('服务端原文');
    });
    it.each(['PATCH', 'DELETE'])(
        'unknown %s stays locked despite canceled read rolling back to old success',
        async (action) => {
            let gets = 0;
            let release: (() => void) | undefined;
            const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
                if (method(init) === action) throw new TypeError('unknown write');
                if (++gets > 1)
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });
                return detail();
            });
            const { state, lifecycle } = setup(fetcher);
            await state.open(note());
            state.draft.value = '本地稿';
            await state.write(action === 'DELETE');
            expect(state.lock.value).toBe(action === 'PATCH' ? 'unknown-patch' : 'unknown-delete');
            const reading = state.read();
            await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            await lifecycle.queryClient.cancelQueries();
            release!();
            await reading;
            expect(state.lock.value).toBe(action === 'PATCH' ? 'unknown-patch' : 'unknown-delete');
            expect(state.reviewReady.value).toBe(false);
            expect(state.canSave.value).toBe(false);
            expect(state.draft.value).toBe('本地稿');
        },
    );
    it('confirms delete with actual detail ETag and never deletes associated resources', async () => {
        const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
            method(init) === 'DELETE'
                ? new Response(null, { status: 204 })
                : detail(note({ revision: 5 })),
        );
        const { state } = setup(fetcher);
        await state.open(note());
        await state.write(true);
        const call = fetcher.mock.calls.find(([, init]) => method(init) === 'DELETE');
        expect(new Headers(call?.[1]?.headers).get('if-match')).toBe('"5"');
        expect(state.lock.value).toBe('deleted');
        expect(
            fetcher.mock.calls
                .map(([input]) => requestUrl(input))
                .every((url) => url.includes('/notes/')),
        ).toBe(true);
    });
    it('unknown deletion needs actual GET404 and preserves draft for copying', async () => {
        let gets = 0;
        const { state } = setup(async (_input, init) => {
            if (method(init) === 'DELETE') throw new TypeError('lost response');
            return ++gets === 1 ? detail() : failure(404);
        });
        await state.open(note());
        state.draft.value = '可复制原稿';
        await state.write(true);
        await state.read();
        expect(state.lock.value).toBe('deleted');
        expect(state.draft.value).toBe('可复制原稿');
    });
    it('429 obeys real Retry-After without automatic writes or draft loss', async () => {
        const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
            method(init) === 'PATCH'
                ? failure(429, 'RATE_LIMITED', { 'retry-after': '1' })
                : detail(),
        );
        const { state } = setup(fetcher);
        await state.open(note());
        state.draft.value = '原稿';
        await state.write();
        expect(state.retryAt.value).toBeTypeOf('number');
        expect(state.waiting.value).toBe(true);
        expect(state.canSave.value).toBe(false);
        expect(state.draft.value).toBe('原稿');
        await state.write();
        expect(fetcher.mock.calls.filter(([, init]) => method(init) === 'PATCH')).toHaveLength(1);
        await vi.waitFor(() => expect(state.waiting.value).toBe(false), { timeout: 2000 });
        expect(fetcher.mock.calls.filter(([, init]) => method(init) === 'PATCH')).toHaveLength(1);
    });
    it('parses only actual valid Retry-After values and handles missing headers without invented time', async () => {
        for (const [value, expected] of [
            ['2', 3000],
            ['Thu, 01 Jan 1970 00:00:04 GMT', 4000],
            ['-1', undefined],
            ['1.5', undefined],
            ['0 GMT', undefined],
            ['invalid', undefined],
        ] as const) {
            const { lifecycle } = setup(async () =>
                failure(429, 'RATE_LIMITED', { 'retry-after': value }),
            );
            try {
                await lifecycle
                    .capture()
                    .request(
                        patchNoteEndpoint,
                        { params: { noteId: id(1) }, body: { body: '稿' } },
                        { ifMatch: '"1"' },
                    );
            } catch (cause) {
                expect(noteRetryAt(cause, 1000)).toBe(expected);
            }
        }
        const { state } = setup(async (_input, init) =>
            method(init) === 'PATCH' ? failure(429) : detail(),
        );
        await state.open(note());
        state.draft.value = '稿';
        await state.write();
        expect(state.retryAt.value).toBeUndefined();
        expect(state.draft.value).toBe('稿');
    });
});

describe('notes scope and pagination', () => {
    it('actually GETs the fresh cached first page after a later-page cursor fails', async () => {
        let firstReads = 0;
        const { notes } = setup(async (input) => {
            if (requestUrl(input).includes('cursor=next')) return failure(400, 'INVALID_CURSOR');
            firstReads++;
            return page([note()], 'next');
        }, true);
        await vi.waitFor(() => expect(notes!.items.value).toHaveLength(1));
        expect(firstReads).toBe(1);
        notes!.next();
        await vi.waitFor(() => expect(notes!.query.isError.value).toBe(true));
        await notes!.first();
        expect(firstReads).toBe(2);
        expect(notes!.query.isSuccess.value).toBe(true);
        expect(notes!.previous.value).toEqual([]);
    });
    it('retains local draft while parent report is unavailable and blocks reads/writes/new targets', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => detail());
        const { state, available } = setup(fetcher);
        await state.open(note());
        state.draft.value = '背景失败后仍可复制的原稿';
        available.value = false;
        expect(state.canSave.value).toBe(false);
        await state.write();
        await state.write(true);
        await state.read();
        state.begin({ kind: 'report', id: id(30) });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(state.target.value).toEqual(target);
        expect(state.draft.value).toBe('背景失败后仍可复制的原稿');
        expect(state.canLeave(() => false)).toBe(false);
        available.value = true;
        expect(state.draft.value).toBe('背景失败后仍可复制的原稿');
    });
    it('blocks unknown-create replay while report is unavailable without losing its original attempt', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => {
            throw new TypeError('unknown');
        });
        const { state, available } = setup(fetcher);
        state.begin(target);
        state.draft.value = '原稿';
        await state.create();
        const attempt = state.attempt.value;
        available.value = false;
        await state.create(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(state.attempt.value).toBe(attempt);
        expect(state.draft.value).toBe('原稿');
    });
    it('hides cached server rows after permission/protocol errors while retaining them for transient failure', async () => {
        let response = page([note()]);
        const { notes } = setup(async () => response, true);
        await vi.waitFor(() => expect(notes!.items.value).toHaveLength(1));
        response = failure(503);
        await notes!.query.refetch();
        expect(notes!.items.value).toHaveLength(1);
        response = failure(403);
        await notes!.query.refetch();
        expect(notes!.items.value).toEqual([]);
        response = page([note()]);
        await notes!.query.refetch();
        response = Response.json({ items: [{ ...note(), revision: 0 }], nextCursor: null });
        await notes!.query.refetch();
        expect(notes!.items.value).toEqual([]);
    });
    it('all notes remain independent from bookmarks; page filters retain typed targets and first-page recovery', async () => {
        const fetcher = vi.fn<typeof fetch>(async (input) =>
            requestUrl(input).includes('cursor=next')
                ? page([note({ id: id(2) })])
                : page([note()], 'next'),
        );
        const { notes, filter } = setup(fetcher, true);
        await vi.waitFor(() => expect(notes!.items.value).toHaveLength(1));
        expect(requestUrl(fetcher.mock.calls[0]![0])).not.toContain('sourceId');
        notes!.next();
        await vi.waitFor(() => expect(notes!.items.value[0]?.id).toBe(id(2)));
        await notes!.first();
        await vi.waitFor(() => expect(notes!.items.value[0]?.id).toBe(id(1)));
        filter.value = target;
        await vi.waitFor(() =>
            expect(
                fetcher.mock.calls.some(([input]) =>
                    requestUrl(input).includes(`sourceId=${id(20)}`),
                ),
            ).toBe(true),
        );
        expect(
            fetcher.mock.calls.every(([input]) => !requestUrl(input).includes('bookmarks')),
        ).toBe(true);
    });
    it('guards drafts and unknown attempts before target/page/route changes', async () => {
        const { state } = setup(async () => {
            throw new TypeError('unknown');
        });
        state.begin(target);
        state.draft.value = '未保存';
        expect(state.canLeave(() => false)).toBe(false);
        expect(state.canLeave(() => true)).toBe(true);
        await state.create();
        const confirm = vi.fn(() => true);
        expect(state.canLeave(confirm)).toBe(false);
        expect(confirm).not.toHaveBeenCalled();
        expect(state.draft.value).toBe('未保存');
    });
    it('account replacement destroys old draft/attempt and isolates late success', async () => {
        let release: ((value: Response) => void) | undefined;
        const { state, lifecycle } = setup(
            async () =>
                new Promise<Response>((resolve) => {
                    release = resolve;
                }),
        );
        state.begin(target);
        state.draft.value = '旧账号原稿';
        const writing = state.create();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        lifecycle.replaceSession({ ...account, user: { ...account.user!, id: id(101) } });
        expect(state.draft.value).toBe('');
        expect(state.attempt.value).toBeUndefined();
        release!(created(note({ body: '旧账号原稿' })));
        await writing;
        expect(state.mode.value).toBe('closed');
        expect(state.server.value).toBeUndefined();
        expect(
            lifecycle.queryClient
                .getQueryCache()
                .getAll()
                .every((query) => query.queryKey[1] !== id(100)),
        ).toBe(true);
    });
});
