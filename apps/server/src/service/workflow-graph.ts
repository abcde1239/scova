import type { WorkflowGraph, WorkflowNode, WorkflowRunNode } from '@scova/models';
import { ApiError } from '@/utils/errors.ts';

function invalid(path: string, message: string): never {
    throw new ApiError(422, 'WORKFLOW_INVALID_GRAPH', message, [{ path, message }]);
}

/** A supported graph is one path from start through at least one study to end. */
export function orderWorkflow(graph: WorkflowGraph): WorkflowNode[] {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    if (byId.size !== graph.nodes.length) invalid('/graph/nodes', '节点标识必须唯一');
    const starts = graph.nodes.filter((node) => node.type === 'start');
    const ends = graph.nodes.filter((node) => node.type === 'end');
    if (starts.length !== 1 || ends.length !== 1 || graph.nodes.length < 3)
        invalid('/graph/nodes', '需要一个开始、至少一个研究和一个结束节点');

    const next = new Map<string, WorkflowNode>();
    const incoming = new Set<string>();
    for (const [index, edge] of graph.edges.entries()) {
        const from = byId.get(edge.from.nodeId);
        const to = byId.get(edge.to.nodeId);
        const path = `/graph/edges/${index}`;
        if (!from || !to) invalid(path, '连线的两端必须引用图内节点');
        if (
            edge.from.port !== 'out' ||
            edge.to.port !== 'in' ||
            from.type === 'end' ||
            to.type === 'start'
        )
            invalid(path, '连线必须从输出端口指向输入端口，开始仅可输出，结束仅可输入');
        if (next.has(from.id) || incoming.has(to.id)) invalid(path, '首版工作流仅支持串行连线');
        next.set(from.id, to);
        incoming.add(to.id);
    }

    const ordered: WorkflowNode[] = [];
    const visited = new Set<string>();
    for (let node: WorkflowNode | undefined = starts[0]; node; node = next.get(node.id)) {
        if (visited.has(node.id)) invalid('/graph/edges', '工作流不可包含环');
        ordered.push(node);
        visited.add(node.id);
    }
    if (ordered.length !== graph.nodes.length || ordered.at(-1)?.type !== 'end')
        invalid('/graph/edges', '所有节点必须从开始可达并连接至结束');
    return ordered;
}

export function checkpointNode(node: WorkflowNode, taskVersionId: string | null): WorkflowRunNode {
    return {
        id: node.id,
        type: node.type,
        status: 'pending',
        attempt: 0,
        startedAt: null,
        finishedAt: null,
        taskId: node.type === 'study' ? node.taskId.toLowerCase() : null,
        taskVersionId,
        childRunId: null,
        childStatus: null,
        failureCode: null,
    };
}
