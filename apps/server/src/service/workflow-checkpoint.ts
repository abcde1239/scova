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

    if (run.status === 'cancel_requested') {
        checkpoint.startedAt = run.startedAt;
        checkpoint.status = 'cancel_requested';
        const active = nodes.find((node) => node.status === 'running');
        if (active) {
            if (!active.childRunId) throw new Error('运行中的研究节点缺少子执行');
            const child = await research.cancel({
                ...configured(active),
                childRunId: active.childRunId,
            });
            recordChild(active, child);
            if (active.status === 'running') return checkpoint;
        }
        return finish('canceled');
    }

    for (const node of nodes) {
        if (node.status === 'succeeded') continue;
        if (node.status === 'running') {
            if (!node.childRunId) throw new Error('运行中的研究节点缺少子执行');
            const child = await research.read({ ...configured(node), childRunId: node.childRunId });
            recordChild(node, child);
            // The call can change the state. Child status distinguishes waiting and terminal phases.
            if (child && childRunActive(child.status)) return checkpoint;
            if (child?.status !== 'succeeded')
                return finish('failed', node.failureCode ?? 'CHILD_RUN_CANCELED');
            continue;
        }
        if (node.status !== 'pending') throw new Error('工作流检查点与运行状态不一致');
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
            return finish('failed', result.failureCode);
        }
        node.status = 'running';
        node.childRunId = result.run.id;
        node.childStatus = result.run.status;
        return checkpoint;
    }
    return finish('succeeded');
}
