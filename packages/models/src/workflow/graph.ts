import type { LegacyWorkflowGraph, WorkflowCanvasNode, WorkflowNode } from './schema.ts';

/** Each stage points to every node in the next stage. A stage has no internal dependencies. */
export function readWorkflowStages(graph: LegacyWorkflowGraph): WorkflowNode[][] | null {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    if (nodes.size !== graph.nodes.length) return null;
    const starts = graph.nodes.filter((node) => node.type === 'start');
    const ends = graph.nodes.filter((node) => node.type === 'end');
    if (starts.length !== 1 || ends.length !== 1) return null;

    const outgoing = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
    for (const edge of graph.edges) {
        const from = nodes.get(edge.from.nodeId);
        const to = nodes.get(edge.to.nodeId);
        if (!from || !to || from.type === 'end' || to.type === 'start') return null;
        if (edge.from.port !== 'out' || edge.to.port !== 'in') return null;
        const targets = outgoing.get(from.id)!;
        if (targets.has(to.id)) return null;
        targets.add(to.id);
    }

    const stages: WorkflowNode[][] = [];
    const seen = new Set<string>();
    let stage: WorkflowNode[] = starts;
    while (stage.length) {
        if (stage.some((node) => seen.has(node.id))) return null;
        if (stage.length > 1 && stage.some((node) => node.type !== 'study')) return null;
        stages.push(stage);
        for (const node of stage) seen.add(node.id);

        const targets = outgoing.get(stage[0]!.id)!;
        for (const node of stage.slice(1)) {
            const other = outgoing.get(node.id)!;
            if (other.size !== targets.size || [...other].some((id) => !targets.has(id)))
                return null;
        }
        stage = graph.nodes.filter((node) => targets.has(node.id));
    }
    return seen.size === nodes.size && stages.at(-1)?.[0]?.type === 'end' ? stages : null;
}

/**
 * Study nodes without an ancestor relation may run at the same time, so they must bind
 * different tasks. Returns every study node that shares its task with such a node.
 */
export function concurrentStudyConflicts(
    nodes: readonly WorkflowCanvasNode[],
    ancestorsOf: (id: string) => ReadonlySet<string>,
): Set<string> {
    const conflicts = new Set<string>();
    const studies = nodes.filter(
        (node): node is Extract<WorkflowCanvasNode, { type: 'study' }> =>
            node.type === 'study' && Boolean(node.taskId),
    );
    for (const [index, node] of studies.entries()) {
        for (const other of studies.slice(index + 1)) {
            if (node.taskId.toLowerCase() !== other.taskId.toLowerCase()) continue;
            if (ancestorsOf(node.id).has(other.id) || ancestorsOf(other.id).has(node.id)) continue;
            conflicts.add(node.id).add(other.id);
        }
    }
    return conflicts;
}
