import {
    readWorkflowStages,
    type WorkflowBinding,
    type WorkflowGraph,
    type WorkflowNode,
    type WorkflowRunNode,
} from '@scova/models';
import { ApiError } from '@/utils/errors.ts';

function invalid(path: string, message: string): never {
    throw new ApiError(422, 'WORKFLOW_INVALID_GRAPH', message, [{ path, message }]);
}

export function workflowStages(graph: WorkflowGraph): WorkflowNode[][] {
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
    return workflowStages(graph).flatMap((stage) => {
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
    node: WorkflowNode,
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
