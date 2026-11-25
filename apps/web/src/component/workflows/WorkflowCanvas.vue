<template>
    <section ref="root" class="workflow-canvas" aria-label="工作流画布编辑器" @keydown="editorKeys">
        <header class="canvas-toolbar">
            <div class="canvas-actions" role="group" aria-label="显示方式">
                <button
                    type="button"
                    :aria-pressed="mode === 'canvas'"
                    @click="viewMode = 'canvas'"
                >
                    画布
                </button>
                <button type="button" :aria-pressed="mode === 'list'" @click="viewMode = 'list'">
                    步骤列表
                </button>
            </div>
            <div v-if="!readonly" class="canvas-actions" role="group" aria-label="编辑操作">
                <button
                    type="button"
                    :disabled="!past.length"
                    aria-keyshortcuts="Control+Z Meta+Z"
                    @click="undo"
                >
                    撤销
                </button>
                <button
                    type="button"
                    :disabled="!future.length"
                    aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
                    @click="redo"
                >
                    重做
                </button>
                <button type="button" :disabled="!graph.nodes.length" @click="autoLayout">
                    自动排列
                </button>
                <button type="button" :disabled="selectedIds.size < 2" @click="createGroup">
                    创建分组
                </button>
            </div>
            <div v-if="mode === 'canvas'" class="canvas-actions" role="group" aria-label="画布视口">
                <button type="button" aria-label="缩小画布" @click="zoom(1 / 1.25)">−</button>
                <span class="canvas-zoom"
                    >{{ Number((scale * 100).toFixed(scale < 0.01 ? 1 : 0)) }}%</span
                >
                <button type="button" aria-label="放大画布" @click="zoom(1.25)">+</button>
                <button type="button" @click="fit">适配视图</button>
                <button
                    type="button"
                    :aria-pressed="tool === 'pan'"
                    @click="tool = tool === 'pan' ? undefined : 'pan'"
                >
                    平移
                </button>
                <button
                    v-if="!readonly"
                    type="button"
                    :aria-pressed="boxMode"
                    @click="tool = boxMode ? undefined : 'box'"
                >
                    框选
                </button>
            </div>
        </header>

        <p :id="hintId" class="canvas-help">
            <template v-if="mode === 'canvas'"
                >拖动空白处平移，聚焦画布后也可用方向键。<template v-if="!readonly"
                    >拖动节点手柄或用手柄上的方向键移动，Shift 点击多选。</template
                ></template
            >
            <template v-else-if="!readonly"
                >打开节点可修改配置和连线，勾选多个节点可创建分组。</template
            >
        </p>
        <p v-if="outputId" class="canvas-feedback">
            从「{{ labelFor(outputId) }}」连接到下一个节点的输入端口。
            <button type="button" @click="cancelConnection">取消连线</button>
        </p>
        <p class="canvas-message" :class="{ 'sr-only': !message }" role="status">{{ message }}</p>

        <div class="canvas-workspace" :class="{ 'without-library': readonly }">
            <section
                v-if="!readonly"
                class="canvas-panel canvas-library"
                :aria-labelledby="`${id}-library`"
            >
                <h3 :id="`${id}-library`">节点库</h3>
                <p v-if="atNodeLimit" class="canvas-muted">已达到节点数量上限。</p>
                <div class="canvas-library-items">
                    <button
                        v-for="type in availableLibraryTypes"
                        :key="type"
                        type="button"
                        :disabled="atNodeLimit"
                        :draggable="mode === 'canvas' && !atNodeLimit"
                        @click="addFromLibrary(type)"
                        @dragstart="startLibraryDrag($event, type)"
                    >
                        <span class="canvas-type" aria-hidden="true">{{
                            nodeTypes[type].mark
                        }}</span>
                        <span
                            ><strong>{{ nodeTypes[type].name }}</strong
                            ><small>{{ nodeTypes[type].description }}</small></span
                        >
                    </button>
                </div>
            </section>

            <div class="canvas-center">
                <div
                    v-if="mode === 'canvas'"
                    ref="stage"
                    class="canvas-stage"
                    :class="{
                        'canvas-box-mode': boxMode && !readonly,
                        'canvas-pan-mode': tool === 'pan',
                        'canvas-panning': gestureMode === 'pan',
                        'canvas-node-drag': gestureMode === 'nodes',
                    }"
                    role="region"
                    tabindex="0"
                    aria-label="二维工作流画布"
                    :aria-describedby="hintId"
                    :style="{
                        backgroundSize: `${Math.max(8, 24 * scale)}px ${Math.max(8, 24 * scale)}px`,
                        backgroundPosition: `${camera.x}px ${camera.y}px`,
                    }"
                    @pointerdown.self="
                        startStage($event, !readonly && (boxMode || $event.shiftKey))
                    "
                    @pointermove="move"
                    @pointerup="finish"
                    @pointercancel="cancel($event)"
                    @lostpointercapture="cancel($event)"
                    @keydown.self="stageKeys"
                    @dragover="acceptLibraryDrag"
                    @drop="dropLibraryNode"
                >
                    <p v-if="!graph.nodes.length" class="canvas-stage-empty">
                        {{
                            readonly
                                ? '当前工作流没有节点。'
                                : '从节点库添加节点，或将节点拖到这里。'
                        }}
                    </p>
                    <div class="canvas-world" :style="worldStyle">
                        <div
                            v-for="group in visibleGroups"
                            :key="group.id"
                            class="canvas-group"
                            :class="{ 'is-active': selectedGroup?.id === group.id }"
                            :style="group.style"
                        >
                            <button
                                type="button"
                                :aria-pressed="selectedGroup?.id === group.id"
                                @focus="reveal(group.nodeIds[0] ?? '')"
                                @click="selectGroup(group.id)"
                            >
                                {{ group.title }}
                            </button>
                        </div>
                        <svg
                            class="canvas-edges"
                            aria-hidden="true"
                            focusable="false"
                            width="1"
                            height="1"
                        >
                            <defs>
                                <marker
                                    :id="`${id}-arrow`"
                                    viewBox="0 0 10 10"
                                    refX="8"
                                    refY="5"
                                    markerWidth="6"
                                    markerHeight="6"
                                    orient="auto-start-reverse"
                                >
                                    <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                                </marker>
                            </defs>
                            <g
                                v-for="edge in renderedEdges"
                                :key="edge.key"
                                :class="{
                                    'edge-active':
                                        selectedEdge && edgeKey(selectedEdge) === edge.key,
                                }"
                            >
                                <path
                                    class="canvas-edge-line"
                                    :d="edge.path"
                                    :marker-end="`url(#${id}-arrow)`"
                                />
                                <path
                                    class="canvas-edge-hit"
                                    :d="edge.path"
                                    @click="selectEdge(edge.value)"
                                />
                            </g>
                        </svg>
                        <div
                            v-for="node in graph.nodes"
                            :key="node.id"
                            class="canvas-node"
                            :class="{
                                'is-active': selectedIds.has(node.id),
                                'is-origin': outputId === node.id,
                            }"
                            :style="nodeStyle(node.id)"
                            @focusin="nodeFocus($event, node.id)"
                        >
                            <button
                                type="button"
                                class="canvas-node-main"
                                :aria-label="`${nodeLabel(node)}，${nodeTypes[node.type].name}${issues.get(node.id) ? `，${issues.get(node.id)}` : ''}`"
                                :aria-pressed="selectedIds.has(node.id)"
                                :aria-controls="inspectorId"
                                @click="nodeClick($event, node.id)"
                                @keydown.enter.exact.prevent="openNode(node.id)"
                            >
                                <span class="canvas-type" aria-hidden="true">{{
                                    nodeTypes[node.type].mark
                                }}</span>
                                <span class="canvas-node-copy">
                                    <strong :title="nodeLabel(node)">{{ nodeLabel(node) }}</strong>
                                    <small
                                        :title="issues.get(node.id) || nodeSummary(node)"
                                        :class="{ 'canvas-issue': issues.get(node.id) }"
                                        >{{ issues.get(node.id) || nodeSummary(node) }}</small
                                    >
                                </span>
                            </button>
                            <button
                                v-if="!readonly"
                                type="button"
                                class="canvas-handle"
                                :aria-label="`移动${nodeLabel(node)}，使用方向键`"
                                title="拖动或使用方向键移动"
                                @pointerdown="beginNodeDrag($event, node.id)"
                                @keydown="handleKeys($event, node.id)"
                                @click="handleClick($event, node.id)"
                            >
                                <span aria-hidden="true">✥</span>
                            </button>
                            <button
                                v-if="node.type !== 'start'"
                                type="button"
                                class="canvas-port input-port"
                                :class="{ 'port-ready': outputId && !portError(node.id) }"
                                :aria-label="`${nodeLabel(node)}的输入端口`"
                                :title="portError(node.id) || '输入端口'"
                                @click="inputPort(node.id)"
                            />
                            <button
                                v-if="node.type !== 'end'"
                                type="button"
                                class="canvas-port output-port"
                                :aria-label="`${nodeLabel(node)}的输出端口`"
                                :aria-pressed="outputId === node.id"
                                title="输出端口"
                                @click="outputPort(node.id)"
                            />
                        </div>
                    </div>
                    <div
                        v-if="selectionBox"
                        class="canvas-selection"
                        :style="{
                            left: `${selectionBox.left}px`,
                            top: `${selectionBox.top}px`,
                            width: `${selectionBox.width}px`,
                            height: `${selectionBox.height}px`,
                        }"
                    />
                </div>

                <section v-else class="canvas-panel canvas-list" :aria-labelledby="`${id}-steps`">
                    <h3 :id="`${id}-steps`">工作流步骤</h3>
                    <p v-if="!graph.nodes.length" class="canvas-muted">
                        {{ readonly ? '当前工作流没有节点。' : '从节点库添加第一步。' }}
                    </p>
                    <ul v-else class="canvas-steps">
                        <li
                            v-for="node in graph.nodes"
                            :key="node.id"
                            :class="{ 'is-active': selectedIds.has(node.id) }"
                        >
                            <label v-if="!readonly" class="canvas-select-step">
                                <input
                                    type="checkbox"
                                    :checked="selectedIds.has(node.id)"
                                    @change="selectNode(node.id, true)"
                                />
                                <span class="sr-only">选择{{ nodeLabel(node) }}</span>
                            </label>
                            <button
                                type="button"
                                class="canvas-step"
                                :aria-controls="inspectorId"
                                @click="openNode(node.id)"
                            >
                                <span class="canvas-type" aria-hidden="true">{{
                                    nodeTypes[node.type].mark
                                }}</span>
                                <span
                                    ><strong>{{ nodeLabel(node) }}</strong
                                    ><small :class="{ 'canvas-issue': issues.get(node.id) }">{{
                                        issues.get(node.id) || nodeSummary(node)
                                    }}</small></span
                                >
                                <span aria-hidden="true">›</span>
                            </button>
                        </li>
                    </ul>
                </section>

                <div
                    v-if="graph.layout.groups.length"
                    class="canvas-group-list"
                    role="group"
                    aria-label="节点分组"
                >
                    <button
                        v-for="group in graph.layout.groups"
                        :key="group.id"
                        type="button"
                        :aria-pressed="selectedGroup?.id === group.id"
                        @click="openGroup(group.id)"
                    >
                        {{ group.title }} · {{ group.nodeIds.length }}
                    </button>
                </div>
            </div>

            <section
                :id="inspectorId"
                class="canvas-panel canvas-inspector"
                :aria-labelledby="`${id}-inspector-title`"
            >
                <h3 :id="`${id}-inspector-title`" ref="inspectorHeading" tabindex="-1">
                    {{
                        selectedGroup
                            ? '分组设置'
                            : selectedNode
                              ? nodeLabel(selectedNode)
                              : '节点检查器'
                    }}
                </h3>
                <template v-if="selectedGroup">
                    <label class="canvas-field" :key="selectedGroup.id">
                        分组名称
                        <input
                            ref="groupName"
                            :value="selectedGroup.title"
                            maxlength="160"
                            :readonly="readonly"
                            @change="commitGroupName"
                        />
                    </label>
                    <p class="canvas-muted">{{ selectedGroup.nodeIds.map(labelFor).join('、') }}</p>
                    <button v-if="!readonly" type="button" @click="deleteGroup">解除分组</button>
                </template>
                <template v-else-if="selectedNode">
                    <p v-if="issues.get(selectedNode.id)" class="canvas-issue">
                        {{ issues.get(selectedNode.id) }}
                    </p>
                    <workflow-canvas-config
                        :key="selectedNode.id"
                        :node="selectedNode"
                        :nodes="graph.nodes"
                        :tasks="tasks"
                        :upstream="upstream"
                        :readonly="readonly"
                        @update="updateNode"
                    />
                    <div class="canvas-inspector-section">
                        <h4>连线</h4>
                        <p v-if="!incidentEdges.length" class="canvas-muted">暂无连线。</p>
                        <ul v-else class="canvas-connections">
                            <li
                                v-for="edge in incidentEdges"
                                :key="edgeKey(edge)"
                                :class="{
                                    'selected-edge':
                                        selectedEdge && edgeKey(edge) === edgeKey(selectedEdge),
                                }"
                            >
                                <button
                                    type="button"
                                    class="canvas-connection-label"
                                    :aria-pressed="
                                        !!selectedEdge && edgeKey(edge) === edgeKey(selectedEdge)
                                    "
                                    @click="selectEdge(edge)"
                                >
                                    {{ labelFor(edge.from.nodeId) }} →
                                    {{ labelFor(edge.to.nodeId) }}
                                </button>
                                <button
                                    v-if="!readonly"
                                    type="button"
                                    :aria-label="`移除 ${labelFor(edge.from.nodeId)} 到 ${labelFor(edge.to.nodeId)} 的连线`"
                                    @click="removeConnection(edge)"
                                >
                                    移除
                                </button>
                            </li>
                        </ul>
                        <template v-if="!readonly && selectedNode.type !== 'start'">
                            <label class="canvas-field">
                                添加上游连线
                                <select ref="sourceSelect" v-model="sourceId">
                                    <option value="">
                                        {{
                                            sourceChoices.some((choice) => !choice.reason)
                                                ? '选择上游节点'
                                                : '没有可连接的上游节点'
                                        }}
                                    </option>
                                    <option
                                        v-for="choice in sourceChoices"
                                        :key="choice.node.id"
                                        :value="choice.node.id"
                                        :disabled="!!choice.reason"
                                    >
                                        {{ nodeLabel(choice.node)
                                        }}{{ choice.reason ? `（${choice.reason}）` : '' }}
                                    </option>
                                </select>
                            </label>
                            <button
                                type="button"
                                :disabled="!sourceId"
                                @click="connectFromInspector"
                            >
                                连接
                            </button>
                        </template>
                        <template v-if="!readonly && selectedEdge">
                            <label class="canvas-field">
                                在线上插入节点
                                <select v-model="insertionType" :disabled="atNodeLimit">
                                    <option value="">选择节点类型</option>
                                    <option
                                        v-for="type in insertableTypes"
                                        :key="type"
                                        :value="type"
                                    >
                                        {{ nodeTypes[type].name }}
                                    </option>
                                </select>
                            </label>
                            <button
                                type="button"
                                :disabled="!insertionType || atNodeLimit"
                                @click="insertOnEdge"
                            >
                                插入
                            </button>
                        </template>
                    </div>
                    <button
                        v-if="!readonly"
                        type="button"
                        class="canvas-danger"
                        @click="deleteNode"
                    >
                        删除节点
                    </button>
                </template>
                <p v-else class="canvas-muted">选择一个节点查看配置和连线。</p>
                <div v-if="!readonly && selectedIds.size" class="canvas-inspector-section">
                    <h4>
                        {{ selectedIds.size > 1 ? `移动 ${selectedIds.size} 个节点` : '移动节点' }}
                    </h4>
                    <div class="canvas-actions" role="group" aria-label="移动所选节点">
                        <button
                            v-for="direction in canvasDirections"
                            :key="direction.label"
                            type="button"
                            :aria-label="`向${direction.label}移动`"
                            @click="moveSelection(direction)"
                        >
                            {{ direction.mark }}
                        </button>
                    </div>
                </div>
            </section>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue';
import {
    workflowNodeLimit,
    type WorkflowCanvasGraph,
    type WorkflowCanvasNode,
} from '@scova/models';
import WorkflowCanvasConfig from '@/component/workflows/WorkflowCanvasConfig.vue';
import { useWorkflowCanvas } from '@/composable/useWorkflowCanvas';
import {
    canvasArrow,
    canvasDirections,
    useWorkflowCanvasViewport,
} from '@/composable/useWorkflowCanvasViewport';
import {
    canvasAncestors,
    canvasBounds,
    canvasEdgePath,
    canvasNodeIssue,
    connectionError,
    edgeKey,
    libraryTypes,
    nodeHeight,
    nodeLabel,
    nodeTypes,
    nodeWidth,
    readCanvasPosition,
    type CanvasEdge,
    type CanvasNodeType,
    type CanvasPoint,
} from '@/utils/workflow/canvas';

const props = defineProps<{
    tasks: ReadonlyArray<{ id: string; title: string }>;
    readonly?: boolean;
}>();
const model = defineModel<WorkflowCanvasGraph>('graph', { required: true });
const id = useId();
const hintId = `${id}-hint`;
const inspectorId = `${id}-inspector`;
const root = useTemplateRef('root');
const stage = useTemplateRef('stage');
const inspectorHeading = useTemplateRef('inspectorHeading');
const sourceSelect = useTemplateRef('sourceSelect');
const groupName = useTemplateRef('groupName');
const compact = ref(false);
const viewMode = ref<'list' | 'canvas'>();
const mode = computed(() => viewMode.value ?? (compact.value ? 'list' : 'canvas'));
const tool = ref<'pan' | 'box'>();
const boxMode = computed(() => tool.value === 'box');
const sourceId = ref('');
const insertionType = ref<CanvasNodeType | ''>('');
const dragType = 'application/x-scova-workflow-node';
const {
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
} = useWorkflowCanvas(model, () => !!props.readonly);
const {
    camera,
    scale,
    rendered,
    selectionBox,
    gestureMode,
    pointAt,
    localPoint,
    fit,
    zoom,
    pan,
    reveal,
    nudge,
    startNodes,
    startStage,
    move,
    finish,
    cancel,
} = useWorkflowCanvasViewport(
    stage,
    positions,
    () => graph.value.nodes.map((node) => node.id),
    moveNodes,
    (ids, additive) => selectNodes(additive ? [...selectedIds.value, ...ids] : ids),
);

watch(
    root,
    (element, _, onCleanup) => {
        if (!element) return;
        const sync = () => {
            compact.value = element.clientWidth < 720;
        };
        sync();
        const observer = new ResizeObserver(sync);
        observer.observe(element);
        onCleanup(() => observer.disconnect());
    },
    { flush: 'post' },
);
watch(
    () => [selectedNode.value?.id, selectedEdge.value],
    () => {
        sourceId.value = '';
        insertionType.value = '';
    },
);
watch(graph, () => cancel());
watch(
    () => props.readonly,
    () => cancel(),
);

const worldStyle = computed(() => ({
    transform: `translate(${camera.value.x}px, ${camera.value.y}px) scale(${scale.value})`,
}));
const atNodeLimit = computed(() => graph.value.nodes.length >= workflowNodeLimit);
const insertableTypes = libraryTypes.filter((type) => type !== 'start' && type !== 'end');
const availableLibraryTypes = computed(() =>
    libraryTypes.filter(
        (type) =>
            (type !== 'start' && type !== 'end') ||
            !graph.value.nodes.some((node) => node.type === type),
    ),
);
const taskTitles = computed(() => new Map(props.tasks.map((task) => [task.id, task.title])));
const issues = computed(() => {
    const end = graph.value.nodes.find(({ type }) => type === 'end');
    const reachesEnd = end ? canvasAncestors(graph.value.edges, end.id) : new Set<string>();
    return new Map(
        graph.value.nodes.map((node) => [node.id, canvasNodeIssue(graph.value, node, reachesEnd)]),
    );
});
const renderedEdges = computed(() =>
    graph.value.edges.flatMap((edge) => {
        const from = readCanvasPosition(rendered.value, edge.from.nodeId);
        const to = readCanvasPosition(rendered.value, edge.to.nodeId);
        return from && to
            ? [{ key: edgeKey(edge), value: edge, path: canvasEdgePath(from, to) }]
            : [];
    }),
);
const visibleGroups = computed(() =>
    graph.value.layout.groups.flatMap((group) => {
        const bounds = canvasBounds(
            group.nodeIds.flatMap((nodeId) => {
                const point = readCanvasPosition(rendered.value, nodeId);
                return point ? [point] : [];
            }),
        );
        if (!bounds) return [];
        return [
            {
                ...group,
                style: {
                    left: `${bounds.x - 20}px`,
                    top: `${bounds.y - 42}px`,
                    width: `${bounds.width + 40}px`,
                    height: `${bounds.height + 62}px`,
                },
            },
        ];
    }),
);
const upstream = computed(() => {
    if (!selectedNode.value) return [];
    const ids = canvasAncestors(graph.value.edges, selectedNode.value.id);
    return graph.value.nodes.filter((node) => ids.has(node.id));
});
const incidentEdges = computed(() =>
    graph.value.edges.filter(
        (edge) =>
            edge.from.nodeId === selectedNode.value?.id ||
            edge.to.nodeId === selectedNode.value?.id,
    ),
);
const sourceChoices = computed(() => {
    const selected = selectedNode.value;
    if (!selected) return [];
    return graph.value.nodes
        .filter((node) => node.id !== selected.id && node.type !== 'end')
        .map((node) => ({
            node,
            reason: connectionError(graph.value, node.id, selected.id),
        }));
});

function labelFor(nodeId: string) {
    const node = graph.value.nodes.find((entry) => entry.id === nodeId);
    return node ? nodeLabel(node) : '已删除节点';
}

function nodeSummary(node: WorkflowCanvasNode) {
    if (node.type === 'study')
        return taskTitles.value.get(node.taskId) || nodeTypes.study.description;
    if (node.type === 'deliver' && node.config.filename) return node.config.filename;
    if (node.type === 'notify' && node.config.title) return node.config.title;
    return nodeTypes[node.type].description;
}

function nodeStyle(nodeId: string) {
    const point = readCanvasPosition(rendered.value, nodeId);
    return {
        left: `${point?.x ?? 0}px`,
        top: `${point?.y ?? 0}px`,
        width: `${nodeWidth}px`,
        height: `${nodeHeight}px`,
    };
}

function focusInspector() {
    void nextTick(() => inspectorHeading.value?.focus());
}

function nodeClick(event: MouseEvent, nodeId: string) {
    selectNode(nodeId, !props.readonly && (event.shiftKey || event.ctrlKey || event.metaKey));
}

function openNode(nodeId: string) {
    selectNode(nodeId);
    focusInspector();
}

function openGroup(groupId: string) {
    selectGroup(groupId);
    focusInspector();
}

function nodeFocus(event: FocusEvent, nodeId: string) {
    if ((event.target as HTMLElement).matches(':focus-visible')) reveal(nodeId);
}

function selectedFor(nodeId: string) {
    if (!selectedIds.value.has(nodeId)) selectNode(nodeId);
    return selectedIds.value;
}

function beginNodeDrag(event: PointerEvent, nodeId: string) {
    if (event.button !== 0 || !event.isPrimary || props.readonly) return;
    startNodes(event, selectedFor(nodeId));
}

function handleClick(event: MouseEvent, nodeId: string) {
    if (event.detail === 0) selectedFor(nodeId);
}

function moveSelection(direction: CanvasPoint & { label: string }, step?: number) {
    if (nudge(selectedIds.value, direction, step)) {
        message.value = `已向${direction.label}移动${selectedIds.value.size > 1 ? `${selectedIds.value.size} 个节点` : '节点'}。`;
    }
}

function handleKeys(event: KeyboardEvent, nodeId: string) {
    const direction = canvasArrow(event.key);
    if (!direction) return;
    event.preventDefault();
    selectedFor(nodeId);
    moveSelection(direction, event.shiftKey ? 64 : 16);
    reveal(nodeId);
}

function stageKeys(event: KeyboardEvent) {
    const direction = canvasArrow(event.key);
    if (!direction) return;
    event.preventDefault();
    pan({ x: -direction.x * 64, y: -direction.y * 64 });
}

function editorKeys(event: KeyboardEvent) {
    if (event.key === 'Escape' && (gestureMode.value || outputId.value)) {
        event.preventDefault();
        cancel();
        cancelConnection();
        return;
    }
    const target = event.target as HTMLElement;
    if (
        !props.readonly &&
        !event.isComposing &&
        event.key === 'Enter' &&
        target instanceof HTMLInputElement &&
        target.type === 'text'
    ) {
        event.preventDefault();
        target.blur();
        target.focus({ preventScroll: true });
        return;
    }
    if (
        props.readonly ||
        target.closest('input, textarea, select, [contenteditable]') ||
        event.isComposing
    )
        return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
    } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
    }
}

function autoLayout() {
    arrange();
    if (mode.value === 'canvas') fit();
}

function addFromLibrary(type: CanvasNodeType) {
    const element = stage.value;
    const center = element
        ? pointAt({ x: element.clientWidth / 2, y: element.clientHeight / 2 })
        : { x: 0, y: 0 };
    const point = { x: center.x - nodeWidth / 2, y: center.y - nodeHeight / 2 };
    const occupied = graph.value.nodes.flatMap((node) => {
        const position = readCanvasPosition(positions.value, node.id);
        return position ? [position] : [];
    });
    while (
        occupied.some(
            (other) =>
                Math.abs(other.x - point.x) < nodeWidth + 12 &&
                Math.abs(other.y - point.y) < nodeHeight + 12,
        )
    ) {
        point.y += nodeHeight + 24;
    }
    const nodeId = addNode(type, point);
    if (nodeId) {
        reveal(nodeId);
        focusInspector();
    }
}

function startLibraryDrag(event: DragEvent, type: CanvasNodeType) {
    if (props.readonly || !event.dataTransfer || atNodeLimit.value) return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(dragType, type);
}

function acceptLibraryDrag(event: DragEvent) {
    if (props.readonly || atNodeLimit.value || !event.dataTransfer?.types.includes(dragType))
        return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
}

function dropLibraryNode(event: DragEvent) {
    const type = libraryTypes.find((entry) => entry === event.dataTransfer?.getData(dragType));
    if (props.readonly || !type) return;
    event.preventDefault();
    const point = pointAt(localPoint(event));
    addNode(type, { x: point.x - nodeWidth / 2, y: point.y - nodeHeight / 2 });
}

function createGroup() {
    if (addGroup())
        void nextTick(() => {
            groupName.value?.focus();
            groupName.value?.select();
        });
}

function commitGroupName(event: Event) {
    const group = selectedGroup.value;
    if (!group) return;
    const input = event.target as HTMLInputElement;
    input.value = input.value.trim() || group.title;
    renameGroup(group.id, input.value);
}

function deleteGroup() {
    if (selectedGroup.value) removeGroup(selectedGroup.value.id);
    focusInspector();
}

function deleteNode() {
    if (selectedNode.value) removeNode(selectedNode.value.id);
    focusInspector();
}

function portError(nodeId: string) {
    return outputId.value ? connectionError(graph.value, outputId.value, nodeId) : '';
}

function cancelConnection() {
    outputId.value = '';
    message.value = '';
}

function outputPort(nodeId: string) {
    selectNode(nodeId);
    if (props.readonly || outputId.value === nodeId) cancelConnection();
    else {
        outputId.value = nodeId;
        message.value = `已选择${labelFor(nodeId)}的输出端口。`;
    }
}

function inputPort(nodeId: string) {
    if (outputId.value && !props.readonly) {
        if (connect(outputId.value, nodeId)) message.value = '已连接端口。';
        return;
    }
    selectNode(nodeId);
    void nextTick(() => (sourceSelect.value ?? inspectorHeading.value)?.focus());
}

function connectFromInspector() {
    if (selectedNode.value && connect(sourceId.value, selectedNode.value.id)) {
        sourceId.value = '';
        sourceSelect.value?.focus();
        message.value = '已添加上游连线。';
    }
}

function removeConnection(edge: CanvasEdge) {
    disconnect(edge);
    void nextTick(() => (sourceSelect.value ?? inspectorHeading.value)?.focus());
    message.value = '已移除连线。';
}

function insertOnEdge() {
    const edge = selectedEdge.value;
    if (!edge || !insertionType.value) return;
    const from = readCanvasPosition(positions.value, edge.from.nodeId);
    const to = readCanvasPosition(positions.value, edge.to.nodeId);
    if (!from || !to) return;
    const nodeId = insertNode(edge, insertionType.value, {
        x: (from.x + to.x) / 2,
        y: (from.y + to.y) / 2,
    });
    if (nodeId) {
        reveal(nodeId);
        focusInspector();
    }
}
</script>

<style scoped>
.workflow-canvas {
    container-type: inline-size;
    min-inline-size: 0;
    display: grid;
    gap: 0.625rem;
    --canvas-line: var(--scova-border);
    --canvas-tint: color-mix(in srgb, var(--scova-primary) 8%, var(--scova-surface));
}

.canvas-toolbar,
.canvas-actions,
.canvas-group-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
}

.canvas-toolbar {
    gap: 0.625rem 1.125rem;
}

.canvas-toolbar .canvas-actions {
    gap: 0.25rem;
}

button:not(.canvas-port) {
    min-block-size: 2rem;
    padding: 0.25rem 0.55rem;
    border: 1px solid var(--canvas-line);
    border-radius: 0.4rem;
    background: var(--scova-surface);
    color: inherit;
    font: inherit;
    font-size: 0.875rem;
    line-height: 1.35;
    cursor: pointer;
}

button:not(:disabled):hover {
    border-color: var(--scova-primary);
}

button[aria-pressed='true'] {
    border-color: var(--scova-primary);
    background: var(--canvas-tint);
    color: var(--scova-primary);
}

button:disabled {
    opacity: 0.57;
    cursor: default;
}

:focus-visible {
    outline: 2px solid var(--scova-primary);
    outline-offset: 2px;
}

.canvas-help,
.canvas-muted,
.canvas-feedback,
.canvas-message,
.canvas-issue {
    font-size: 0.8125rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
}

.canvas-help,
.canvas-muted,
.canvas-zoom {
    color: var(--scova-muted);
}

.canvas-help:empty {
    display: none;
}

.canvas-zoom {
    min-inline-size: 3.25em;
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
}

.canvas-feedback,
.canvas-message:not(.sr-only) {
    padding: 0.45rem 0.625rem;
    border-inline-start: 2px solid var(--scova-primary);
    background: var(--canvas-tint);
}

.canvas-feedback button {
    margin-inline-start: 0.5rem;
}

.canvas-workspace {
    display: grid;
    grid-template-columns: minmax(8rem, 10rem) minmax(0, 1fr) minmax(13rem, 16rem);
    align-items: start;
    gap: 0.75rem;
}

.canvas-workspace.without-library {
    grid-template-columns: minmax(0, 1fr) minmax(13rem, 16rem);
}

.canvas-center,
.canvas-panel {
    min-inline-size: 0;
    display: grid;
    align-content: start;
    gap: 0.625rem;
}

.canvas-panel {
    padding: 0.75rem;
    border: 1px solid var(--canvas-line);
    border-radius: 0.625rem;
    background: var(--scova-surface);
}

.canvas-panel h3,
.canvas-panel h4 {
    margin: 0;
    overflow-wrap: anywhere;
    line-height: 1.4;
}

.canvas-panel h3 {
    font-size: 0.9375rem;
}

.canvas-panel h4 {
    font-size: 0.875rem;
}

.canvas-library-items {
    display: grid;
    gap: 0.375rem;
}

.canvas-library-items button,
.canvas-step {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    text-align: start;
    gap: 0.5rem;
    min-inline-size: 0;
}

.canvas-library-items button {
    min-block-size: 3.25rem;
}

.canvas-type {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 1.65em;
    height: 1.65em;
    border-radius: 0.35em;
    background: var(--canvas-tint);
    color: var(--scova-primary);
    font-weight: 700;
    line-height: 1;
}

.canvas-library-items small,
.canvas-step small {
    display: block;
    color: var(--scova-muted);
    overflow-wrap: anywhere;
}

.canvas-stage {
    position: relative;
    isolation: isolate;
    min-inline-size: 0;
    block-size: clamp(23rem, 62vh, 38rem);
    overflow: clip;
    border: 1px solid var(--canvas-line);
    border-radius: 0.625rem;
    background-color: var(--scova-canvas);
    background-image: radial-gradient(
        color-mix(in srgb, var(--canvas-line) 38%, transparent) 1px,
        transparent 1px
    );
    cursor: grab;
    touch-action: pan-y pinch-zoom;
}

/* Keep vertical page scrolling available over the workbench. Explicit box selection owns touch gestures. */
.canvas-stage.canvas-box-mode {
    cursor: crosshair;
    touch-action: none;
}

.canvas-stage.canvas-pan-mode {
    touch-action: none;
}

.canvas-stage.canvas-panning,
.canvas-node-drag .canvas-handle {
    cursor: grabbing;
}

.canvas-stage-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 1rem;
    pointer-events: none;
    text-align: center;
    color: var(--scova-muted);
    font-size: 0.875rem;
}

.canvas-world,
.canvas-group,
.canvas-edges,
.canvas-node,
.canvas-selection {
    position: absolute;
    pointer-events: none;
}

.canvas-world {
    inset: 0 auto auto 0;
    transform-origin: top left;
}

.canvas-group {
    z-index: 0;
    border: 1px dashed color-mix(in srgb, var(--scova-primary) 55%, var(--canvas-line));
    border-radius: 0.875rem;
    background: color-mix(in srgb, var(--scova-primary) 4%, transparent);
}

.canvas-group.is-active {
    border: 2px solid var(--scova-primary);
}

.canvas-group button {
    pointer-events: auto;
    max-inline-size: calc(100% - 1rem);
    margin: 0.35rem 0.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.canvas-edges {
    z-index: 1;
    overflow: visible;
    inset: 0 auto auto 0;
}

.canvas-edge-line,
.canvas-edge-hit {
    fill: none;
}

.canvas-edge-line {
    stroke: var(--scova-muted);
    stroke-width: 1.75;
}

.canvas-edge-hit {
    stroke: transparent;
    stroke-width: 18;
    pointer-events: stroke;
    cursor: pointer;
    touch-action: manipulation;
}

.edge-active .canvas-edge-line,
.canvas-edges g:hover .canvas-edge-line {
    stroke: var(--scova-primary);
    stroke-width: 3;
}

.canvas-node {
    z-index: 2;
    display: flex;
    align-items: start;
    gap: 0.125rem;
    padding: 0.375rem 0.375rem 0.375rem 0.5rem;
    border: 1px solid var(--canvas-line);
    border-radius: 0.65rem;
    background: var(--scova-surface);
    box-shadow: 0 0.125rem 0.5rem color-mix(in srgb, var(--scova-text) 8%, transparent);
}

.canvas-node.is-active,
.canvas-node:focus-within {
    z-index: 3;
    border-color: var(--scova-primary);
    box-shadow: 0 0 0 1px var(--scova-primary);
}

.canvas-node.is-origin {
    background: var(--canvas-tint);
}

.canvas-node button {
    pointer-events: auto;
}

.canvas-node .canvas-node-main {
    display: flex;
    align-items: center;
    align-self: stretch;
    flex: 1;
    min-inline-size: 0;
    gap: 0.4rem;
    padding: 0.25rem 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: start;
}

.canvas-node-copy {
    min-inline-size: 0;
}

.canvas-node-copy strong,
.canvas-node-copy small {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.canvas-node-copy small {
    margin-block-start: 0.25rem;
    color: var(--scova-muted);
}

.canvas-node .canvas-handle {
    flex: 0 0 auto;
    inline-size: 1.65rem;
    min-block-size: 1.65rem;
    padding: 0;
    border-color: transparent;
    color: var(--scova-muted);
    cursor: grab;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
}

.canvas-port {
    position: absolute;
    top: 50%;
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--scova-muted);
    cursor: pointer;
    touch-action: manipulation;
}

.canvas-port::after {
    content: '';
    width: 0.675rem;
    height: 0.675rem;
    border: 2px solid currentColor;
    border-radius: 50%;
    background: var(--scova-surface);
}

.canvas-port.port-ready,
.canvas-port[aria-pressed='true'],
.canvas-port:hover {
    color: var(--scova-primary);
}

.canvas-port.port-ready::after,
.canvas-port[aria-pressed='true']::after {
    background: var(--scova-primary);
}

.input-port {
    left: -1px;
    transform: translate(-50%, -50%);
}

.output-port {
    right: -1px;
    transform: translate(50%, -50%);
}

.canvas-selection {
    z-index: 4;
    border: 1px solid var(--scova-primary);
    background: color-mix(in srgb, var(--scova-primary) 14%, transparent);
}

.canvas-steps,
.canvas-connections {
    display: grid;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
}

.canvas-steps li,
.canvas-connections li {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-inline-size: 0;
    border: 1px solid var(--canvas-line);
    border-radius: 0.4rem;
}

.canvas-steps li.is-active,
.canvas-connections li.selected-edge {
    border-color: var(--scova-primary);
    background: var(--canvas-tint);
}

.canvas-select-step {
    padding: 0.5rem;
    cursor: pointer;
}

button.canvas-step {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    flex: 1;
    border: 0;
    min-block-size: 3rem;
    background: transparent;
    overflow-wrap: anywhere;
}

.canvas-inspector-section {
    min-inline-size: 0;
    display: grid;
    gap: 0.5rem;
    padding-block-start: 0.625rem;
    border-block-start: 1px solid var(--canvas-line);
}

.canvas-connections li {
    justify-content: space-between;
    padding: 0.3rem 0.4rem;
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
}

.canvas-connections button {
    flex: 0 0 auto;
}

button.canvas-connection-label {
    flex: 1 1 auto;
    min-inline-size: 0;
    padding-inline: 0.2rem;
    border-color: transparent;
    background: transparent;
    text-align: start;
    overflow-wrap: anywhere;
}

.canvas-field {
    display: grid;
    gap: 0.25rem;
    min-inline-size: 0;
    font-size: 0.875rem;
}

.canvas-field input,
.canvas-field select {
    min-inline-size: 0;
    width: 100%;
    min-block-size: 2.5rem;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--canvas-line);
    border-radius: 0.375rem;
    color: inherit;
    background-color: var(--scova-surface);
    font: inherit;
}

.canvas-step .canvas-issue,
.canvas-node .canvas-issue,
.canvas-issue,
button.canvas-danger {
    color: var(--scova-danger);
}

@container (width < 57rem) {
    .canvas-workspace {
        grid-template-columns: minmax(0, 1fr) minmax(13rem, 16rem);
    }

    .canvas-library {
        grid-column: 1 / -1;
    }

    .canvas-library-items {
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.25rem), 1fr));
    }
}

@container (width < 45rem) {
    .canvas-workspace,
    .canvas-workspace.without-library {
        grid-template-columns: minmax(0, 1fr);
    }

    .canvas-toolbar button,
    .canvas-group-list button,
    .canvas-inspector button {
        min-block-size: 2.5rem;
    }
}
</style>
