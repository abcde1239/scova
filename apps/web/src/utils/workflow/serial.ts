import type { WorkflowGraph, WorkflowNode, WorkflowRun } from '@scova/models';

export type StudyNode = Extract<WorkflowNode, { type: 'study' }>;
export type BoundaryNode = Exclude<WorkflowNode, StudyNode>;

export function serialGraph(
    start: BoundaryNode,
    studies: readonly StudyNode[],
    end: BoundaryNode,
): WorkflowGraph {
    const nodes = [start, ...studies, end];
    return {
        nodes,
        edges: nodes.slice(1).map((node, index) => ({
            from: { nodeId: nodes[index]!.id, port: 'out' },
            to: { nodeId: node.id, port: 'in' },
        })),
    };
}

export function readSerialGraph(graph: WorkflowGraph) {
    const start = graph.nodes.find((node) => node.type === 'start');
    const end = graph.nodes.find((node) => node.type === 'end');
    if (!start || !end || graph.edges.length !== graph.nodes.length - 1) return null;

    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const next = new Map(graph.edges.map((edge) => [edge.from.nodeId, edge.to.nodeId]));
    if (nodes.size !== graph.nodes.length || next.size !== graph.edges.length || next.has(end.id))
        return null;

    const studies: StudyNode[] = [];
    const seen = new Set([start.id]);
    for (let nextId = next.get(start.id); nextId; nextId = next.get(nextId)) {
        if (seen.has(nextId)) return null;
        const node = nodes.get(nextId);
        if (node?.id === end.id && studies.length + 2 === nodes.size)
            return { start, end, studies };
        if (node?.type !== 'study') return null;
        seen.add(nextId);
        studies.push(node);
    }
    return null;
}

export function workflowRunIsActive(run: WorkflowRun) {
    return run.status === 'queued' || run.status === 'running' || run.status === 'cancel_requested';
}
