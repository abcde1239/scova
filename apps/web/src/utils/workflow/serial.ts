import {
    readWorkflowStages,
    isWorkflowCanvasGraph,
    type LegacyWorkflowGraph,
    type WorkflowCanvasGraph,
    type WorkflowGraph,
    type WorkflowNode,
    type WorkflowRun,
} from '@scova/models';

export type StudyNode = Extract<WorkflowNode, { type: 'study' }>;
export type BoundaryNode = Exclude<WorkflowNode, StudyNode>;

export function serialGraph(
    start: BoundaryNode,
    studies: readonly StudyNode[],
    end: BoundaryNode,
): LegacyWorkflowGraph {
    return stagedGraph(
        start,
        studies.map((node) => [node]),
        end,
    );
}

export function stagedGraph(
    start: BoundaryNode,
    studies: readonly StudyNode[][],
    end: BoundaryNode,
): LegacyWorkflowGraph {
    const stages = [[start], ...studies, [end]];
    return {
        nodes: stages.flat(),
        edges: stages.slice(1).flatMap((stage, index) =>
            stages[index]!.flatMap((previous) =>
                stage.map((node) => ({
                    from: { nodeId: previous.id, port: 'out' as const },
                    to: { nodeId: node.id, port: 'in' as const },
                })),
            ),
        ),
    };
}

export function readEditorGraph(graph: WorkflowGraph) {
    if (isWorkflowCanvasGraph(graph)) return null;
    const stages = readWorkflowStages(graph);
    const start = stages?.[0]?.[0];
    const end = stages?.at(-1)?.[0];
    if (!stages || start?.type !== 'start' || end?.type !== 'end') return null;
    return {
        start,
        end,
        stages: stages.slice(1, -1).map((stage) => stage.filter((node) => node.type === 'study')),
    };
}

export function workflowRunIsActive(run: WorkflowRun) {
    return run.status === 'queued' || run.status === 'running' || run.status === 'cancel_requested';
}

export function upgradeWorkflowGraph(graph: LegacyWorkflowGraph): WorkflowCanvasGraph {
    const stages = readWorkflowStages(graph) ?? graph.nodes.map((node) => [node]);
    return {
        version: 2,
        nodes: graph.nodes.map((node) => ({ ...node })),
        edges: graph.edges.map(({ from, to }) => ({ from: { ...from }, to: { ...to } })),
        layout: {
            positions: Object.fromEntries(
                stages.flatMap((stage, x) =>
                    stage.map((node, y) => [node.id, { x: 40 + x * 260, y: 60 + y * 130 }]),
                ),
            ),
            groups: [],
        },
    };
}

export const workflowStatusLabels = {
    queued: '排队中',
    running: '运行中',
    cancel_requested: '取消中',
    succeeded: '已完成',
    canceled: '已取消',
    failed: '失败',
    pending: '待运行',
    skipped: '已跳过',
};
