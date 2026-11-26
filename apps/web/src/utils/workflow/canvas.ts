import {
    concurrentStudyConflicts,
    workflowNodeLimit,
    type WorkflowCanvasGraph,
    type WorkflowCanvasNode,
} from '@scova/models';

export type CanvasPoint = { x: number; y: number };
export type CanvasBox = CanvasPoint & { width: number; height: number };
export type CanvasEdge = WorkflowCanvasGraph['edges'][number];
export type CanvasNodeType = WorkflowCanvasNode['type'];
export type CanvasGroup = WorkflowCanvasGraph['layout']['groups'][number];

// World coordinates and pointer deltas use CSS pixels. Ports and paths share these card dimensions.
export const nodeWidth = 192;
export const nodeHeight = 88;
export const coordinateLimit = 100_000;

export const nodeTypes: Record<
    CanvasNodeType,
    { name: string; description: string; mark: string }
> = {
    start: { name: '开始', description: '提供本次运行的输入', mark: '▷' },
    study: { name: '研究', description: '调用已有研究任务', mark: '研' },
    csv: { name: '整理表格', description: '筛选行、选择列', mark: '表' },
    generate: { name: 'AI 生成', description: '根据上游材料生成内容', mark: '文' },
    merge: { name: '汇合', description: '等待所有上游分支成功', mark: '合' },
    deliver: { name: '交付', description: '生成可下载文件', mark: '件' },
    notify: { name: '通知', description: '发送站内通知', mark: '信' },
    end: { name: '结束', description: '标记流程完成', mark: '□' },
};

export const libraryTypes: CanvasNodeType[] = [
    'study',
    'csv',
    'generate',
    'merge',
    'deliver',
    'notify',
    'start',
    'end',
];

export function nodeLabel(node: WorkflowCanvasNode) {
    return node.label || nodeTypes[node.type].name;
}

export function createCanvasId(prefix: string) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createCanvasNode(type: CanvasNodeType): WorkflowCanvasNode {
    const id = createCanvasId(type);
    switch (type) {
        case 'study':
            return { id, type, taskId: '' };
        case 'csv':
            return { id, type, config: { filters: [] } };
        case 'generate':
            return { id, type, config: { sources: [], instructions: '' } };
        case 'deliver':
            return { id, type, config: { source: '', format: 'markdown', filename: '' } };
        case 'notify':
            return { id, type, config: { title: '', body: '' } };
        default:
            return { id, type };
    }
}

export function readCanvasPosition(positions: Readonly<Record<string, CanvasPoint>>, id: string) {
    return Object.hasOwn(positions, id) ? positions[id] : undefined;
}

export function clampPosition({ x, y }: CanvasPoint): CanvasPoint {
    return {
        x: Math.max(-coordinateLimit, Math.min(coordinateLimit, Math.round(x))),
        y: Math.max(-coordinateLimit, Math.min(coordinateLimit, Math.round(y))),
    };
}

export function edgeKey(edge: CanvasEdge) {
    return `${edge.from.nodeId}:${edge.to.nodeId}`;
}

export function canvasAncestors(edges: CanvasEdge[], id: string) {
    const pending = [id];
    const seen = new Set(pending);
    while (pending.length) {
        const target = pending.pop();
        for (const edge of edges) {
            if (edge.to.nodeId !== target || seen.has(edge.from.nodeId)) continue;
            seen.add(edge.from.nodeId);
            pending.push(edge.from.nodeId);
        }
    }
    seen.delete(id);
    return seen;
}

export function connectionError(graph: WorkflowCanvasGraph, fromId: string, toId: string) {
    const from = graph.nodes.find((node) => node.id === fromId);
    const to = graph.nodes.find((node) => node.id === toId);
    if (!from || !to) return '找不到连接端点。';
    if (from.type === 'end' || to.type === 'start') return '此端口无法接入连接。';
    if (fromId === toId) return '节点不能连接到自身。';
    if (graph.edges.some((edge) => edge.from.nodeId === fromId && edge.to.nodeId === toId)) {
        return '这两个节点已经连接。';
    }
    if (canvasAncestors(graph.edges, fromId).has(toId)) return '这条连接会形成循环。';
    return '';
}

export function nodeLimitReason(graph: WorkflowCanvasGraph, type: CanvasNodeType) {
    if (graph.nodes.length >= workflowNodeLimit) return `最多可添加 ${workflowNodeLimit} 个节点。`;
    if ((type === 'start' || type === 'end') && graph.nodes.some((node) => node.type === type)) {
        return `画布已有${nodeTypes[type].name}节点。`;
    }
    return '';
}

export function acceptsCanvasSource(node: WorkflowCanvasNode, source: WorkflowCanvasNode) {
    const csvArtifact = source.type === 'deliver' && source.config.format === 'csv';
    const markdownArtifact = source.type === 'deliver' && source.config.format === 'markdown';
    const jsonArtifact = source.type === 'deliver' && source.config.format === 'json';
    switch (node.type) {
        case 'csv':
            return source.type === 'start' || source.type === 'csv' || csvArtifact || jsonArtifact;
        case 'deliver':
            if (node.config.format === 'json')
                return (
                    source.type === 'start' ||
                    source.type === 'csv' ||
                    source.type === 'generate' ||
                    jsonArtifact
                );
            return node.config.format === 'csv'
                ? source.type === 'csv' || csvArtifact
                : source.type === 'start' ||
                      source.type === 'generate' ||
                      source.type === 'study' ||
                      markdownArtifact;
        case 'generate':
            return ['start', 'csv', 'study', 'generate', 'deliver'].includes(source.type);
        case 'notify':
            return source.type === 'deliver';
        default:
            return false;
    }
}

/** Maps every node ID to its first blocking issue, or an empty string. */
export function canvasIssues(graph: WorkflowCanvasGraph) {
    const end = graph.nodes.find(({ type }) => type === 'end');
    const reachesEnd = end ? canvasAncestors(graph.edges, end.id) : new Set<string>();
    const ancestry = new Map(graph.nodes.map(({ id }) => [id, canvasAncestors(graph.edges, id)]));
    const conflicts = concurrentStudyConflicts(graph.nodes, (id) => ancestry.get(id) ?? new Set());
    return new Map(
        graph.nodes.map((node) => [
            node.id,
            canvasNodeIssue(graph, node, reachesEnd, conflicts, ancestry.get(node.id)!),
        ]),
    );
}

function canvasNodeIssue(
    graph: WorkflowCanvasGraph,
    node: WorkflowCanvasNode,
    reachesEnd: ReadonlySet<string>,
    conflicts: ReadonlySet<string>,
    ancestors: ReadonlySet<string>,
) {
    const validSource = (id: string) =>
        ancestors.has(id) &&
        graph.nodes.some((source) => source.id === id && acceptsCanvasSource(node, source));
    if (node.type === 'study' && !node.taskId) return '请选择研究任务。';
    if (conflicts.has(node.id)) return '可能同时运行的研究节点需要绑定不同任务，或改为串行连接。';
    if (node.type === 'csv' || node.type === 'deliver' || node.type === 'notify') {
        const { source } = node.config;
        if (source && !validSource(source)) return '请选择仍有连线且类型兼容的上游来源。';
    }
    if (node.type === 'csv' && node.config.filters.some((filter) => !filter.column.trim())) {
        return '请填写筛选条件的列名。';
    }
    if (node.type === 'deliver' && (!node.config.source || !node.config.filename.trim())) {
        return '请选择来源并填写文件名。';
    }
    if (node.type === 'generate') {
        if (node.config.sources.some((source) => !validSource(source))) {
            return '部分所选来源已断开或类型不兼容。';
        }
        if (!node.config.instructions.trim()) return '请填写生成指令。';
    }
    if (node.type === 'notify' && (!node.config.title.trim() || !node.config.body.trim())) {
        return '请填写通知标题和正文。';
    }
    if (node.type === 'merge' && graph.edges.filter(({ to }) => to.nodeId === node.id).length < 2) {
        return '汇合节点需要至少两条上游连线。';
    }
    if (
        node.type !== 'start' &&
        !graph.nodes.some((start) => start.type === 'start' && ancestors.has(start.id))
    ) {
        return '此节点尚未从开始节点接入流程。';
    }
    if (node.type !== 'end' && !reachesEnd.has(node.id)) return '此节点所在分支尚未连接到结束。';
    return '';
}

export function autoCanvasPositions(graph: WorkflowCanvasGraph): Record<string, CanvasPoint> {
    const remaining = new Map(graph.nodes.map((node) => [node.id, 0]));
    const ranks = new Map(graph.nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
    for (const { from, to } of graph.edges) {
        if (!remaining.has(from.nodeId) || !remaining.has(to.nodeId)) continue;
        remaining.set(to.nodeId, (remaining.get(to.nodeId) ?? 0) + 1);
        outgoing.get(from.nodeId)?.push(to.nodeId);
    }
    const queue = graph.nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
    for (let index = 0; index < queue.length; index++) {
        const id = queue[index]!;
        for (const target of outgoing.get(id) ?? []) {
            ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(id) ?? 0) + 1));
            const count = (remaining.get(target) ?? 0) - 1;
            remaining.set(target, count);
            if (count === 0) queue.push(target);
        }
    }
    const endRank = Math.max(1, ...ranks.values());
    const columns = new Map<number, string[]>();
    for (const node of graph.nodes) {
        let rank = ranks.get(node.id) ?? 0;
        if (node.type === 'end') rank = Math.max(rank, endRank);
        const column = columns.get(rank) ?? [];
        column.push(node.id);
        columns.set(rank, column);
    }
    return Object.fromEntries(
        [...columns].flatMap(([column, ids]) =>
            ids.map((id, index) => [
                id,
                { x: column * 280, y: (index - (ids.length - 1) / 2) * 142 },
            ]),
        ),
    );
}

export function canvasBounds(points: CanvasPoint[]): CanvasBox | undefined {
    if (!points.length) return undefined;
    const x = Math.min(...points.map((point) => point.x));
    const y = Math.min(...points.map((point) => point.y));
    return {
        x,
        y,
        width: Math.max(...points.map((point) => point.x)) - x + nodeWidth,
        height: Math.max(...points.map((point) => point.y)) - y + nodeHeight,
    };
}

export function canvasEdgePath(from: CanvasPoint, to: CanvasPoint) {
    const x1 = from.x + nodeWidth;
    const y1 = from.y + nodeHeight / 2;
    const x2 = to.x - 8;
    const y2 = to.y + nodeHeight / 2;
    if (x2 >= x1 + 24 || Math.abs(y2 - y1) >= nodeHeight + 16) {
        const bend = Math.max(32, Math.abs(x2 - x1) * 0.45);
        return `M ${x1} ${y1} C ${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
    }
    const bypass = Math.min(y1, y2) - nodeHeight / 2 - 22;
    return `M ${x1} ${y1} C ${x1 + 44} ${y1} ${x1 + 44} ${bypass} ${x1 + 28} ${bypass} H ${x2 - 28} C ${x2 - 44} ${bypass} ${x2 - 44} ${y2} ${x2} ${y2}`;
}
