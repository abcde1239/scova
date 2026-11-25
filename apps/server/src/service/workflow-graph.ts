import {
    readWorkflowStages,
    isWorkflowCanvasGraph,
    type LegacyWorkflowGraph,
    type WorkflowCanvasGraph,
    type WorkflowCanvasNode,
    type WorkflowBinding,
    type WorkflowGraph,
    type WorkflowNode,
    type WorkflowRunNode,
} from '@scova/models';
import { ApiError } from '@/utils/errors.ts';

function invalid(path: string, message: string): never {
    throw new ApiError(422, 'WORKFLOW_INVALID_GRAPH', message, [{ path, message }]);
}

export function workflowStages(graph: LegacyWorkflowGraph): WorkflowNode[][] {
    if (graph.nodes.length < 3) invalid('/graph/nodes', '需要一个开始、至少一个研究和一个结束节点');
    const stages = readWorkflowStages(graph);
    if (!stages)
        invalid(
            '/graph/edges',
            '工作流必须从开始连到结束，每个阶段的节点须连接到下一阶段的所有节点',
        );
    for (const stage of stages) {
        const taskIds = stage.flatMap((node) =>
            node.type === 'study' ? [node.taskId.toLowerCase()] : [],
        );
        if (new Set(taskIds).size !== taskIds.length)
            invalid('/graph/nodes', '同一并行组不能重复使用同一个任务');
    }
    return stages;
}

export function workflowCheckpointNodes(
    graph: WorkflowGraph,
    bindings: WorkflowBinding[],
): WorkflowRunNode[] {
    const byNode = new Map(bindings.map((binding) => [binding.nodeId, binding]));
    const stages = isWorkflowCanvasGraph(graph)
        ? workflowCanvasOrder(graph).map((node) => [node])
        : workflowStages(graph);
    return stages.flatMap((stage) => {
        const parallelGroup = stage.length > 1 ? stage[0]!.id : undefined;
        return stage.map((node) => {
            if (node.type !== 'study') return checkpointNode(node, null);
            const binding = byNode.get(node.id);
            if (!binding || binding.taskId !== node.taskId.toLowerCase())
                throw new Error('研究节点与已发布任务绑定不一致');
            return checkpointNode(node, binding.taskVersionId, parallelGroup);
        });
    });
}

function checkpointNode(
    node: WorkflowNode | WorkflowCanvasNode,
    taskVersionId: string | null,
    parallelGroup?: string,
): WorkflowRunNode {
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
        ...(parallelGroup ? { parallelGroup } : {}),
    };
}

export function workflowCanvasOrder(graph: WorkflowCanvasGraph): WorkflowCanvasNode[] {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const start = graph.nodes.filter((node) => node.type === 'start');
    const end = graph.nodes.filter((node) => node.type === 'end');
    if (nodes.size !== graph.nodes.length || start.length !== 1 || end.length !== 1)
        invalid('/graph/nodes', '需要唯一的开始和结束节点，节点标识不能重复');

    const parents = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
    const children = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
    for (const { from, to } of graph.edges) {
        const source = nodes.get(from.nodeId);
        const target = nodes.get(to.nodeId);
        if (
            !source ||
            !target ||
            source.type === 'end' ||
            target.type === 'start' ||
            children.get(source.id)?.has(target.id)
        )
            invalid('/graph/edges', '连线必须连接存在的端口且不能重复');
        children.get(source.id)!.add(target.id);
        parents.get(target.id)!.add(source.id);
    }
    const groups = new Set<string>();
    const grouped = new Set<string>();
    for (const group of graph.layout.groups) {
        if (groups.has(group.id) || group.nodeIds.some((id) => !nodes.has(id) || grouped.has(id)))
            invalid('/graph/layout/groups', '分组标识必须唯一，每个节点最多属于一个分组');
        groups.add(group.id);
        group.nodeIds.forEach((id) => grouped.add(id));
    }
    if (Object.keys(graph.layout.positions).some((id) => !nodes.has(id)))
        invalid('/graph/layout/positions', '布局引用了不存在的节点');

    const ordered: WorkflowCanvasNode[] = [];
    const ancestry = new Map<string, Set<string>>();
    const studiesByTask = new Map<string, string[]>();
    const pending = new Set(graph.nodes);
    while (pending.size) {
        const ready = [...pending].filter((node) =>
            [...parents.get(node.id)!].every((id) => ancestry.has(id)),
        );
        if (!ready.length) invalid('/graph/edges', '工作流不能包含环');
        for (const node of ready) {
            const direct = parents.get(node.id)!;
            const ancestors = new Set([...direct].flatMap((id) => [id, ...ancestry.get(id)!]));
            if (node.type !== 'start' && !ancestors.has(start[0]!.id))
                invalid('/graph/edges', `节点 ${node.label ?? node.id} 未连接到开始`);
            validateCanvasNode(node, ancestors, direct.size, nodes);
            if (node.type === 'study') {
                const key = node.taskId.toLowerCase();
                const prior = studiesByTask.get(key) ?? [];
                if (prior.some((id) => !ancestors.has(id)))
                    invalid(`/graph/nodes/${node.id}`, '可能同时运行的研究节点需要绑定不同任务');
                studiesByTask.set(key, [...prior, node.id]);
            }
            ancestry.set(node.id, ancestors);
            ordered.push(node);
            pending.delete(node);
        }
    }
    if (ancestry.get(end[0]!.id)?.size !== nodes.size - 1)
        invalid('/graph/edges', '每条分支必须连接到结束');
    return ordered;
}

function validateCanvasNode(
    node: WorkflowCanvasNode,
    ancestors: Set<string>,
    parentCount: number,
    nodes: Map<string, WorkflowCanvasNode>,
) {
    const path = `/graph/nodes/${node.id}`;
    const requireSource = (
        source: string,
        types: WorkflowCanvasNode['type'][],
        formats?: ('csv' | 'markdown' | 'json')[],
    ) => {
        const upstream = nodes.get(source);
        if (
            !upstream ||
            !ancestors.has(source) ||
            !types.includes(upstream.type) ||
            (formats && upstream.type === 'deliver' && !formats.includes(upstream.config.format))
        )
            invalid(path, `节点 ${node.label ?? node.id} 的输入必须来自兼容的上游节点`);
    };
    switch (node.type) {
        case 'study':
            if (!node.taskId) invalid(path, '研究节点需要选择任务');
            break;
        case 'merge':
            if (parentCount < 2) invalid(path, '汇合节点需要至少两条上游连线');
            break;
        case 'csv':
            if (node.config.source)
                requireSource(node.config.source, ['start', 'csv', 'deliver'], ['csv', 'json']);
            if (node.config.filters.some(({ column }) => !column.trim()))
                invalid(path, '筛选需要列名');
            break;
        case 'generate':
            if (!node.config.instructions.trim()) invalid(path, '生成节点需要填写指令');
            for (const source of node.config.sources)
                requireSource(source, ['start', 'csv', 'study', 'generate', 'deliver']);
            break;
        case 'deliver':
            if (!node.config.filename.trim()) invalid(path, '交付节点需要文件名');
            requireSource(
                node.config.source,
                node.config.format === 'csv'
                    ? ['csv', 'deliver']
                    : node.config.format === 'json'
                      ? ['start', 'csv', 'generate', 'deliver']
                      : ['start', 'generate', 'study', 'deliver'],
                [node.config.format],
            );
            break;
        case 'notify':
            if (!node.config.title.trim() || !node.config.body.trim())
                invalid(path, '通知需要填写标题和正文');
            if (node.config.source) requireSource(node.config.source, ['deliver']);
            break;
    }
}
