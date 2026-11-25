import { computed, shallowRef, ref, watch, type Ref } from 'vue';
import {
    workflowNodeLimit,
    type WorkflowCanvasGraph,
    type WorkflowCanvasNode,
} from '@scova/models';
import {
    autoCanvasPositions,
    clampPosition,
    connectionError,
    createCanvasId,
    createCanvasNode,
    edgeKey,
    nodeLimitReason,
    readCanvasPosition,
    type CanvasEdge,
    type CanvasNodeType,
    type CanvasPoint,
} from '@/utils/workflow/canvas';

export function useWorkflowCanvas(model: Ref<WorkflowCanvasGraph>, readonly: () => boolean) {
    const graph = shallowRef(model.value);
    const past = shallowRef<WorkflowCanvasGraph[]>([]);
    const future = shallowRef<WorkflowCanvasGraph[]>([]);
    const selectedIds = shallowRef(new Set<string>());
    const activeId = ref('');
    const activeGroup = ref('');
    const activeEdge = ref('');
    const outputId = ref('');
    const message = ref('');
    const selectedNode = computed(() =>
        graph.value.nodes.find((node) => node.id === activeId.value),
    );
    const selectedGroup = computed(() =>
        graph.value.layout.groups.find((group) => group.id === activeGroup.value),
    );
    const selectedEdge = computed(() =>
        graph.value.edges.find((edge) => edgeKey(edge) === activeEdge.value),
    );
    const positions = computed(() => ({
        ...autoCanvasPositions(graph.value),
        ...graph.value.layout.positions,
    }));

    function reconcile() {
        const ids = new Set(graph.value.nodes.map((node) => node.id));
        selectedIds.value = new Set([...selectedIds.value].filter((id) => ids.has(id)));
        if (!ids.has(activeId.value)) activeId.value = [...selectedIds.value].at(-1) ?? '';
        if (!ids.has(outputId.value)) outputId.value = '';
        if (!selectedGroup.value) activeGroup.value = '';
        if (!selectedEdge.value) activeEdge.value = '';
    }

    watch(model, (next) => {
        // A parent may proxy or clone v-model updates. Only a replacement draft resets history.
        if (JSON.stringify(next) === JSON.stringify(graph.value)) return;
        graph.value = next;
        past.value = [];
        future.value = [];
        outputId.value = '';
        message.value = '';
        reconcile();
    });
    watch(readonly, (locked) => {
        if (locked) outputId.value = '';
    });

    function publish(next: WorkflowCanvasGraph) {
        graph.value = next;
        model.value = next;
        reconcile();
    }

    function edit(next: WorkflowCanvasGraph) {
        if (readonly() || JSON.stringify(next) === JSON.stringify(graph.value)) return false;
        past.value = [...past.value.slice(-79), graph.value];
        future.value = [];
        message.value = '';
        // Preserve existing card placement when an incoming draft omits optional positions.
        const stablePositions = Object.fromEntries(
            next.nodes.flatMap(({ id }) => {
                const point =
                    readCanvasPosition(next.layout.positions, id) ??
                    readCanvasPosition(positions.value, id);
                return point ? [[id, point]] : [];
            }),
        );
        publish({ ...next, layout: { ...next.layout, positions: stablePositions } });
        return true;
    }

    function undo() {
        const previous = past.value.at(-1);
        if (readonly() || !previous) return;
        past.value = past.value.slice(0, -1);
        future.value = [...future.value, graph.value];
        outputId.value = '';
        publish(previous);
        message.value = '已撤销。';
    }

    function redo() {
        const next = future.value.at(-1);
        if (readonly() || !next) return;
        future.value = future.value.slice(0, -1);
        past.value = [...past.value, graph.value];
        outputId.value = '';
        publish(next);
        message.value = '已重做。';
    }

    function selectNodes(ids: Iterable<string>, lastId?: string) {
        selectedIds.value = new Set(ids);
        activeId.value = lastId ?? [...selectedIds.value].at(-1) ?? '';
        activeGroup.value = '';
        activeEdge.value = '';
    }

    function selectNode(id: string, toggle = false) {
        if (!toggle) return selectNodes([id], id);
        const next = new Set(selectedIds.value);
        if (next.delete(id)) return selectNodes(next);
        selectNodes(next.add(id), id);
    }

    function selectGroup(id: string) {
        const group = graph.value.layout.groups.find((entry) => entry.id === id);
        if (!group) return;
        selectNodes(group.nodeIds, '');
        activeGroup.value = id;
    }

    function selectEdge(edge: CanvasEdge) {
        selectNodes([edge.to.nodeId]);
        activeEdge.value = edgeKey(edge);
    }

    function addNode(type: CanvasNodeType, position: CanvasPoint) {
        if (readonly()) return;
        const current = graph.value;
        const reason = nodeLimitReason(current, type);
        if (reason) {
            message.value = reason;
            return;
        }
        const node = createCanvasNode(type);
        if (
            edit({
                ...current,
                nodes: [...current.nodes, node],
                layout: {
                    ...current.layout,
                    positions: { ...current.layout.positions, [node.id]: clampPosition(position) },
                },
            })
        )
            selectNode(node.id);
        return node.id;
    }

    function insertNode(edge: CanvasEdge, type: CanvasNodeType, position: CanvasPoint) {
        const current = graph.value;
        if (type === 'start' || type === 'end' || nodeLimitReason(current, type)) return;
        if (!current.edges.some((entry) => edgeKey(entry) === edgeKey(edge))) return;
        const node = createCanvasNode(type);
        if (
            !edit({
                ...current,
                nodes: [...current.nodes, node],
                edges: current.edges.flatMap((entry) =>
                    edgeKey(entry) === edgeKey(edge)
                        ? [
                              { from: edge.from, to: { nodeId: node.id, port: 'in' } },
                              { from: { nodeId: node.id, port: 'out' }, to: edge.to },
                          ]
                        : [entry],
                ),
                layout: {
                    ...current.layout,
                    positions: { ...current.layout.positions, [node.id]: clampPosition(position) },
                },
            })
        )
            return;
        selectNode(node.id);
        return node.id;
    }

    function updateNode(node: WorkflowCanvasNode) {
        const current = graph.value;
        edit({
            ...current,
            nodes: current.nodes.map((entry) => (entry.id === node.id ? node : entry)),
        });
    }

    function removeNode(id: string) {
        const current = graph.value;
        const positions = { ...current.layout.positions };
        delete positions[id];
        edit({
            ...current,
            nodes: current.nodes.filter((node) => node.id !== id),
            edges: current.edges.filter((edge) => edge.from.nodeId !== id && edge.to.nodeId !== id),
            layout: {
                positions,
                groups: current.layout.groups
                    .map((group) => ({
                        ...group,
                        nodeIds: group.nodeIds.filter((nodeId) => nodeId !== id),
                    }))
                    .filter((group) => group.nodeIds.length),
            },
        });
    }

    function moveNodes(moved: Record<string, CanvasPoint>) {
        const current = graph.value;
        const changes = current.nodes.flatMap(({ id }) => {
            const point = readCanvasPosition(moved, id);
            if (!point) return [];
            const next = clampPosition(point);
            const previous = readCanvasPosition(positions.value, id);
            return previous?.x === next.x && previous.y === next.y ? [] : [[id, next] as const];
        });
        if (!changes.length) return false;
        return edit({
            ...current,
            layout: {
                ...current.layout,
                positions: { ...current.layout.positions, ...Object.fromEntries(changes) },
            },
        });
    }

    function arrange() {
        const current = graph.value;
        edit({
            ...current,
            layout: { ...current.layout, positions: autoCanvasPositions(current) },
        });
    }

    function addGroup() {
        const current = graph.value;
        if (selectedIds.value.size < 2) return;
        const existing = current.layout.groups.find(
            (group) =>
                group.nodeIds.length === selectedIds.value.size &&
                group.nodeIds.every((id) => selectedIds.value.has(id)),
        );
        if (existing) {
            selectGroup(existing.id);
            return existing.id;
        }
        const groups = current.layout.groups
            .map((group) => ({
                ...group,
                nodeIds: group.nodeIds.filter((id) => !selectedIds.value.has(id)),
            }))
            .filter((group) => group.nodeIds.length);
        if (groups.length >= workflowNodeLimit) {
            message.value = '已达到分组数量上限。';
            return;
        }
        const id = createCanvasId('group');
        const titles = new Set(groups.map((group) => group.title));
        let number = 1;
        while (titles.has(`分组 ${number}`)) number++;
        const group = { id, title: `分组 ${number}`, nodeIds: [...selectedIds.value] };
        if (edit({ ...current, layout: { ...current.layout, groups: [...groups, group] } })) {
            selectGroup(id);
            return id;
        }
    }

    function renameGroup(id: string, title: string) {
        const current = graph.value;
        if (!title.trim()) return;
        const groups = current.layout.groups.map((group) =>
            group.id === id ? { ...group, title: title.trim() } : group,
        );
        edit({ ...current, layout: { ...current.layout, groups } });
    }

    function removeGroup(id: string) {
        const current = graph.value;
        const groups = current.layout.groups.filter((group) => group.id !== id);
        if (edit({ ...current, layout: { ...current.layout, groups } })) selectNodes([]);
    }

    function connect(from: string, to: string) {
        if (readonly()) return false;
        const current = graph.value;
        const reason = connectionError(current, from, to);
        if (reason) {
            message.value = reason;
            return false;
        }
        const edge: CanvasEdge = {
            from: { nodeId: from, port: 'out' },
            to: { nodeId: to, port: 'in' },
        };
        if (!edit({ ...current, edges: [...current.edges, edge] })) return false;
        outputId.value = '';
        selectEdge(edge);
        return true;
    }

    function disconnect(edge: CanvasEdge) {
        const current = graph.value;
        edit({
            ...current,
            edges: current.edges.filter((entry) => edgeKey(entry) !== edgeKey(edge)),
        });
    }

    return {
        graph,
        past,
        future,
        selectedIds,
        selectedNode,
        selectedGroup,
        selectedEdge,
        outputId,
        message,
        positions,
        selectNodes,
        selectNode,
        selectGroup,
        selectEdge,
        addNode,
        insertNode,
        updateNode,
        removeNode,
        moveNodes,
        arrange,
        addGroup,
        renameGroup,
        removeGroup,
        connect,
        disconnect,
        undo,
        redo,
    };
}
