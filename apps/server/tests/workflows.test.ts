import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
import { ContractValidationError, parseContract } from '@scova/models';
import { WorkflowDraftInputSchema, type WorkflowGraph } from '@scova/models';
import type { WorkflowRunRow } from '@scova/db';
import { workflowCheckpointNodes, workflowStages } from '@/service/workflow-graph.ts';
import { advanceWorkflow, type WorkflowResearch } from '@/service/workflow-checkpoint.ts';
import { createApiApp } from '@/app/index.ts';
import { validateOpenApi } from '../../../scripts/generate-openapi.mjs';

const task = randomUUID();
const version = randomUUID();
const child = randomUUID();
const now = new Date('2026-11-20T01:00:00Z');
const edge = (from: string, to: string) => ({
    from: { nodeId: from, port: 'out' as const },
    to: { nodeId: to, port: 'in' as const },
});
const graph: WorkflowGraph = {
    nodes: [
        { id: 'end', type: 'end' },
        { id: 'b', type: 'study', taskId: task },
        { id: 'start', type: 'start' },
        { id: 'a', type: 'study', taskId: task },
    ],
    edges: [edge('a', 'b'), edge('b', 'end'), edge('start', 'a')],
};
const parallelGraph: WorkflowGraph = {
    nodes: [
        { id: 'start', type: 'start' },
        { id: 'a', type: 'study', taskId: '10000000-0000-4000-8000-000000000000' },
        { id: 'b', type: 'study', taskId: '00000000-0000-4000-8000-000000000000' },
        { id: 'c', type: 'study', taskId: task },
        { id: 'end', type: 'end' },
    ],
    edges: [
        edge('start', 'a'),
        edge('start', 'b'),
        edge('a', 'c'),
        edge('b', 'c'),
        edge('c', 'end'),
    ],
};
function row(source = graph): WorkflowRunRow {
    return {
        id: randomUUID(),
        workflowId: randomUUID(),
        versionId: randomUUID(),
        userId: randomUUID(),
        mode: 'demo',
        status: 'queued',
        nodesJson: workflowCheckpointNodes(
            source,
            source.nodes.flatMap((node) =>
                node.type === 'study'
                    ? [{ nodeId: node.id, taskId: node.taskId, taskVersionId: version }]
                    : [],
            ),
        ),
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        nextCheckAt: now,
        startKeyHash: 'a'.repeat(64),
        failureCode: null,
    };
}
function research() {
    return {
        launch: vi
            .fn<WorkflowResearch['launch']>()
            .mockResolvedValue({ run: { id: child, status: 'queued', failureCode: null } }),
        read: vi.fn<WorkflowResearch['read']>(),
        cancel: vi.fn<WorkflowResearch['cancel']>(),
    };
}

describe('工作流阶段图', () => {
    it('允许普通标题与未连通草稿，拒绝空白标题和不支持的端口', () => {
        const draft = { title: '研究流程', graph: { nodes: [], edges: [] } };
        expect(parseContract(WorkflowDraftInputSchema, draft)).toEqual(draft);
        expect(() => parseContract(WorkflowDraftInputSchema, { ...draft, title: ' ' })).toThrow(
            ContractValidationError,
        );
        expect(() =>
            parseContract(WorkflowDraftInputSchema, {
                ...draft,
                graph: {
                    ...graph,
                    edges: [{ ...edge('start', 'a'), from: { nodeId: 'start', port: 'result' } }],
                },
            }),
        ).toThrow(ContractValidationError);
    });
    it('按连线确定节点顺序，拒绝缺少汇合的分支、不可达子环及重复节点', () => {
        expect(
            workflowStages(graph)
                .flat()
                .map((node) => node.id),
        ).toEqual(['start', 'a', 'b', 'end']);
        for (const invalid of [
            { ...graph, edges: [edge('start', 'a'), edge('start', 'b'), edge('b', 'end')] },
            { ...graph, edges: [edge('start', 'end'), edge('a', 'b'), edge('b', 'a')] },
            { ...graph, edges: [edge('a', 'b'), edge('b', 'end'), edge('start', 'missing')] },
            { ...graph, nodes: [...graph.nodes, graph.nodes[0]!] },
            { ...graph, edges: [edge('end', 'a'), edge('a', 'b'), edge('b', 'start')] },
        ])
            expect(() => workflowStages(invalid)).toThrow(
                expect.objectContaining({ code: 'WORKFLOW_INVALID_GRAPH' }),
            );
    });
});

describe('工作流检查点推进', () => {
    it('复用已落库检查点和同一子执行，成功后才开始下一研究', async () => {
        const initial = row();
        const first = research();
        const checkpoint = await advanceWorkflow(initial, now, 10, first);
        expect(checkpoint.nodesJson.map((node) => node.status)).toEqual([
            'succeeded',
            'running',
            'pending',
            'pending',
        ]);
        expect(first.launch).toHaveBeenCalledOnce();
        expect(initial.nodesJson.every((node) => node.status === 'pending')).toBe(true);

        const resumed = research();
        resumed.read.mockResolvedValueOnce({ id: child, status: 'recovering', failureCode: null });
        const waiting = await advanceWorkflow({ ...initial, ...checkpoint }, now, 10, resumed);
        expect(waiting.nodesJson[1]).toMatchObject({
            childRunId: child,
            childStatus: 'recovering',
            attempt: 1,
        });
        expect(resumed.launch).not.toHaveBeenCalled();

        resumed.read.mockResolvedValueOnce({ id: child, status: 'succeeded', failureCode: null });
        const second = await advanceWorkflow({ ...initial, ...waiting }, now, 10, resumed);
        expect(second.nodesJson.map((node) => node.status)).toEqual([
            'succeeded',
            'succeeded',
            'running',
            'pending',
        ]);
        expect(resumed.launch).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'b', taskVersionId: version }),
        );
    });

    it.each(['partial', 'failed', 'canceled', null] as const)(
        '子执行 %s 后没有后续研究',
        async (status) => {
            const initial = row();
            const runner = research();
            const first = await advanceWorkflow(initial, now, 10, runner);
            runner.read.mockResolvedValueOnce(
                status ? { id: child, status, failureCode: null } : null,
            );
            const result = await advanceWorkflow({ ...initial, ...first }, now, 10, runner);
            expect(result.status).toBe('failed');
            expect(result.failureCode).toBe(
                status ? `CHILD_RUN_${status.toUpperCase()}` : 'CHILD_RUN_UNAVAILABLE',
            );
            expect(result.nodesJson.slice(2).map((node) => node.status)).toEqual([
                'skipped',
                'skipped',
            ]);
            expect(runner.launch).toHaveBeenCalledOnce();
        },
    );

    it('取消等待子执行确认，并保留已经成功的节点', async () => {
        const initial = row();
        const runner = research();
        const first = await advanceWorkflow(initial, now, 10, runner);
        runner.cancel.mockResolvedValueOnce({
            id: child,
            status: 'cancel_requested',
            failureCode: null,
        });
        const waiting = await advanceWorkflow(
            { ...initial, ...first, status: 'cancel_requested' },
            now,
            10,
            runner,
        );
        expect(waiting.status).toBe('cancel_requested');
        runner.cancel.mockResolvedValueOnce({ id: child, status: 'canceled', failureCode: null });
        const result = await advanceWorkflow({ ...initial, ...waiting }, now, 10, runner);
        expect(result.status).toBe('canceled');
        expect(result.nodesJson.map((node) => node.status)).toEqual([
            'succeeded',
            'canceled',
            'skipped',
            'skipped',
        ]);
        expect(runner.launch).toHaveBeenCalledOnce();
    });
});

it('工作流 HTTP 路由提供完整 OpenAPI 中文契约', async () => {
    const app = createApiApp('node');
    const response = await app.handle(new Request('http://localhost/swagger/json'));
    expect(response.status).toBe(200);
    const document = (await response.json()) as { paths: Record<string, unknown> };
    const paths = Object.fromEntries(
        Object.entries(document.paths).filter(([path]) => path.startsWith('/api/v1/workflow')),
    );
    expect(Object.keys(paths)).toHaveLength(9);
    expect(() => validateOpenApi({ ...document, paths })).not.toThrow();
});

describe('并行组', () => {
    it('接受相邻并行阶段的完整汇合边，拒绝绕过汇合及同组重复任务', () => {
        const nextTask = randomUUID();
        const adjacent: WorkflowGraph = {
            nodes: [...parallelGraph.nodes, { id: 'd', type: 'study', taskId: nextTask }],
            edges: [
                edge('start', 'a'),
                edge('start', 'b'),
                edge('a', 'c'),
                edge('a', 'd'),
                edge('b', 'c'),
                edge('b', 'd'),
                edge('c', 'end'),
                edge('d', 'end'),
            ],
        };
        expect(workflowStages(adjacent).map((stage) => stage.map(({ id }) => id))).toEqual([
            ['start'],
            ['a', 'b'],
            ['c', 'd'],
            ['end'],
        ]);
        const invalid = [
            {
                ...adjacent,
                edges: adjacent.edges.filter(
                    ({ from, to }) => from.nodeId !== 'b' || to.nodeId !== 'd',
                ),
            },
            { ...parallelGraph, edges: [...parallelGraph.edges, edge('a', 'end')] },
            {
                ...parallelGraph,
                nodes: parallelGraph.nodes.map((node) =>
                    node.type === 'study' && node.id === 'a'
                        ? { ...node, taskId: '00000000-0000-4000-8000-000000000000' }
                        : node,
                ),
            },
        ];
        for (const graph of invalid)
            expect(() => workflowStages(graph)).toThrow(
                expect.objectContaining({ code: 'WORKFLOW_INVALID_GRAPH' }),
            );
    });

    function parallelRunner() {
        const runner = research();
        const childIds = new Map(['a', 'b', 'c'].map((id) => [id, randomUUID()]));
        runner.launch.mockImplementation(async ({ id }) => ({
            run: { id: childIds.get(id)!, status: 'queued', failureCode: null },
        }));
        return runner;
    }

    it('持久化两个不同的子执行，重启后等待较慢节点才推进到汇合后的研究', async () => {
        const initial = row(parallelGraph);
        const first = parallelRunner();
        const launched = await advanceWorkflow(initial, now, 10, first);
        expect(first.launch.mock.calls.map(([node]) => node.id)).toEqual(['b', 'a']);
        const [a, b] = launched.nodesJson.slice(1, 3);
        expect(a?.childRunId).not.toBe(b?.childRunId);
        expect(launched.nodesJson.map(({ status }) => status)).toEqual([
            'succeeded',
            'running',
            'running',
            'pending',
            'pending',
        ]);

        const resumed = parallelRunner();
        resumed.read.mockImplementation(async ({ id, childRunId }) => ({
            id: childRunId,
            status: id === 'a' ? 'succeeded' : 'recovering',
            failureCode: null,
        }));
        const stored = JSON.parse(
            JSON.stringify(launched.nodesJson),
        ) as WorkflowRunRow['nodesJson'];
        const waiting = await advanceWorkflow(
            { ...initial, ...launched, nodesJson: stored },
            now,
            10,
            resumed,
        );
        expect(waiting.nodesJson[2]).toMatchObject({
            id: 'b',
            childRunId: b?.childRunId,
            childStatus: 'recovering',
        });
        expect(resumed.launch).not.toHaveBeenCalled();
        resumed.read.mockImplementation(async ({ childRunId }) => ({
            id: childRunId,
            status: 'succeeded',
            failureCode: null,
        }));
        const afterJoin = await advanceWorkflow({ ...initial, ...waiting }, now, 10, resumed);
        expect(resumed.read.mock.calls.map(([node]) => node.id)).toEqual(['a', 'b', 'b']);
        expect(resumed.launch).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ id: 'c' }),
        );
        expect(afterJoin.nodesJson.map(({ status }) => status)).toEqual([
            'succeeded',
            'succeeded',
            'succeeded',
            'running',
            'pending',
        ]);
    });

    it('并行组的后一个研究启动失败时等待已启动的研究结束，重放不重试启动', async () => {
        const initial = row(parallelGraph);
        const runner = parallelRunner();
        runner.launch.mockImplementationOnce(async () => ({
            run: { id: child, status: 'queued', failureCode: null },
        }));
        runner.launch.mockResolvedValueOnce({ failureCode: 'RUN_ALREADY_ACTIVE' });
        const launched = await advanceWorkflow(initial, now, 10, runner);
        expect(launched.status).toBe('running');
        expect(launched.nodesJson.map(({ status }) => status)).toEqual([
            'succeeded',
            'failed',
            'running',
            'pending',
            'pending',
        ]);
        runner.read.mockResolvedValueOnce({ id: child, status: 'succeeded', failureCode: null });
        const failed = await advanceWorkflow({ ...initial, ...launched }, now, 10, runner);
        expect(failed).toMatchObject({ status: 'failed', failureCode: 'RUN_ALREADY_ACTIVE' });
        expect(failed.nodesJson.slice(3).map(({ status }) => status)).toEqual([
            'skipped',
            'skipped',
        ]);
        expect(runner.launch).toHaveBeenCalledTimes(2);
    });

    it('取消所有已启动的子执行，直到最后一个确认才结束父执行', async () => {
        const initial = row(parallelGraph);
        const first = parallelRunner();
        const launched = await advanceWorkflow(initial, now, 10, first);
        const resumed = parallelRunner();
        resumed.cancel.mockImplementation(async ({ id, childRunId }) => ({
            id: childRunId,
            status: id === 'a' ? 'cancel_requested' : 'canceled',
            failureCode: null,
        }));
        const waiting = await advanceWorkflow(
            { ...initial, ...launched, status: 'cancel_requested' },
            now,
            10,
            resumed,
        );
        expect(waiting.status).toBe('cancel_requested');
        expect(resumed.cancel.mock.calls.map(([node]) => node.id)).toEqual(['a', 'b']);
        resumed.cancel.mockImplementation(async ({ childRunId }) => ({
            id: childRunId,
            status: 'canceled',
            failureCode: null,
        }));
        const canceled = await advanceWorkflow({ ...initial, ...waiting }, now, 10, resumed);
        expect(canceled.nodesJson.map(({ status }) => status)).toEqual([
            'succeeded',
            'canceled',
            'canceled',
            'skipped',
            'skipped',
        ]);
        expect(canceled.status).toBe('canceled');
        expect(resumed.cancel.mock.calls.map(([node]) => node.id)).toEqual(['a', 'b', 'a']);
        expect(resumed.launch).not.toHaveBeenCalled();
    });
});
