import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createApp, effectScope, nextTick, ref } from 'vue';
import {
    parseContract,
    RunSchema,
    type Run,
    type RunEvent,
    type SessionResponse,
} from '@scova/models';
import { createSessionLifecycle, sessionLifecycleKey } from '@/api/session';
import {
    executionOutcome,
    executionFailure,
    executionStates,
    updateTools,
    useExecution,
} from '@/composable/useExecution';
import { runQueryOptions } from '@/api/runs';

const runId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const reportId = '00000000-0000-4000-8000-000000000003';
const instant = '2026-10-31T00:00:00Z';
const account: SessionResponse = {
    user: {
        id: otherId,
        email: 'local@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: instant,
    },
    csrfToken: 'local-only',
};
const run: Run = {
    id: runId,
    taskId: otherId,
    taskVersionId: otherId,
    parentRunId: null,
    baselineRunId: null,
    mode: 'live',
    status: 'running',
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
    startedAt: instant,
    finishedAt: null,
    failureCode: null,
};
const partial: Run = {
    ...run,
    status: 'partial',
    outcome: 'inconclusive',
    coverage: {
        completeness: 'partial',
        searchedQueries: ['摘要'],
        gaps: ['来源未核验'],
        exhausted: ['searches'],
    },
    finishedAt: instant,
};
function event(seq: number, type: 'tool.started' | 'tool.completed' = 'tool.started'): RunEvent {
    const common = {
        schemaVersion: 1 as const,
        eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        runId,
        seq,
        occurredAt: instant,
    };
    return type === 'tool.started'
        ? {
              ...common,
              type,
              payload: {
                  toolCallId: common.eventId,
                  tool: 'search',
                  summary: 'DO_NOT_RENDER sk-secret <script>raw prompt</script>',
              },
          }
        : {
              ...common,
              type,
              payload: {
                  toolCallId: common.eventId,
                  tool: 'search',
                  durationMs: 250,
                  usage: run.usage,
              },
          };
}
const addressOf = (url: Parameters<typeof fetch>[0]) =>
    url instanceof Request ? url.url : url.toString();
const encoder = new TextEncoder();
function frame(message: RunEvent) {
    return encoder.encode(
        `id: ${message.eventId}\nevent: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`,
    );
}
const cleanups: (() => void)[] = [];
function setup(fetcher: typeof fetch, id = ref(runId)) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const app = createApp({});
    app.provide(sessionLifecycleKey, lifecycle);
    const scope = effectScope();
    const execution = app.runWithContext(() => scope.run(() => useExecution(id)))!;
    cleanups.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { execution, lifecycle, scope, id };
}
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe('Run detail facts and isolation', () => {
    it('explains known failures with an allowlist instead of exposing arbitrary failure codes', () => {
        expect(
            executionFailure({ ...run, status: 'failed', failureCode: 'DEADLINE_EXCEEDED' }),
        ).toContain('时间预算已耗尽');
        expect(
            executionFailure({ ...run, status: 'failed', failureCode: 'sk-secret raw prompt' }),
        ).not.toMatch(/secret|prompt/);
        expect(executionFailure(partial)).toBeUndefined();
    });
    it.each(Object.keys(executionStates) as Run['status'][])(
        'keeps %s distinct from a complete no-change conclusion',
        (status) => {
            const snapshot = parseContract(RunSchema, {
                ...run,
                status,
                coverage:
                    status === 'partial'
                        ? partial.coverage
                        : status === 'succeeded'
                          ? {
                                completeness: 'complete',
                                searchedQueries: [],
                                gaps: [],
                                exhausted: [],
                            }
                          : null,
                outcome:
                    status === 'succeeded'
                        ? 'no_important_change'
                        : status === 'partial'
                          ? 'inconclusive'
                          : null,
            });
            const label = executionOutcome(snapshot);
            if (status === 'succeeded') expect(label).toBe('本次范围内未发现重要变化');
            else if (status === 'partial') expect(label).toBe('已生成结果');
            else expect(label).toBeUndefined();
            if (status === 'partial') expect(label).toBe('已生成结果');
        },
    );
    it('keeps only safe tool facts, merges a completed call and bounds retained activity', () => {
        let items = updateTools([], event(1));
        expect(JSON.stringify(items)).not.toMatch(/DO_NOT_RENDER|secret|script|prompt/);
        items = updateTools(items, event(1, 'tool.completed'));
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ status: 'completed', durationMs: 250 });
        for (let seq = 2; seq <= 30; seq++) items = updateTools(items, event(seq));
        expect(items).toHaveLength(12);
        expect(items[0]!.id).toContain('000000000019');
    });
    it('uses authoritative terminal EOF snapshot, not a tool failure or event terminal status', async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let snapshot = run;
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            if (addressOf(url).includes('/events'))
                return new Response(
                    new ReadableStream({
                        start(value) {
                            controller = value;
                        },
                    }),
                    { headers: { 'content-type': 'text/event-stream' } },
                );
            if (addressOf(url).includes('/reports'))
                return Response.json({ items: [], nextCursor: null });
            return Response.json(snapshot);
        });
        const { execution, lifecycle } = setup(fetcher);
        await vi.waitFor(() => expect(execution.subscription.value?.state.value).toBe('open'));
        controller.enqueue(
            frame({
                ...event(1),
                type: 'run.failed',
                payload: { status: 'failed', code: 'SAMPLE', message: 'sample' },
            }),
        );
        await vi.waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3));
        expect(execution.run.value?.status).toBe('running');
        snapshot = partial;
        controller.close();
        await vi.waitFor(() => expect(execution.subscription.value?.state.value).toBe('complete'));
        expect(execution.run.value).toEqual(partial);
        expect(
            lifecycle.queryClient.getQueryData(runQueryOptions(lifecycle, runId).queryKey),
        ).toMatchObject({ data: partial });
        expect(execution.run.value?.coverage?.exhausted).toEqual(['searches']);
    });
    it('restores a report after refresh by task-scoped pagination and exact run matching', async () => {
        const summary = {
            id: reportId,
            runId: otherId,
            taskId: run.taskId,
            taskVersionId: run.taskVersionId,
            title: '报告',
            summary: '摘要',
            format: 'brief',
            mode: 'live',
            outcome: 'inconclusive',
            coverage: partial.coverage,
            publishedAt: instant,
        };
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const address = addressOf(url);
            if (address.includes('/events'))
                return new Response(new ReadableStream(), {
                    headers: { 'content-type': 'text/event-stream' },
                });
            if (address.includes('/reports'))
                return Response.json(
                    address.includes('cursor=next')
                        ? { items: [{ ...summary, runId }], nextCursor: null }
                        : { items: [summary], nextCursor: 'next' },
                );
            return Response.json(partial);
        });
        const { execution } = setup(fetcher);
        await vi.waitFor(() => expect(execution.reports.hasNextPage.value).toBe(true));
        expect(execution.reportId.value).toBeUndefined();
        await execution.reports.fetchNextPage();
        expect(execution.reportId.value).toBe(reportId);
        expect(
            fetcher.mock.calls
                .filter(([url]) => addressOf(url).includes('/reports'))
                .every(([url]) => addressOf(url).includes(`taskId=${otherId}`)),
        ).toBe(true);
    });
    it.each([403, 404, 500])(
        'hides a previously loaded snapshot after HTTP %i only when access is invalid',
        async (status) => {
            let failure = false;
            const { execution } = setup(async (url) => {
                if (addressOf(url).includes('/events'))
                    return new Response(new ReadableStream(), {
                        headers: { 'content-type': 'text/event-stream' },
                    });
                if (failure)
                    return Response.json(
                        { code: 'TEST_FAILURE', message: 'sample', requestId: 'sample' },
                        { status },
                    );
                return Response.json(run);
            });
            await vi.waitFor(() => expect(execution.run.value?.id).toBe(runId));
            failure = true;
            await execution.query.refetch();
            await vi.waitFor(() => expect(execution.query.isError.value).toBe(true));
            if (status === 500) expect(execution.run.value?.id).toBe(runId);
            else {
                expect(execution.run.value).toBeUndefined();
                expect(execution.reportId.value).toBeUndefined();
                await vi.waitFor(() => expect(execution.subscription.value).toBeUndefined());
            }
        },
    );
    it('waits for authoritative delivery before revealing an event report and hides it on canceled state', async () => {
        let snapshot = run;
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const { execution } = setup(async (url) => {
            if (addressOf(url).includes('/events'))
                return new Response(
                    new ReadableStream({
                        start(value) {
                            controller = value;
                        },
                    }),
                    { headers: { 'content-type': 'text/event-stream' } },
                );
            if (addressOf(url).includes('/reports'))
                return Response.json({ items: [], nextCursor: null });
            return Response.json(snapshot);
        });
        await vi.waitFor(() => expect(execution.subscription.value?.state.value).toBe('open'));
        controller.enqueue(
            frame({
                ...event(1),
                type: 'report.published',
                payload: { reportId, completeness: 'partial' },
            }),
        );
        await nextTick();
        expect(execution.run.value?.status).toBe('running');
        expect(execution.reportId.value).toBeUndefined();
        snapshot = partial;
        await execution.query.refetch();
        await vi.waitFor(() => expect(execution.reportId.value).toBe(reportId));
        snapshot = { ...run, status: 'canceled' };
        await execution.query.refetch();
        expect(execution.reportId.value).toBeUndefined();
    });
    it('stops manual report lookup when the server repeats a cursor', async () => {
        const { execution } = setup(async (url) => {
            if (addressOf(url).includes('/events'))
                return new Response(new ReadableStream(), {
                    headers: { 'content-type': 'text/event-stream' },
                });
            if (addressOf(url).includes('/reports'))
                return Response.json({ items: [], nextCursor: 'repeat' });
            return Response.json(partial);
        });
        await vi.waitFor(() => expect(execution.reports.hasNextPage.value).toBe(true));
        await execution.reports.fetchNextPage();
        expect(execution.reports.hasNextPage.value).toBe(false);
        expect(execution.reports.data.value?.pages).toHaveLength(2);
    });
    it('drops old account tool/report facts and rejects a late GET after changing the target and scope', async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let release!: (response: Response) => void;
        const cancel = vi.fn();
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            if (addressOf(url).includes('/events'))
                return new Response(
                    new ReadableStream({
                        start(value) {
                            controller = value;
                        },
                        cancel,
                    }),
                    { headers: { 'content-type': 'text/event-stream' } },
                );
            if (addressOf(url).includes(`/runs/${otherId}`))
                return new Promise((resolve) => {
                    release = resolve;
                });
            return Response.json(run);
        });
        const { execution, lifecycle, id, scope } = setup(fetcher);
        await vi.waitFor(() => expect(execution.subscription.value?.state.value).toBe('open'));
        controller.enqueue(frame(event(1)));
        await vi.waitFor(() => expect(execution.tools.value).toHaveLength(1));
        expect(execution.log.value.entries).toHaveLength(1);
        id.value = otherId;
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
        expect(execution.tools.value).toHaveLength(0);
        expect(execution.log.value.entries).toHaveLength(0);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        lifecycle.replaceSession(null);
        scope.stop();
        release(Response.json({ ...partial, id: otherId }));
        await nextTick();
        expect(lifecycle.queryClient.getQueryCache().getAll()).toHaveLength(0);
        expect(execution.reportId.value).toBeUndefined();
    });
    it('does not request an invalid route identifier', async () => {
        const fetcher = vi.fn<typeof fetch>();
        const { execution } = setup(fetcher, ref('../invalid'));
        await nextTick();
        expect(execution.id.value).toBeUndefined();
        expect(fetcher).not.toHaveBeenCalled();
    });
});
