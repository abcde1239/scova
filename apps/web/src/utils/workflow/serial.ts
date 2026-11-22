import {
    readWorkflowStages,
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
): WorkflowGraph {
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
): WorkflowGraph {
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
