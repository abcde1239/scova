import type {
    WorkflowCanvasGraph,
    WorkflowCanvasNode,
    WorkflowCanvasOutput,
    WorkflowRunNode,
} from '@scova/models';
import type { WorkflowRunRow } from '@scova/db';
import type { WorkflowCheckpoint } from '@/repo/workflows.ts';
import {
    childRunActive,
    type StartedStudyNode,
    type StudyNode,
    type WorkflowResearch,
} from './workflow-checkpoint.ts';

const attemptLimit = 3;
const leaseMs = 90_000;
type WorkNode = Exclude<WorkflowCanvasNode, { type: 'study' }>;
export type CanvasWork = {
    node: WorkNode;
    upstream: Record<string, WorkflowCanvasOutput>;
    attempt: number;
    leaseUntil: Date;
};
type CanvasResearch = WorkflowResearch & {
    output(runId: string): Promise<WorkflowCanvasOutput | undefined>;
};

function current(run: WorkflowRunRow, now: Date, interval = 0): WorkflowCheckpoint {
    return {
        nodesJson: run.nodesJson.map((node) => ({ ...node })),
        status: 'running',
        nextCheckAt: new Date(now.getTime() + interval),
        startedAt: run.startedAt ?? now,
        finishedAt: null,
        failureCode: null,
    };
}

function finish(
    checkpoint: WorkflowCheckpoint,
    at: Date,
    status: 'succeeded' | 'failed' | 'canceled',
    failureCode: string | null = null,
): WorkflowCheckpoint {
    for (const node of checkpoint.nodesJson) {
        if (node.status === 'pending') {
            node.status = 'skipped';
            node.finishedAt = at.toISOString();
        }
    }
    return { ...checkpoint, status, finishedAt: at, failureCode };
}

function configured(node: WorkflowRunNode): StudyNode {
    if (!node.taskId || !node.taskVersionId) throw new Error('研究节点缺少已冻结的任务版本');
    return { ...node, taskId: node.taskId, taskVersionId: node.taskVersionId };
}

function started(node: WorkflowRunNode): StartedStudyNode {
    if (!node.childRunId) throw new Error('研究节点缺少子运行');
    return { ...configured(node), childRunId: node.childRunId };
}

export async function cancelCanvasRun(
    run: WorkflowRunRow,
    now: Date,
    research: WorkflowResearch,
    interval = 0,
) {
    const checkpoint = current(run, now, interval);
    checkpoint.startedAt = run.startedAt;
    for (const node of checkpoint.nodesJson) {
        if (node.status !== 'running') continue;
        if (node.type === 'study') {
            const child = await research.cancel(started(node));
            node.childStatus = child?.status ?? null;
            if (child && childRunActive(child.status)) continue;
        }
        node.status = 'canceled';
        node.finishedAt = now.toISOString();
    }
    return checkpoint.nodesJson.some((node) => node.status === 'running')
        ? { ...checkpoint, status: 'cancel_requested' as const }
        : finish(checkpoint, now, 'canceled');
}

function ancestry(graph: WorkflowCanvasGraph, target: string) {
    const parents = new Set<string>();
    const pending = [target];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
        for (const { from, to } of graph.edges) {
            if (to.nodeId !== id || parents.has(from.nodeId)) continue;
            parents.add(from.nodeId);
            pending.push(from.nodeId);
        }
    }
    return parents;
}

export async function planCanvasStep(
    run: WorkflowRunRow,
    graph: WorkflowCanvasGraph,
    now: Date,
    interval: number,
    research: CanvasResearch,
): Promise<{ checkpoint: WorkflowCheckpoint; work?: CanvasWork }> {
    if (run.status === 'cancel_requested')
        return { checkpoint: await cancelCanvasRun(run, now, research, interval) };
    const checkpoint = current(run, now, interval);
    const nodes = checkpoint.nodesJson;
    const at = now.toISOString();
    for (const node of nodes) {
        if (node.type !== 'study' || node.status !== 'running') continue;
        const child = await research.read(started(node));
        node.childStatus = child?.status ?? null;
        if (child && childRunActive(child.status)) continue;
        node.finishedAt = at;
        if (child?.status === 'succeeded') {
            node.status = 'succeeded';
            const output = await research.output(child.id);
            if (output) node.output = output;
        } else {
            node.status = 'failed';
            node.failureCode = child?.failureCode ?? 'CHILD_RUN_FAILED';
        }
    }
    const fail = (code: string) => ({ checkpoint: finish(checkpoint, now, 'failed', code) });
    const failed = nodes.find((node) => node.status === 'failed');
    if (failed)
        return nodes.some((node) => node.status === 'running' && node.type === 'study')
            ? { checkpoint }
            : fail(failed.failureCode ?? 'CANVAS_NODE_FAILED');

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const definitions = new Map(graph.nodes.map((node) => [node.id, node]));
    const settled = (node: WorkflowRunNode) =>
        node.status === 'succeeded' || node.status === 'skipped';
    if (nodes.every(settled)) return { checkpoint: finish(checkpoint, now, 'succeeded') };
    const available = nodes.filter(
        (node) =>
            node.status === 'pending' &&
            graph.edges.every(
                ({ from, to }) => to.nodeId !== node.id || settled(byId.get(from.nodeId)!),
            ),
    );
    const runningWork = nodes.find((node) => node.status === 'running' && node.type !== 'study');
    const readyStudies = available
        .filter((node) => node.type === 'study')
        .sort((a, b) => (a.taskId ?? '').localeCompare(b.taskId ?? ''));
    if (!runningWork) {
        for (const node of readyStudies) {
            node.startedAt = at;
            if (run.preview) {
                node.status = 'skipped';
                node.finishedAt = at;
                continue;
            }
            node.attempt = 1;
            const result = await research.launch(configured(node));
            if ('failureCode' in result) {
                node.status = 'failed';
                node.finishedAt = at;
                node.failureCode = result.failureCode;
                return nodes.some((entry) => entry.status === 'running')
                    ? { checkpoint }
                    : fail(result.failureCode);
            }
            node.status = 'running';
            node.childRunId = result.run.id;
            node.childStatus = result.run.status;
        }
    }
    const next = runningWork ?? available.find((node) => node.type !== 'study');
    if (!next) return { checkpoint };
    if (next.type === 'notify' && run.inputJson?.notify === false) {
        next.status = 'skipped';
        next.finishedAt = at;
        return { checkpoint: { ...checkpoint, nextCheckAt: now } };
    }
    if (next.attempt >= attemptLimit) {
        next.status = 'failed';
        next.finishedAt = at;
        next.failureCode =
            next.type === 'notify'
                ? 'WORKFLOW_NOTIFICATION_DELIVERY_FAILED'
                : 'WORKFLOW_NODE_ATTEMPTS_EXHAUSTED';
        return nodes.some((entry) => entry.status === 'running')
            ? { checkpoint }
            : fail(next.failureCode);
    }
    const node = definitions.get(next.id);
    if (!node || node.type === 'study') throw new Error('工作流检查点与运行快照不一致');
    next.attempt += 1;
    next.status = 'running';
    next.startedAt ??= at;
    const parents = ancestry(graph, node.id);
    const upstream = Object.fromEntries(
        nodes.flatMap((state) =>
            state.output && parents.has(state.id) ? [[state.id, state.output]] : [],
        ),
    );
    const leaseUntil = new Date(now.getTime() + leaseMs);
    return {
        checkpoint: { ...checkpoint, nextCheckAt: leaseUntil },
        work: { node, upstream, attempt: next.attempt, leaseUntil },
    };
}

export function commitCanvasStep(
    run: WorkflowRunRow,
    work: CanvasWork,
    now: Date,
    result: { output: WorkflowCanvasOutput } | { failureCode: string },
): WorkflowCheckpoint | undefined {
    if (run.status !== 'running' || run.nextCheckAt.getTime() !== work.leaseUntil.getTime()) return;
    const checkpoint = current(run, now);
    const node = checkpoint.nodesJson.find((entry) => entry.id === work.node.id);
    if (!node || node.status !== 'running' || node.attempt !== work.attempt) return;
    node.finishedAt = now.toISOString();
    if ('output' in result) {
        node.status = 'succeeded';
        node.output = result.output;
    } else {
        node.status = 'failed';
        node.failureCode = result.failureCode;
    }
    return checkpoint;
}
