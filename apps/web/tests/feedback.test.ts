import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, ref } from 'vue';
import {
    FeedbackInputSchema,
    parseContract,
    type Feedback,
    type Report,
    type SessionResponse,
} from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { revokeFeedbackEndpoint, setFeedbackEndpoint, taskFeedbackEndpoint } from '@/api/feedback';
import {
    reportFeedbackTargets,
    targetKey,
    useFeedback,
    validateFeedbackList,
    type FeedbackTarget,
} from '@/composable/useFeedback';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const taskId = id(2);
const source: FeedbackTarget = { type: 'source', id: id(21), label: '招生资料' };
const claim: FeedbackTarget = { type: 'claim', id: id(10), label: '申请费为100元' };
function feedback(extra: Partial<Feedback> = {}): Feedback {
    return {
        id: id(40),
        taskId,
        sourceId: source.id,
        claimId: null,
        kind: 'known',
        active: true,
        updatedAt: '2026-10-31T01:00:00Z',
        ...extra,
    };
}
const account: SessionResponse = {
    user: {
        id: id(100),
        email: 'test@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'test-only',
};
const disposals: (() => void)[] = [];
function setup(
    fetcher: typeof fetch,
    targetValue: FeedbackTarget | undefined = source,
    taskValue: unknown = taskId,
) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const target = ref<FeedbackTarget | undefined>(targetValue);
    const task = ref(taskValue);
    const scope = effectScope();
    const state = scope.run(() => useFeedback(task, target, lifecycle))!;
    disposals.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { lifecycle, target, task, state, scope };
}
const failure = (status: number, code = 'TEST_FAILURE') =>
    Response.json({ code, message: 'test', requestId: 'test' }, { status });
function requestUrl(input: RequestInfo | URL) {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
function requestBody(init?: RequestInit) {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
    return JSON.parse(init.body) as unknown;
}
async function ready(state: ReturnType<typeof useFeedback>) {
    await vi.waitFor(() => expect(state.canWrite.value).toBe(true));
}
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

describe('feedback targets and contract', () => {
    it('accepts 200 active typed targets and rejects a 201st without conflating source/claim UUIDs', () => {
        const shared = [feedback(), feedback({ id: id(41), sourceId: null, claimId: source.id })];
        expect(validateFeedbackList(shared, taskId)).toEqual(shared);
        const full = Array.from({ length: 200 }, (_, index) =>
            feedback({ id: id(1000 + index), sourceId: id(2000 + index) }),
        );
        expect(validateFeedbackList(full, taskId)).toHaveLength(200);
        expect(() => validateFeedbackList([...full, feedback()], taskId)).toThrow();
    });
    it('deduplicates sources without conflating claim ids and preserves target text', () => {
        const report = {
            evidence: [
                { sourceId: source.id, title: '<img>招生资料' },
                { sourceId: source.id, title: '同来源另一引用' },
            ],
            claims: [{ id: source.id, text: '<script>结论文本' }],
        } as unknown as Report;
        const targets = reportFeedbackTargets(report);
        expect(targets).toHaveLength(2);
        expect(targets.map(targetKey)).toEqual([`source:${source.id}`, `claim:${source.id}`]);
        expect(targets.map((entry) => entry.label)).toEqual(['<img>招生资料', '<script>结论文本']);
        expect(report.evidence).toHaveLength(2);
    });
    it('requires exactly one source or claim and rejects malformed ids before transport', async () => {
        expect(() => parseContract(FeedbackInputSchema, { taskId, kind: 'known' })).toThrow();
        expect(() =>
            parseContract(FeedbackInputSchema, {
                taskId,
                sourceId: source.id,
                claimId: claim.id,
                kind: 'known',
            }),
        ).toThrow();
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: [] }));
        const { lifecycle } = setup(fetcher, source, 'invalid');
        await expect(
            lifecycle.capture().request(taskFeedbackEndpoint, { params: { taskId: '../invalid' } }),
        ).rejects.toThrow();
        await expect(
            lifecycle
                .capture()
                .request(revokeFeedbackEndpoint, { params: { feedbackId: 'invalid' } }),
        ).rejects.toThrow();
        await expect(
            lifecycle.capture().request(setFeedbackEndpoint, {
                body: { taskId, sourceId: 'invalid', kind: 'known' },
            }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each([
        { entries: [feedback({ taskId: id(99) })] },
        { entries: [feedback({ active: false })] },
        { entries: [feedback(), feedback({ id: id(41) })] },
        { entries: [feedback(), feedback({ sourceId: id(22) })] },
    ])('rejects wrong task, inactive, duplicate target or id lists', ({ entries }) => {
        expect(() => validateFeedbackList(entries, taskId)).toThrow();
    });
});

describe('feedback actions', () => {
    it('does not abort an accepted write merely because the same target label gets refreshed', async () => {
        let release!: (response: Response) => void;
        let signal: AbortSignal | null | undefined;
        let stored = feedback();
        const { state, target } = setup(async (_url, init) => {
            if (init?.method === 'POST') {
                signal = init.signal;
                return new Promise<Response>((resolve) => {
                    release = resolve;
                });
            }
            return Response.json({ items: [stored] });
        });
        await ready(state);
        const writing = state.write('deeper');
        await vi.waitFor(() => expect(release).toBeDefined());
        target.value = { ...source, label: '刷新后的同一目标标题' };
        stored = feedback({ kind: 'deeper' });
        release(Response.json(stored));
        await writing;
        expect(signal?.aborted).toBe(false);
        expect(state.needsRecheck.value).toBe(false);
        expect(state.current.value?.kind).toBe('deeper');
        expect(target.value.label).toBe('刷新后的同一目标标题');
    });
    it.each(['irrelevant', 'known', 'deeper'] as const)(
        'sets %s through Cookie/CSRF requestlane and installs only confirmed response',
        async (kind) => {
            const calls: { url: string; init?: RequestInit }[] = [];
            let stored: Feedback | undefined;
            const { state } = setup(async (url, init) => {
                calls.push({ url: requestUrl(url), init });
                if (init?.method === 'POST') {
                    stored = feedback({ kind });
                    return Response.json(stored);
                }
                return Response.json({ items: stored ? [stored] : [] });
            });
            await ready(state);
            expect(state.current.value).toBeUndefined();
            await state.write(kind);
            expect(state.current.value?.kind).toBe(kind);
            const post = calls.find((call) => call.init?.method === 'POST')!;
            expect(post.url).toBe('/api/v1/feedback');
            expect(post.init?.credentials).toBe('include');
            expect(new Headers(post.init?.headers).get('x-csrf-token')).toBe('test-only');
            expect(requestBody(post.init)).toEqual({
                taskId,
                sourceId: source.id,
                kind,
            });
            expect(state.notice.value).toContain('已设置');
        },
    );
    it('binds a claim separately and never mutates report-shaped target text', async () => {
        let body: unknown;
        let stored: Feedback | undefined;
        const { state, target } = setup(async (_url, init) => {
            if (init?.method === 'POST') {
                body = requestBody(init);
                stored = feedback({ sourceId: null, claimId: claim.id, kind: 'deeper' });
                return Response.json(stored);
            }
            return Response.json({ items: stored ? [stored] : [] });
        }, claim);
        await ready(state);
        await state.write('deeper');
        expect(body).toEqual({ taskId, claimId: claim.id, kind: 'deeper' });
        expect(target.value).toEqual(claim);
        expect(state.current.value?.claimId).toBe(claim.id);
    });
    it('switches same id and does not send duplicate same-kind settings', async () => {
        let stored = feedback();
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            if (init?.method === 'POST') stored = feedback({ kind: 'deeper' });
            return Response.json(init?.method === 'POST' ? stored : { items: [stored] });
        });
        const { state } = setup(fetcher);
        await ready(state);
        await state.write('known');
        expect(fetcher).toHaveBeenCalledTimes(1);
        await state.write('deeper');
        expect(state.items.value).toHaveLength(1);
        expect(state.current.value?.id).toBe(id(40));
        expect(state.current.value?.kind).toBe('deeper');
    });
    it('allows switching an active item at 200 without adding another entry', async () => {
        const entries = [
            feedback(),
            ...Array.from({ length: 199 }, (_, index) =>
                feedback({ id: id(1000 + index), sourceId: id(2000 + index) }),
            ),
        ];
        const { state } = setup(async (_url, init) => {
            if (init?.method === 'POST') entries[0] = feedback({ kind: 'deeper' });
            return Response.json(init?.method === 'POST' ? entries[0] : { items: entries });
        });
        await ready(state);
        await state.write('deeper');
        expect(state.current.value?.id).toBe(id(40));
        expect(state.current.value?.kind).toBe('deeper');
        expect(state.items.value).toHaveLength(200);
    });
    it('revokes a selected or another task feedback with DELETE 200 active false', async () => {
        const other = feedback({ id: id(41), sourceId: id(22) });
        const calls: string[] = [];
        let revoked = false;
        const { state } = setup(async (url, init) => {
            calls.push(`${init?.method} ${requestUrl(url)}`);
            if (init?.method === 'DELETE') revoked = true;
            return init?.method === 'DELETE'
                ? Response.json({ ...other, active: false })
                : Response.json({ items: revoked ? [feedback()] : [feedback(), other] });
        });
        await ready(state);
        await state.write(null, other);
        expect(calls[1]).toBe(`DELETE /api/v1/feedback/${other.id}`);
        expect(state.items.value).toEqual([feedback()]);
        expect(state.notice.value).toContain('已撤销');
    });
    it.each([404, 409, 403])(
        'preserves current display on known HTTP %i and never retries writes',
        async (status) => {
            const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
                init?.method === 'POST'
                    ? failure(status, status === 409 ? 'FEEDBACK_LIMIT' : 'NOT_FOUND')
                    : Response.json({ items: [feedback()] }),
            );
            const { state } = setup(fetcher);
            await ready(state);
            await state.write('irrelevant');
            expect(state.current.value?.kind).toBe('known');
            expect(state.needsRecheck.value).toBe(false);
            expect(fetcher).toHaveBeenCalledTimes(2);
            expect(state.notice.value).toContain(
                status === 409 ? '200' : status === 404 ? '目标不存在' : '未能提交',
            );
        },
    );
    it('blocks repeated writes synchronously and leaves old kind while pending', async () => {
        let release!: (response: Response) => void;
        let stored = feedback();
        const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
            init?.method === 'POST'
                ? new Promise<Response>((resolve) => {
                      release = resolve;
                  })
                : Response.json({ items: [stored] }),
        );
        const { state } = setup(fetcher);
        await ready(state);
        const first = state.write('deeper');
        await state.write('irrelevant');
        expect(state.pending.value).toBe(true);
        expect(state.current.value?.kind).toBe('known');
        await vi.waitFor(() => expect(release).toBeDefined());
        stored = feedback({ kind: 'deeper' });
        release(Response.json(feedback({ kind: 'deeper' })));
        await first;
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(state.current.value?.kind).toBe('deeper');
    });
    it('requires an actual successful reread after an unknown write; failed reread does not unlock', async () => {
        let reads = 0;
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            if (init?.method === 'POST') throw new TypeError('connection lost after send');
            reads++;
            return reads === 2
                ? failure(503)
                : Response.json({ items: [feedback({ kind: reads > 2 ? 'deeper' : 'known' })] });
        });
        const { state } = setup(fetcher);
        await ready(state);
        await state.write('deeper');
        expect(state.needsRecheck.value).toBe(true);
        expect(state.notice.value).toContain('尚未确认');
        expect(state.current.value?.kind).toBe('known');
        await state.write('irrelevant');
        expect(fetcher).toHaveBeenCalledTimes(2);
        await state.reload();
        expect(state.needsRecheck.value).toBe(true);
        expect(state.canWrite.value).toBe(false);
        expect(state.current.value?.kind).toBe('known');
        await state.reload();
        expect(state.needsRecheck.value).toBe(false);
        expect(state.current.value?.kind).toBe('deeper');
        expect(state.canWrite.value).toBe(true);
    });
    it.each([
        feedback({ taskId: id(88), kind: 'deeper' }),
        feedback({ sourceId: id(88), kind: 'deeper' }),
        feedback({ kind: 'irrelevant' }),
        feedback({ kind: 'deeper', active: false }),
        feedback({ id: id(41), kind: 'deeper' }),
    ])('does not install mismatched write success and asks to reread', async (response) => {
        const { state } = setup(async (_url, init) =>
            init?.method === 'POST'
                ? Response.json(response)
                : Response.json({ items: [feedback()] }),
        );
        await ready(state);
        await state.write('deeper');
        expect(state.current.value?.kind).toBe('known');
        expect(state.needsRecheck.value).toBe(true);
    });
    it('hides inaccessible list after 404 and prevents writes for invalid task or missing target', async () => {
        let missing = false;
        const fetcher = vi.fn<typeof fetch>(async () =>
            missing ? failure(404) : Response.json({ items: [feedback()] }),
        );
        const { state, target, task } = setup(fetcher);
        await ready(state);
        target.value = undefined;
        await state.write('known');
        expect(fetcher).toHaveBeenCalledTimes(1);
        missing = true;
        await state.reload();
        expect(state.items.value).toEqual([]);
        expect(state.itemsKnown.value).toBe(false);
        expect(state.canWrite.value).toBe(false);
        task.value = 'invalid';
        await state.write('known');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('shares one task cache across target changes and restores persisted server state on reload', async () => {
        let stored = feedback();
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
            if (init?.method === 'POST') stored = feedback({ kind: 'deeper' });
            return Response.json(init?.method === 'POST' ? stored : { items: [stored] });
        });
        const { state, target, lifecycle } = setup(fetcher);
        await ready(state);
        await state.write('deeper');
        target.value = claim;
        expect(state.current.value).toBeUndefined();
        target.value = source;
        expect(state.current.value?.kind).toBe('deeper');
        expect(lifecycle.queryClient.getQueryCache().getAll()).toHaveLength(1);
        await state.reload();
        expect(state.current.value?.kind).toBe('deeper');
    });
    it('fetches actual server state when an unknown write panel remounts within cache freshness', async () => {
        let reads = 0;
        const { state, scope, lifecycle } = setup(async (_url, init) => {
            if (init?.method === 'POST') throw new TypeError('response lost');
            reads++;
            return Response.json({ items: [feedback({ kind: reads > 1 ? 'deeper' : 'known' })] });
        });
        await ready(state);
        await state.write('deeper');
        expect(state.needsRecheck.value).toBe(true);
        scope.stop();
        const replacementScope = effectScope();
        const replacement = replacementScope.run(() => useFeedback(taskId, source, lifecycle))!;
        disposals.push(() => replacementScope.stop());
        await ready(replacement);
        expect(reads).toBe(2);
        expect(replacement.current.value?.kind).toBe('deeper');
    });
    it('does not unlock an unknown write when reread is canceled back to successful cache', async () => {
        let reads = 0;
        let release!: (response: Response) => void;
        const { state, lifecycle } = setup(async (_url, init) => {
            if (init?.method === 'POST') throw new TypeError('response lost');
            reads++;
            if (reads === 1) return Response.json({ items: [feedback()] });
            return new Promise<Response>((resolve) => {
                release = resolve;
            });
        });
        await ready(state);
        await state.write('deeper');
        const reread = state.reload();
        await vi.waitFor(() => expect(release).toBeDefined());
        const key = lifecycle.queryClient.getQueryCache().getAll()[0]!.queryKey;
        await lifecycle.queryClient.cancelQueries({ queryKey: key, exact: true });
        await reread;
        release(Response.json({ items: [feedback({ kind: 'deeper' })] }));
        expect(state.query.isSuccess.value).toBe(true);
        expect(state.needsRecheck.value).toBe(true);
        expect(state.canWrite.value).toBe(false);
        expect(state.current.value?.kind).toBe('known');
    });
    it('hides cached items after malformed JSON protocol failure', async () => {
        let malformed = false;
        const { state } = setup(async () =>
            malformed
                ? new Response('{broken', { headers: { 'content-type': 'application/json' } })
                : Response.json({ items: [feedback()] }),
        );
        await ready(state);
        malformed = true;
        await state.reload();
        expect(state.itemsKnown.value).toBe(false);
        expect(state.items.value).toEqual([]);
        expect(state.readError.value).toContain('校验失败');
        expect(state.canWrite.value).toBe(false);
    });
    it('refreshes only the exact task feedback after success and waits for the refreshed list', async () => {
        let reads = 0;
        let release!: (response: Response) => void;
        const { state, lifecycle } = setup(async (_url, init) => {
            if (init?.method === 'POST') return Response.json(feedback({ kind: 'deeper' }));
            reads++;
            if (reads === 1) return Response.json({ items: [feedback()] });
            return new Promise<Response>((resolve) => {
                release = resolve;
            });
        });
        await ready(state);
        const otherFeedbackKey = [
            'session',
            account.user.id,
            lifecycle.session.epoch,
            'feedback',
            id(99),
        ];
        const reportKey = ['session', account.user.id, lifecycle.session.epoch, 'reports', id(1)];
        lifecycle.queryClient.setQueryData(otherFeedbackKey, { items: [] });
        lifecycle.queryClient.setQueryData(reportKey, { unchanged: true });
        const write = state.write('deeper');
        await vi.waitFor(() => expect(release).toBeDefined());
        expect(state.pending.value).toBe(true);
        expect(state.current.value?.kind).toBe('deeper');
        const concurrent = feedback({ id: id(41), sourceId: id(22) });
        release(Response.json({ items: [feedback({ kind: 'deeper' }), concurrent] }));
        await write;
        expect(state.items.value).toHaveLength(2);
        expect(state.pending.value).toBe(false);
        expect(lifecycle.queryClient.getQueryState(otherFeedbackKey)?.isInvalidated).toBe(false);
        expect(lifecycle.queryClient.getQueryState(reportKey)?.isInvalidated).toBe(false);
        expect(lifecycle.queryClient.getQueryData(reportKey)).toEqual({ unchanged: true });
    });
    it('cancels a concurrent old GET before installing confirmed feedback so it cannot overwrite it', async () => {
        let reads = 0;
        let releaseRead!: (response: Response) => void;
        let releaseWrite!: (response: Response) => void;
        let readSignal: AbortSignal | null | undefined;
        const { state, lifecycle } = setup(async (_url, init) => {
            if (init?.method === 'POST')
                return new Promise<Response>((resolve) => {
                    releaseWrite = resolve;
                });
            reads++;
            if (reads === 1) return Response.json({ items: [feedback()] });
            if (reads > 2) return Response.json({ items: [feedback({ kind: 'deeper' })] });
            readSignal = init?.signal;
            return new Promise<Response>((resolve) => {
                releaseRead = resolve;
            });
        });
        await ready(state);
        const write = state.write('deeper');
        await vi.waitFor(() => expect(releaseWrite).toBeDefined());
        const refetch = lifecycle.queryClient.invalidateQueries({
            predicate: (query) => query.queryKey[3] === 'feedback',
        });
        await vi.waitFor(() => expect(releaseRead).toBeDefined());
        releaseWrite(Response.json(feedback({ kind: 'deeper' })));
        await write;
        expect(readSignal?.aborted).toBe(true);
        releaseRead(Response.json({ items: [feedback()] }));
        await refetch;
        expect(state.current.value?.kind).toBe('deeper');
    });
    it.each([200, 401])(
        'ignores late old-account write HTTP %i and keeps the new account',
        async (status) => {
            let release!: (response: Response) => void;
            let signal: AbortSignal | null | undefined;
            const { state, lifecycle } = setup(async (_url, init) => {
                if (init?.method !== 'POST') return Response.json({ items: [] });
                signal = init.signal;
                return new Promise<Response>((resolve) => {
                    release = resolve;
                });
            });
            await ready(state);
            const write = state.write('deeper');
            await vi.waitFor(() => expect(release).toBeDefined());
            lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(101) } });
            release(status === 200 ? Response.json(feedback({ kind: 'deeper' })) : failure(status));
            await write;
            await ready(state);
            expect(signal?.aborted).toBe(true);
            expect(state.items.value).toEqual([]);
            expect(state.notice.value).toBe('');
            expect(lifecycle.session.user?.id).toBe(id(101));
        },
    );
    it('aborts late target writes, requires reread, and clears unknown lock on task change', async () => {
        let release!: (response: Response) => void;
        let signal: AbortSignal | null | undefined;
        const { state, target, task } = setup(async (_url, init) => {
            if (init?.method !== 'POST') return Response.json({ items: [] });
            signal = init.signal;
            return new Promise<Response>((resolve) => {
                release = resolve;
            });
        });
        await ready(state);
        const write = state.write('deeper');
        await vi.waitFor(() => expect(release).toBeDefined());
        target.value = claim;
        release(Response.json(feedback({ kind: 'deeper' })));
        await write;
        expect(signal?.aborted).toBe(true);
        expect(state.needsRecheck.value).toBe(true);
        expect(state.items.value).toEqual([]);
        task.value = id(3);
        await ready(state);
        expect(state.needsRecheck.value).toBe(false);
    });
    it('cancels pending write on scope disposal without installing it', async () => {
        let release!: (response: Response) => void;
        let signal: AbortSignal | null | undefined;
        const { state, scope, lifecycle } = setup(async (_url, init) => {
            if (init?.method !== 'POST') return Response.json({ items: [] });
            signal = init.signal;
            return new Promise<Response>((resolve) => {
                release = resolve;
            });
        });
        await ready(state);
        const write = state.write('deeper');
        await vi.waitFor(() => expect(release).toBeDefined());
        scope.stop();
        release(Response.json(feedback({ kind: 'deeper' })));
        await write;
        expect(signal?.aborted).toBe(true);
        const cached = lifecycle.queryClient.getQueryCache().getAll()[0]?.state.data as {
            data: { items: Feedback[] };
        };
        expect(cached.data.items).toEqual([]);
    });
});
