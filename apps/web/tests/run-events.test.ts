import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Run, RunEvent, SessionResponse, SseMessage } from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import { subscribeRunEvents } from '@/api/run-events';
import { runQueryOptions } from '@/api/runs';
import { createApp, effectScope, nextTick, ref } from 'vue';
import { sessionLifecycleKey } from '@/api/session';
import { useRunEvents } from '@/composables/useRunEvents';

const runId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000009';
const instant = '2026-10-31T00:00:00Z';
const run: Run = {
    id: runId,
    taskId: otherId,
    taskVersionId: otherId,
    parentRunId: null,
    baselineRunId: null,
    mode: 'demo',
    status: 'queued',
    outcome: null,
    trigger: 'manual',
    budget: {
        maxSearches: 2,
        maxPages: 3,
        maxDurationSeconds: 60,
        maxInputTokens: 1000,
        maxOutputTokens: 500,
    },
    usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
    coverage: null,
    queuedAt: instant,
    startedAt: null,
    finishedAt: null,
    failureCode: null,
};
const finished: Run = { ...run, status: 'failed', failureCode: 'NO_EVIDENCE', finishedAt: instant };
const account: SessionResponse = {
    user: {
        id: otherId,
        email: 'a@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: instant,
    },
    csrfToken: 'local-test-csrf',
};
function event(seq: number): RunEvent {
    return {
        schemaVersion: 1,
        type: 'run.failed',
        runId,
        eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        seq,
        occurredAt: instant,
        payload: { status: 'failed', code: 'NO_EVIDENCE', message: 'sample' },
    };
}
function frame(message: SseMessage) {
    return `${'eventId' in message ? `id: ${message.eventId}\n` : ''}event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
}
function stream(text: string) {
    return new Response(text, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function hanging(onCancel = () => {}) {
    return new Response(new ReadableStream<Uint8Array>({ cancel: onCancel }), {
        headers: { 'content-type': 'text/event-stream' },
    });
}
const active: ReturnType<typeof createSessionLifecycle>[] = [];
function setup(fetcher: typeof fetch) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    active.push(lifecycle);
    return lifecycle;
}
afterEach(() => active.splice(0).forEach((lifecycle) => lifecycle.dispose()));
const policy = { backoffMs: 0, maxReconnects: 2, headerTimeoutMs: 1000, idleTimeoutMs: 1000 };

describe('native run stream lifecycle', () => {
    it('uses a stable parameterized key and validates the fetched Run identity', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockImplementation(async () => Response.json(finished));
        const lifecycle = setup(fetcher);
        const first = runQueryOptions(lifecycle, runId);
        const second = runQueryOptions(lifecycle, runId);
        expect(second.queryKey).toEqual(first.queryKey);
        expect(runQueryOptions(lifecycle, otherId).queryKey).not.toEqual(first.queryKey);
        await lifecycle.queryClient.fetchQuery(first);
        expect(lifecycle.queryClient.getQueryData(second.queryKey)).toMatchObject({
            data: finished,
        });
        expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/runs/${runId}`);
        await expect(
            lifecycle.queryClient.fetchQuery(runQueryOptions(lifecycle, otherId)),
        ).rejects.toMatchObject({ kind: 'protocol' });
    });
    it('keeps an authoritative snapshot when an earlier Query response arrives late', async () => {
        let resolveOld!: (response: Response) => void;
        const fetcher = vi
            .fn<typeof fetch>()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveOld = resolve;
                    }),
            )
            .mockResolvedValueOnce(stream(frame(event(1))))
            .mockResolvedValueOnce(Response.json(finished));
        const lifecycle = setup(fetcher);
        const query = runQueryOptions(lifecycle, runId);
        const oldQuery = lifecycle.queryClient.fetchQuery(query).catch(() => undefined);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        const subscription = subscribeRunEvents(lifecycle, runId, policy);
        await subscription.done;
        expect(subscription.state.value).toBe('complete');
        resolveOld(Response.json(run));
        await oldQuery;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(lifecycle.queryClient.getQueryData(query.queryKey)).toMatchObject({
            data: finished,
        });
    });
    it('processes monotonic events once, then installs authoritative terminal snapshot', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                stream(frame(event(1)) + frame(event(2)) + frame(event(1)) + frame(event(2))),
            )
            .mockResolvedValueOnce(Response.json(finished));
        const lifecycle = setup(fetcher);
        const events: RunEvent[] = [];
        const subscription = subscribeRunEvents(lifecycle, runId, {
            ...policy,
            onEvent: (message) => {
                events.push(message);
            },
        });
        await subscription.done;
        expect(events.map((event) => event.seq)).toEqual([1, 2]);
        expect(subscription.state.value).toBe('complete');
        expect(fetcher.mock.calls[0]![1]?.credentials).toBe('same-origin');
        expect(fetcher.mock.calls[0]![1]?.cache).toBe('no-store');
        expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('accept')).toBe(
            'text/event-stream',
        );
        expect(
            lifecycle.queryClient.getQueryData(runQueryOptions(lifecycle, runId).queryKey),
        ).toMatchObject({ data: finished });
    });
    it('reconnects N to N+1 with both legal cursor fields and never calls a disconnect a failed Run', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(stream(frame(event(1))))
            .mockResolvedValueOnce(Response.json(run))
            .mockResolvedValueOnce(stream(frame(event(2))))
            .mockResolvedValueOnce(Response.json(finished));
        const lifecycle = setup(fetcher);
        const events: number[] = [];
        const subscription = subscribeRunEvents(lifecycle, runId, {
            ...policy,
            onEvent: (event) => {
                events.push(event.seq);
            },
        });
        await subscription.done;
        expect(events).toEqual([1, 2]);
        expect(fetcher.mock.calls[2]![0]).toBe(`/api/v1/runs/${runId}/events?after=1`);
        expect(new Headers(fetcher.mock.calls[2]![1]?.headers).get('last-event-id')).toBe(
            event(1).eventId,
        );
        expect(subscription.state.value).toBe('complete');
        expect(fetcher).toHaveBeenCalledTimes(4);
    });
    it('replaces reset snapshot and reconnects with after only, without inventing an event ID', async () => {
        const reset: SseMessage = {
            schemaVersion: 1,
            type: 'stream.reset',
            runId,
            payload: { reason: 'cursor_expired', snapshot: run, resumeAfter: 7 },
        };
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(stream(frame(event(1)) + frame(reset)))
            .mockResolvedValueOnce(stream(frame(event(8))))
            .mockResolvedValueOnce(Response.json(finished));
        const snapshots: Run[] = [];
        const subscription = subscribeRunEvents(setup(fetcher), runId, {
            ...policy,
            onSnapshot: (snapshot) => {
                snapshots.push(snapshot);
            },
        });
        await subscription.done;
        expect(snapshots).toEqual([run, finished]);
        expect(fetcher.mock.calls[1]![0]).toBe(`/api/v1/runs/${runId}/events?after=7`);
        expect(new Headers(fetcher.mock.calls[1]![1]?.headers).has('last-event-id')).toBe(false);
    });
    it('keeps completed messages before an invalid frame in the same chunk and stops retrying bad protocol', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(stream(frame(event(1)) + 'event: run.failed\ndata: broken\n\n'));
        const events: number[] = [];
        const subscription = subscribeRunEvents(setup(fetcher), runId, {
            ...policy,
            onEvent: (event) => {
                events.push(event.seq);
            },
        });
        await subscription.done;
        expect(events).toEqual([1]);
        expect(subscription.state.value).toBe('error');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('retries an EOF-truncated frame using only the last completed cursor', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(stream(frame(event(1)) + frame(event(2)).slice(0, -2)))
            .mockResolvedValueOnce(stream(frame(event(2))))
            .mockResolvedValueOnce(Response.json(finished));
        const events: number[] = [];
        const subscription = subscribeRunEvents(setup(fetcher), runId, {
            ...policy,
            onEvent: (event) => {
                events.push(event.seq);
            },
        });
        await subscription.done;
        expect(events).toEqual([1, 2]);
        expect(fetcher.mock.calls[1]![0]).toContain('after=1');
        expect(subscription.state.value).toBe('complete');
    });
    it.each([401, 403])(
        'handles %s without retries or clearing the wrong account',
        async (status) => {
            const fetcher = vi
                .fn<typeof fetch>()
                .mockResolvedValue(
                    Response.json(
                        { code: 'DENIED', message: 'sample', requestId: 'sample' },
                        { status },
                    ),
                );
            const lifecycle = setup(fetcher);
            const subscription = subscribeRunEvents(lifecycle, runId, policy);
            await subscription.done;
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(lifecycle.session.user?.id ?? null).toBe(
                status === 401 ? null : account.user.id,
            );
            expect(subscription.state.value).toBe(status === 401 ? 'closed' : 'error');
        },
    );
    it('rejects a successful non-SSE response without retry', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ fake: true }));
        const subscription = subscribeRunEvents(setup(fetcher), runId, policy);
        await subscription.done;
        expect(subscription.state.value).toBe('error');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('bounds retries after network failure', async () => {
        const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
        const subscription = subscribeRunEvents(setup(fetcher), runId, policy);
        await subscription.done;
        expect(subscription.state.value).toBe('error');
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(subscription.error.value?.message).toBe('offline');
    });
    it('retains the latest HTTP error metadata after its retry budget is exhausted', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockImplementation(async () =>
                Response.json(
                    { code: 'UNAVAILABLE', message: '暂不可用', requestId: 'retry-trace' },
                    { status: 503 },
                ),
            );
        const subscription = subscribeRunEvents(setup(fetcher), runId, policy);
        await subscription.done;
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(subscription.error.value).toMatchObject({
            status: 503,
            code: 'UNAVAILABLE',
            requestId: 'retry-trace',
            message: '暂不可用',
        });
    });
    it('handles a rejected async callback once without retrying delivery', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockImplementation(async () => stream(frame(event(1))));
        const callback = vi.fn(async () => {
            throw new Error('async consumer failure');
        });
        const subscription = subscribeRunEvents(setup(fetcher), runId, {
            ...policy,
            onEvent: callback,
        });
        await subscription.done;
        expect(subscription.state.value).toBe('error');
        expect(callback).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(['event', 'snapshot'] as const)(
        'stops instead of replaying a failing %s callback',
        async (kind) => {
            const fetcher = vi
                .fn<typeof fetch>()
                .mockResolvedValueOnce(stream(frame(event(1))))
                .mockResolvedValue(Response.json(finished));
            const callback = vi.fn(() => {
                throw new Error('consumer failure');
            });
            const subscription = subscribeRunEvents(setup(fetcher), runId, {
                ...policy,
                ...(kind === 'event' ? { onEvent: callback } : { onSnapshot: callback }),
            });
            await subscription.done;
            expect(callback).toHaveBeenCalledTimes(1);
            expect(fetcher).toHaveBeenCalledTimes(kind === 'event' ? 1 : 2);
            expect(subscription.state.value).toBe('error');
            expect(subscription.error.value?.cause).toMatchObject({
                cause: { message: 'consumer failure' },
            });
        },
    );
    it('times out an idle body and cancels the reader before bounded retry', async () => {
        const cancel = vi.fn();
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => hanging(cancel));
        const subscription = subscribeRunEvents(setup(fetcher), runId, {
            ...policy,
            idleTimeoutMs: 10,
            maxReconnects: 1,
        });
        await subscription.done;
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledTimes(2);
        expect(subscription.state.value).toBe('error');
        expect(subscription.error.value?.kind).toBe('timeout');
    });
    it('times out headers even if an injected transport ignores AbortSignal', async () => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
        const subscription = subscribeRunEvents(setup(fetcher), runId, {
            ...policy,
            headerTimeoutMs: 10,
            maxReconnects: 0,
        });
        await subscription.done;
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(subscription.state.value).toBe('error');
    });
    it('stops active reads on explicit cancellation without reporting a Run error', async () => {
        const cancel = vi.fn();
        const subscription = subscribeRunEvents(
            setup(async () => hanging(cancel)),
            runId,
            policy,
        );
        await vi.waitFor(() => expect(subscription.state.value).toBe('open'));
        subscription.stop();
        await subscription.done;
        expect(subscription.state.value).toBe('closed');
        expect(subscription.error.value).toBeUndefined();
        expect(cancel).toHaveBeenCalledTimes(1);
    });
    it('does not wait forever for an uncooperative reader cancel promise', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const subscription = subscribeRunEvents(
            setup(async () => hanging(cancel)),
            runId,
            policy,
        );
        await vi.waitFor(() => expect(subscription.state.value).toBe('open'));
        const settled = vi.fn();
        void subscription.done.then(settled);
        subscription.stop();
        await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(subscription.error.value).toBeUndefined();
    });
    it('cancels a late successful response body after stop, even when fetch ignores abort', async () => {
        let resolve!: (response: Response) => void;
        const cancel = vi.fn();
        const fetcher = vi.fn<typeof fetch>(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const subscription = subscribeRunEvents(setup(fetcher), runId, policy);
        subscription.stop();
        await subscription.done;
        resolve(hanging(cancel));
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('cancels retry backoff without dispatching another request', async () => {
        const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
        const subscription = subscribeRunEvents(setup(fetcher), runId, {
            ...policy,
            backoffMs: 1000,
        });
        await vi.waitFor(() => expect(subscription.state.value).toBe('reconnecting'));
        subscription.stop();
        await subscription.done;
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(subscription.state.value).toBe('closed');
    });
    it('does not commit cursor/cache invalidation after an async callback changes the epoch', async () => {
        let finish!: () => void;
        const lifecycle = setup(async () => stream(frame(event(1))));
        const callback = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const subscription = subscribeRunEvents(lifecycle, runId, { ...policy, onEvent: callback });
        await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: runId } });
        const key = lifecycle.capture().queryKey(['tasks']);
        lifecycle.queryClient.setQueryData(key, ['new-account']);
        await subscription.done;
        finish();
        await nextTick();
        expect(lifecycle.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
        expect(subscription.state.value).toBe('closed');
    });
    it('ignores old epoch messages and never invalidates the next account cache', async () => {
        let complete!: (response: Response) => void;
        const fetcher = vi.fn<typeof fetch>().mockImplementation(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const lifecycle = setup(fetcher);
        const callback = vi.fn();
        const subscription = subscribeRunEvents(lifecycle, runId, { ...policy, onEvent: callback });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: runId } });
        const key = lifecycle.capture().queryKey(['tasks']);
        lifecycle.queryClient.setQueryData(key, ['new-account']);
        complete(stream(frame(event(1))));
        await subscription.done;
        expect(callback).not.toHaveBeenCalled();
        expect(lifecycle.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
        expect(lifecycle.session.user?.id).toBe(runId);
    });
    it('does not let a late native 401 clear the next account', async () => {
        let resolve!: (response: Response) => void;
        const lifecycle = setup(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const subscription = subscribeRunEvents(lifecycle, runId, policy);
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: runId } });
        resolve(
            Response.json(
                { code: 'DENIED', message: 'old account', requestId: 'old' },
                { status: 401 },
            ),
        );
        await subscription.done;
        expect(lifecycle.session.user?.id).toBe(runId);
        expect(subscription.state.value).toBe('closed');
        expect(subscription.error.value).toBeUndefined();
    });
    it('does not complete or populate the next account after a snapshot callback replaces the session', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(stream(''))
            .mockResolvedValueOnce(Response.json(finished));
        const lifecycle = setup(fetcher);
        const subscription = subscribeRunEvents(lifecycle, runId, {
            ...policy,
            onSnapshot: () => {
                lifecycle.replaceSession({ ...account, user: { ...account.user, id: runId } });
            },
        });
        await subscription.done;
        expect(subscription.state.value).toBe('closed');
        expect(lifecycle.queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
    it('rejects a different Run snapshot after terminal EOF', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(stream(''))
            .mockResolvedValue(Response.json({ ...finished, id: otherId }));
        const lifecycle = setup(fetcher);
        const subscription = subscribeRunEvents(lifecycle, runId, policy);
        await subscription.done;
        expect(subscription.state.value).toBe('error');
        expect(
            lifecycle.queryClient.getQueryData(runQueryOptions(lifecycle, runId).queryKey),
        ).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('bounds reset loops and validates identifiers before any network', async () => {
        const reset: SseMessage = {
            schemaVersion: 1,
            type: 'stream.reset',
            runId,
            payload: { reason: 'cursor_expired', snapshot: run, resumeAfter: 7 },
        };
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => stream(frame(reset)));
        const lifecycle = setup(fetcher);
        expect(() => subscribeRunEvents(lifecycle, '../bad')).toThrow();
        expect(fetcher).not.toHaveBeenCalled();
        const subscription = subscribeRunEvents(lifecycle, runId, { ...policy, maxReconnects: 1 });
        await subscription.done;
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(subscription.state.value).toBe('error');
    });
});

describe('useRunEvents scope lifecycle', () => {
    it('replaces subscriptions on target/epoch change and releases the stream on scope disposal', async () => {
        const cancels: ReturnType<typeof vi.fn>[] = [];
        const fetcher = vi.fn<typeof fetch>(async () => {
            const cancel = vi.fn();
            cancels.push(cancel);
            return hanging(cancel);
        });
        const lifecycle = setup(fetcher);
        const app = createApp({});
        app.provide(sessionLifecycleKey, lifecycle);
        const scope = effectScope();
        const id = ref<string | undefined>(runId);
        const subscription = app.runWithContext(() => scope.run(() => useRunEvents(id, policy)))!;
        const first = subscription.value!;
        await vi.waitFor(() => expect(first.state.value).toBe('open'));
        id.value = otherId;
        await nextTick();
        await first.done;
        const second = subscription.value!;
        await vi.waitFor(() => expect(second.state.value).toBe('open'));
        expect(first.state.value).toBe('closed');
        expect(cancels[0]).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[1]![0]).toContain(`/runs/${otherId}/events`);
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: runId } });
        await nextTick();
        await second.done;
        const third = subscription.value!;
        await vi.waitFor(() => expect(third.state.value).toBe('open'));
        expect(cancels[1]).toHaveBeenCalledTimes(1);
        scope.stop();
        await third.done;
        expect(cancels[2]).toHaveBeenCalledTimes(1);
        expect(third.state.value).toBe('closed');
        id.value = runId;
        await nextTick();
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it('opens no stream for an empty target or anonymous session', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => hanging());
        const lifecycle = setup(fetcher);
        const app = createApp({});
        app.provide(sessionLifecycleKey, lifecycle);
        const scope = effectScope();
        const id = ref<string | undefined>();
        const subscription = app.runWithContext(() => scope.run(() => useRunEvents(id, policy)))!;
        expect(subscription.value).toBeUndefined();
        lifecycle.replaceSession(null);
        id.value = runId;
        await nextTick();
        expect(subscription.value).toBeUndefined();
        expect(fetcher).not.toHaveBeenCalled();
        scope.stop();
    });
});
