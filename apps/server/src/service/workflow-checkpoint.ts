import type { RunStatus, WorkflowRunNode } from '@scova/models';
import type { WorkflowRunRow } from '@scova/db';
import type { WorkflowCheckpoint } from '@/repo/workflows.ts';

export type StudyNode = WorkflowRunNode & { taskId: string; taskVersionId: string };
export type StartedStudyNode = StudyNode & { childRunId: string };
export type StudyRun = { id: string; status: RunStatus; failureCode: string | null };
export type LaunchStudy = { run: StudyRun } | { failureCode: string };
export type WorkflowResearch = {
    launch(node: StudyNode): Promise<LaunchStudy>;
    read(node: StartedStudyNode): Promise<StudyRun | null>;
    cancel(node: StartedStudyNode): Promise<StudyRun | null>;
};

function configured(node: WorkflowRunNode): StudyNode {
    if (!node.taskId || !node.taskVersionId) throw new Error('已发布研究节点缺少任务配置快照');
    return { ...node, taskId: node.taskId, taskVersionId: node.taskVersionId };
}

export function childRunActive(status: RunStatus) {
    return (
        status === 'queued' ||
        status === 'running' ||
        status === 'recovering' ||
        status === 'cancel_requested'
    );
}

/** Caller holds the workflow Run lock; child writes and this checkpoint share a transaction. */
export async function advanceWorkflow(
    run: WorkflowRunRow,
    now: Date,
    checkIntervalMs: number,
    research: WorkflowResearch,
): Promise<WorkflowCheckpoint> {
    const at = now.toISOString();
    const nodes = run.nodesJson.map((node) => ({ ...node }));
    const checkpoint: WorkflowCheckpoint = {
        nodesJson: nodes,
        status: 'running',
        startedAt: run.startedAt ?? now,
        finishedAt: null,
        failureCode: null,
        nextCheckAt: new Date(now.getTime() + checkIntervalMs),
    };
    function finish(
        status: 'succeeded' | 'failed' | 'canceled',
        failureCode: string | null = null,
    ) {
        for (const node of nodes) {
            if (node.status === 'pending')
                Object.assign(node, { status: 'skipped', finishedAt: at });
        }
        return { ...checkpoint, status, finishedAt: now, failureCode };
    }
    function recordChild(node: WorkflowRunNode, child: StudyRun | null) {
        node.childStatus = child?.status ?? null;
        if (child && childRunActive(child.status)) return;
        node.finishedAt = at;
        switch (child?.status) {
            case 'succeeded':
                node.status = 'succeeded';
                break;
            case 'canceled':
                node.status = 'canceled';
                break;
            default:
                node.status = 'failed';
                node.failureCode =
                    child?.failureCode ??
                    (child?.status === 'partial'
                        ? 'CHILD_RUN_PARTIAL'
                        : child
                          ? 'CHILD_RUN_FAILED'
                          : 'CHILD_RUN_UNAVAILABLE');
        }
    }

    async function refreshChildren(stage: WorkflowRunNode[], cancel = false) {
        for (const node of stage) {
            if (node.status !== 'running') continue;
            if (!node.childRunId) throw new Error('运行中的研究节点缺少子执行');
            const child = { ...configured(node), childRunId: node.childRunId };
            recordChild(node, await (cancel ? research.cancel(child) : research.read(child)));
        }
        return stage.some((node) => node.status === 'running');
    }

    if (run.status === 'cancel_requested') {
        checkpoint.startedAt = run.startedAt;
        checkpoint.status = 'cancel_requested';
        return (await refreshChildren(nodes, true)) ? checkpoint : finish('canceled');
    }

    const stages = new Map<string, WorkflowRunNode[]>();
    for (const node of nodes) {
        const key = node.parallelGroup ?? node.id;
        const stage = stages.get(key);
        if (stage) stage.push(node);
        else stages.set(key, [node]);
    }
    for (const stage of stages.values()) {
        if (stage.every((node) => node.status === 'succeeded')) continue;
        if (await refreshChildren(stage)) return checkpoint;
        const failed = stage.find((node) => node.status === 'failed' || node.status === 'canceled');
        if (failed) return finish('failed', failed.failureCode ?? 'CHILD_RUN_CANCELED');

        // Launch takes a Task row lock. Every group uses the same lock ordering as publish.
        const pending = stage
            .filter((node) => node.status === 'pending')
            .sort((a, b) => (a.taskId ?? '').localeCompare(b.taskId ?? ''));
        for (const node of pending) {
            node.attempt = 1;
            node.startedAt = at;
            if (node.type !== 'study') {
                node.status = 'succeeded';
                node.finishedAt = at;
                continue;
            }
            const result = await research.launch(configured(node));
            if ('failureCode' in result) {
                node.status = 'failed';
                node.finishedAt = at;
                node.failureCode = result.failureCode;
                // Already started siblings retain their child Runs until those Runs settle.
                if (stage.some((sibling) => sibling.status === 'running')) return checkpoint;
                return finish('failed', result.failureCode);
            }
            node.status = 'running';
            node.childRunId = result.run.id;
            node.childStatus = result.run.status;
        }
        if (stage.some((node) => node.status === 'running')) return checkpoint;
    }
    return finish('succeeded');
}
