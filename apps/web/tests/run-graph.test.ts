// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type ViteDevServer } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { QueryObserver } from '@tanstack/vue-query';
import {
    RESEARCH_GRAPH_NODES,
    RESEARCH_GRAPH_EDGES,
    type RunGraphSnapshot,
    type SessionResponse,
    type Run,
    type SseMessage,
} from '@scova/models';
import { graphNodeState } from '@/utils/run/graph';
import { runGraphQueryOptions } from '@/api/run-graph';
import { createSessionLifecycle } from '@/api/session';
import { subscribeRunEvents } from '@/api/run-events';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instant = '2026-11-18T00:00:00Z';
const account: SessionResponse = {
    user: {
        id: id(100),
        email: 'graph@example.test',
        createdAt: instant,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'test-only',
};
function fixture(): RunGraphSnapshot {
    return {
        runId: id(1),
        graphVersion: 1,
        seq: 8,
        runStatus: 'running',
        precision: 'instances',
        historyComplete: true,
        truncated: false,
        nodes: RESEARCH_GRAPH_NODES.map((node) => ({ ...node })),
        edges: RESEARCH_GRAPH_EDGES.map((edge) => ({ ...edge })),
        legacySteps: [],
        instances: [
            {
                instanceId: id(2),
                step: 'search',
                ordinal: 1,
                attempts: [
                    {
                        attemptId: id(3),
                        number: 1,
                        status: 'succeeded',
                        startedAt: instant,
                        finishedAt: instant,
                        durationMs: 500,
                    },
                ],
            },
            {
                instanceId: id(4),
                step: 'search',
                ordinal: 2,
                attempts: [
                    {
                        attemptId: id(5),
                        number: 1,
                        status: 'interrupted',
                        startedAt: instant,
                        finishedAt: instant,
                        durationMs: null,
                    },
                    {
                        attemptId: id(6),
                        number: 2,
                        status: 'running',
                        startedAt: instant,
                        finishedAt: null,
                        durationMs: null,
                    },
                ],
            },
        ],
    };
}
const lifecycles: ReturnType<typeof createSessionLifecycle>[] = [];
function lifecycle(fetcher: typeof fetch) {
    const value = createSessionLifecycle({ fetcher });
    value.replaceSession(account);
    lifecycles.push(value);
    return value;
}
afterEach(() => lifecycles.splice(0).forEach((value) => value.dispose()));
let server: ViteDevServer;
let graph: Component;
beforeAll(async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    server = await createServer({
        configFile: false,
        root,
        plugins: [vue()],
        optimizeDeps: { noDiscovery: true, include: [] },
        resolve: { alias: { '@': resolve(root, 'src') } },
        server: { middlewareMode: true, watch: null, hmr: false },
        appType: 'custom',
    });
    graph = (await server.ssrLoadModule('/src/component/run/ExecutionGraph.vue')).default;
});
afterAll(async () => server?.close());

describe('read-only execution graph', () => {
    it('keeps repeated instances and recovery attempts separate without overwriting earlier success', () => {
        const snapshot = fixture();
        const state = graphNodeState(snapshot, 'search');
        expect(state.status).toBe('running');
        expect(state.completed).toBe(1);
        expect(state.instances).toHaveLength(2);
        expect(graphNodeState(snapshot, 'read').status).toBe('unvisited');
        snapshot.precision = 'legacy';
        expect(graphNodeState(snapshot, 'read').status).toBe('legacy');
    });
    it('renders a labelled keyboard-accessible graph, status text, loops and exact attempt history', async () => {
        const html = await renderToString(
            createSSRApp({ render: () => h(graph, { snapshot: fixture() }) }),
        );
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const region = doc.querySelector('section[aria-label="研究运行图"]')!;
        const selected = region.querySelector('button[aria-pressed="true"]')!;
        expect(selected.textContent).toContain('搜索来源');
        expect(selected.textContent).toContain('2 次执行');
        expect(region.textContent).toContain('当前：搜索来源');
        expect(region.textContent).toContain('尝试 1 · 已中断');
        expect(region.textContent).toContain('尝试 2 · 运行中');
        expect(region.textContent).toContain('尚未执行');
        expect(region.querySelector('.graph-scroll[tabindex="0"]')).not.toBeNull();
        expect(region.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
        expect(region.querySelectorAll('svg > path')).toHaveLength(RESEARCH_GRAPH_EDGES.length);
        expect(region.querySelector('[role="progressbar"]')).toBeNull();
    });
    it('shows historical counts without inventing pairings or a topology for unversioned records', async () => {
        const snapshot = fixture();
        Object.assign(snapshot, {
            graphVersion: null,
            precision: 'legacy',
            historyComplete: false,
            nodes: [],
            edges: [],
            instances: [],
            legacySteps: [{ step: 'search', started: 3, completed: 2 }],
        });
        const html = await renderToString(createSSRApp({ render: () => h(graph, { snapshot }) }));
        expect(html).toContain('历史节点记录不完整');
        expect(html).toContain('开始 3 次，节点结束 2 次');
        expect(html).not.toContain('graph-board');
    });
    it('validates exact fetched Run identity and partitions graph keys by account and Run', async () => {
        const value = lifecycle(async () => Response.json(fixture()));
        const first = runGraphQueryOptions(value, id(1));
        expect(first.queryKey).toEqual(runGraphQueryOptions(value, id(1)).queryKey);
        expect(first.queryKey).not.toEqual(runGraphQueryOptions(value, id(9)).queryKey);
        await value.queryClient.fetchQuery(first);
        await expect(
            value.queryClient.fetchQuery(runGraphQueryOptions(value, id(9))),
        ).rejects.toMatchObject({ kind: 'protocol' });
        value.replaceSession({ ...account, user: { ...account.user, id: id(101) } });
        expect(runGraphQueryOptions(value, id(1)).queryKey).not.toEqual(first.queryKey);
    });
    it('refetches active graph snapshots through the existing stream after a cursor reset', async () => {
        const run: Run = {
            id: id(1),
            taskId: id(10),
            taskVersionId: id(11),
            parentRunId: null,
            baselineRunId: null,
            mode: 'live',
            status: 'failed',
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
            finishedAt: instant,
            failureCode: 'NO_EVIDENCE',
        };
        const reset: SseMessage = {
            schemaVersion: 1,
            type: 'stream.reset',
            runId: id(1),
            payload: { reason: 'cursor_expired', snapshot: run, resumeAfter: 20 },
        };
        let connections = 0;
        let graphSeq = 8;
        const fetcher = vi.fn<typeof fetch>(async (url) => {
            const path = url instanceof Request ? url.url : url.toString();
            if (path.endsWith('/graph')) return Response.json({ ...fixture(), seq: graphSeq });
            if (path.includes('/events')) {
                connections++;
                return new Response(
                    connections === 1
                        ? `event: stream.reset\ndata: ${JSON.stringify(reset)}\n\n`
                        : '',
                    { headers: { 'content-type': 'text/event-stream' } },
                );
            }
            return Response.json(run);
        });
        const value = lifecycle(fetcher);
        const options = runGraphQueryOptions(value, id(1));
        const observer = new QueryObserver(value.queryClient, options);
        const stop = observer.subscribe(() => {});
        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data?.data.seq).toBe(8));
            graphSeq = 20;
            const stream = subscribeRunEvents(value, id(1), { backoffMs: 0, maxReconnects: 1 });
            await stream.done;
            await vi.waitFor(() => expect(observer.getCurrentResult().data?.data.seq).toBe(20));
            expect(
                fetcher.mock.calls.filter(([url]) =>
                    (url instanceof Request ? url.url : url.toString()).endsWith('/graph'),
                ).length,
            ).toBeGreaterThanOrEqual(2);
        } finally {
            stop();
        }
    });
});
