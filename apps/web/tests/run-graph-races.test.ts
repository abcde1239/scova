import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createApp, effectScope, nextTick, ref } from 'vue';
import type { Run, RunGraphSnapshot, RunEvent, SessionResponse, SseMessage } from '@scova/models';
import { createSessionLifecycle, sessionLifecycleKey } from '@/api/session';
import { useExecution, executionFailure } from '@/composables/useExecution';
import { useRunGraph } from '@/composables/useRunGraph';
import { runGraphQueryOptions } from '@/api/run-graph';
import { appendExecutionLog, emptyExecutionLog } from '@/utils/execution-log';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-11-18T00:00:00Z';
const account: SessionResponse = {
    user: {
        id: id(100),
        email: 'graph-race@example.test',
        createdAt: instant,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'test-only',
};
const running: Run = {
    id: id(1),
    taskId: id(10),
    taskVersionId: id(11),
    parentRunId: null,
    baselineRunId: null,
    mode: 'live',
    status: 'running',
    outcome: null,
    trigger: 'manual',
    budget: {
        maxSearches: 2,
        maxPages: 2,
        maxDurationSeconds: 60,
        maxInputTokens: 2000,
        maxOutputTokens: 1000,
    },
    usage: { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: false },
    coverage: null,
    queuedAt: instant,
    startedAt: instant,
    finishedAt: null,
    failureCode: null,
};
const failed: Run = {
    ...running,
    status: 'failed',
    finishedAt: instant,
    failureCode: 'NO_EVIDENCE',
};
const snapshot = (seq: number, runId = id(1)): RunGraphSnapshot => ({
    runId,
    graphVersion: 1,
    precision: 'instances',
    seq,
    runStatus: 'failed',
    nodes: [],
    edges: [],
    instances: [],
    legacySteps: [],
    historyComplete: true,
    truncated: false,
});
function frame(message: SseMessage) {
    return `${'eventId' in message ? `id: ${message.eventId}\n` : ''}event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const cleanups: (() => void)[] = [];
function setup(fetcher: typeof fetch) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    const scope = effectScope();
    const app = createApp({});
    app.provide(sessionLifecycleKey, lifecycle);
    cleanups.push(() => {
        scope.stop();
        lifecycle.dispose();
    });
    return { lifecycle, scope, app };
}
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe('graph snapshot stream watermarks', () => {
    it.each(['terminal', 'reset'] as const)(
        'catches up a held initial GET after the final %s without requiring another event',
        async (kind) => {
            const first = deferred<Response>();
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            let graphReads = 0;
            let eventReads = 0;
            let terminal = false;
            const fetcher = vi.fn<typeof fetch>(async (url) => {
                const path = url instanceof Request ? url.url : url.toString();
                if (path.endsWith('/graph'))
                    return ++graphReads === 1 ? first.promise : Response.json(snapshot(20));
                if (path.includes('/events')) {
                    eventReads++;
                    return eventReads === 1
                        ? new Response(
                              new ReadableStream<Uint8Array>({
                                  start(value) {
                                      controller = value;
                                  },
                              }),
                              { headers: { 'content-type': 'text/event-stream' } },
                          )
                        : new Response('', { headers: { 'content-type': 'text/event-stream' } });
                }
                return Response.json(terminal ? failed : running);
            });
            const { scope, app } = setup(fetcher);
            const execution = scope.run(() =>
                app.runWithContext(() => useExecution(id(1), { graph: true })),
            )!;
            await vi.waitFor(() => expect(graphReads).toBe(1));
            await vi.waitFor(() => expect(controller).toBeDefined());
            terminal = true;
            const message: SseMessage =
                kind === 'reset'
                    ? {
                          schemaVersion: 1,
                          type: 'stream.reset',
                          runId: id(1),
                          payload: { reason: 'cursor_expired', snapshot: failed, resumeAfter: 20 },
                      }
                    : {
                          schemaVersion: 1,
                          type: 'run.failed',
                          runId: id(1),
                          eventId: id(50),
                          seq: 20,
                          occurredAt: instant,
                          payload: { status: 'failed', code: 'NO_EVIDENCE', message: 'test' },
                      };
            controller.enqueue(new TextEncoder().encode(frame(message)));
            controller.close();
            await vi.waitFor(() => expect(execution.graph.requiredSeq.value).toBe(20));
            expect(graphReads).toBe(1);
            first.resolve(Response.json(snapshot(8)));
            await vi.waitFor(() => expect(execution.graph.snapshot.value?.seq).toBe(20));
            expect(graphReads).toBe(2);
            expect(execution.graph.stale.value).toBe(false);
        },
    );

    it('never replaces an observed higher seq with a late lower snapshot from an in-flight GET', async () => {
        const held = deferred<Response>();
        const { lifecycle } = setup(async () => held.promise);
        const options = runGraphQueryOptions(lifecycle, id(1));
        const response = lifecycle.queryClient.fetchQuery(options);
        await nextTick();
        lifecycle.queryClient.setQueryData(options.queryKey, {
            data: snapshot(30),
            status: 200,
            headers: {},
            url: '/graph',
        });
        held.resolve(Response.json(snapshot(5)));
        await response;
        expect(
            lifecycle.queryClient.getQueryData<{ data: RunGraphSnapshot }>(options.queryKey)?.data
                .seq,
        ).toBe(30);
    });

    it('bounds behind-watermark refetches, retains an honest stale state, and manual refresh can recover', async () => {
        let seq = 2;
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot(seq)));
        const { lifecycle, scope } = setup(fetcher);
        const graph = scope.run(() => useRunGraph(id(1), lifecycle))!;
        await vi.waitFor(() => expect(graph.snapshot.value?.seq).toBe(2));
        graph.requireSeq(20);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
        await nextTick();
        expect(graph.stale.value).toBe(true);
        expect(graph.snapshot.value?.seq).toBe(2);
        seq = 20;
        await graph.refresh();
        expect(graph.snapshot.value?.seq).toBe(20);
        expect(graph.stale.value).toBe(false);
    });

    it('resets the watermark on Run changes and ignores events arriving without an active target', async () => {
        const target = ref<string | undefined>(id(1));
        const { lifecycle, scope } = setup(async (url) => {
            const path = url instanceof Request ? url.url : url.toString();
            return Response.json(snapshot(2, path.includes(id(2)) ? id(2) : id(1)));
        });
        const graph = scope.run(() => useRunGraph(target, lifecycle))!;
        await vi.waitFor(() => expect(graph.snapshot.value?.runId).toBe(id(1)));
        graph.requireSeq(20);
        target.value = id(2);
        await vi.waitFor(() => expect(graph.snapshot.value?.runId).toBe(id(2)));
        expect(graph.requiredSeq.value).toBe(0);
        expect(graph.stale.value).toBe(false);
        target.value = undefined;
        graph.requireSeq(50);
        expect(graph.requiredSeq.value).toBe(0);
    });

    it('explains frozen custom source changes in both overview and whitelisted logs', () => {
        const changed = { ...failed, failureCode: 'SEARCH_CONFIGURATION_CHANGED' };
        expect(executionFailure(changed)).toContain('请按新配置创建执行');
        const event: RunEvent = {
            schemaVersion: 1,
            type: 'run.failed',
            runId: id(1),
            eventId: id(20),
            seq: 20,
            occurredAt: instant,
            payload: {
                status: 'failed',
                code: 'SEARCH_CONFIGURATION_CHANGED',
                message: 'untrusted',
            },
        };
        const log = appendExecutionLog(emptyExecutionLog(), event);
        expect(log.entries[0]?.text).toContain('请按新配置创建执行');
        expect(log.entries[0]?.text).not.toContain('untrusted');
    });
});
