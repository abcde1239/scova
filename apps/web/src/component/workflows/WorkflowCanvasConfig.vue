<template>
    <fieldset class="canvas-fields" :disabled="readonly">
        <legend class="sr-only">节点配置</legend>
        <label>
            节点名称
            <input
                :value="node.label ?? ''"
                maxlength="160"
                :placeholder="nodeTypes[node.type].name"
                @change="setLabel"
            />
        </label>

        <template v-if="node.type === 'study'">
            <label>
                研究任务
                <select :value="node.taskId" @change="setTask(valueOf($event))">
                    <option value="">选择研究任务</option>
                    <option v-if="node.taskId && missingTask" :value="node.taskId">
                        当前任务不在列表中
                    </option>
                    <option v-for="task in tasks" :key="task.id" :value="task.id">
                        {{ task.title }}
                    </option>
                </select>
            </label>
            <p v-if="!tasks.length" class="text-muted text-sm">暂无可选研究任务。</p>
        </template>

        <label v-if="node.type === 'csv' || node.type === 'deliver' || node.type === 'notify'">
            数据来源
            <select :value="node.config.source ?? ''" @change="setSource(valueOf($event))">
                <option value="">
                    {{
                        node.type === 'notify'
                            ? '不附加交付文件'
                            : node.type === 'csv'
                              ? '使用本次运行的 CSV'
                              : '选择上游节点'
                    }}
                </option>
                <option v-if="node.config.source && sourceProblem" :value="node.config.source">
                    {{ labelFor(node.config.source) }}（{{ sourceProblem }}）
                </option>
                <option v-for="source in compatibleUpstream" :key="source.id" :value="source.id">
                    {{ nodeLabel(source) }}
                </option>
            </select>
        </label>

        <template v-if="node.type === 'csv'">
            <fieldset class="canvas-filters">
                <legend>筛选条件</legend>
                <fieldset
                    v-for="(filter, index) in node.config.filters"
                    :key="index"
                    class="canvas-filter"
                >
                    <legend>条件 {{ index + 1 }}</legend>
                    <label>
                        列名
                        <input
                            :value="filter.column"
                            maxlength="256"
                            @change="updateFilter(index, { column: valueOf($event) })"
                        />
                    </label>
                    <label>
                        比较方式
                        <select :value="filter.operator" @change="setOperator(index, $event)">
                            <option
                                v-for="(label, operator) in operators"
                                :key="operator"
                                :value="operator"
                            >
                                {{ label }}
                            </option>
                        </select>
                    </label>
                    <label>
                        比较值
                        <input
                            :value="filter.value"
                            maxlength="8000"
                            @change="updateFilter(index, { value: valueOf($event) })"
                        />
                    </label>
                    <button
                        v-if="!readonly"
                        class="canvas-field-action"
                        type="button"
                        @click="removeFilter(index)"
                    >
                        删除条件 {{ index + 1 }}
                    </button>
                </fieldset>
                <button
                    v-if="!readonly"
                    ref="filterButton"
                    class="canvas-field-action"
                    type="button"
                    :disabled="node.config.filters.length >= 32"
                    @click="addFilter"
                >
                    添加筛选条件
                </button>
            </fieldset>
            <label>
                输出列
                <textarea
                    :value="node.config.columns?.join('\n') ?? ''"
                    rows="3"
                    placeholder="每行一个列名，留空保留全部列"
                    @change="setColumns"
                />
            </label>
        </template>

        <template v-if="node.type === 'generate'">
            <fieldset class="canvas-filters">
                <legend>生成来源</legend>
                <p v-if="!generationSources.length" class="text-muted text-sm">
                    连接上游节点后可选择来源。
                </p>
                <label v-for="source in generationSources" :key="source.id" class="canvas-checkbox">
                    <input
                        type="checkbox"
                        :checked="node.config.sources.includes(source.id)"
                        @change="toggleSource(source.id)"
                    />
                    {{ source.label }}{{ source.problem ? `（${source.problem}）` : '' }}
                </label>
            </fieldset>
            <label>
                生成指令
                <textarea
                    :value="node.config.instructions"
                    rows="4"
                    maxlength="8000"
                    @change="setText('instructions', valueOf($event))"
                />
            </label>
        </template>

        <template v-if="node.type === 'deliver'">
            <label>
                文件格式
                <select :value="node.config.format" @change="setFormat(valueOf($event))">
                    <option value="csv">CSV</option>
                    <option value="markdown">Markdown</option>
                </select>
            </label>
            <label>
                文件名
                <input
                    :value="node.config.filename"
                    maxlength="180"
                    @change="setText('filename', valueOf($event))"
                />
            </label>
        </template>

        <template v-if="node.type === 'notify'">
            <label>
                通知标题
                <input
                    :value="node.config.title"
                    maxlength="8000"
                    @change="setText('title', valueOf($event))"
                />
            </label>
            <label>
                通知正文
                <textarea
                    :value="node.config.body"
                    rows="4"
                    maxlength="8000"
                    @change="setText('body', valueOf($event))"
                />
            </label>
        </template>
    </fieldset>
</template>

<script setup lang="ts">
import { computed, nextTick, useTemplateRef } from 'vue';
import type { WorkflowCanvasNode } from '@scova/models';
import { acceptsCanvasSource, nodeLabel, nodeTypes } from '@/utils/workflow/canvas';

type Filter = Extract<WorkflowCanvasNode, { type: 'csv' }>['config']['filters'][number];

const props = defineProps<{
    node: WorkflowCanvasNode;
    nodes: WorkflowCanvasNode[];
    tasks: ReadonlyArray<{ id: string; title: string }>;
    upstream: WorkflowCanvasNode[];
    readonly?: boolean;
}>();
const emit = defineEmits<{ update: [node: WorkflowCanvasNode] }>();
const filterButton = useTemplateRef('filterButton');
const operators: Record<Filter['operator'], string> = {
    equals: '等于',
    notEquals: '不等于',
    lessThan: '小于',
    greaterThan: '大于',
};
const missingTask = computed(() => {
    const node = props.node;
    return node.type === 'study' && !props.tasks.some((task) => task.id === node.taskId);
});
const compatibleUpstream = computed(() =>
    props.upstream.filter((source) => acceptsCanvasSource(props.node, source)),
);
const sourceProblem = computed(() => {
    const node = props.node;
    if (node.type === 'csv' || node.type === 'deliver' || node.type === 'notify') {
        return node.config.source ? sourceProblemFor(node.config.source) : '';
    }
    return '';
});
const generationSources = computed(() => {
    if (props.node.type !== 'generate') return [];
    const available = compatibleUpstream.value.map((node) => ({
        id: node.id,
        label: nodeLabel(node),
        problem: '',
    }));
    const unavailable = props.node.config.sources.filter(
        (id) => !available.some((source) => source.id === id),
    );
    return [
        ...available,
        ...unavailable.map((id) => ({ id, label: labelFor(id), problem: sourceProblemFor(id) })),
    ];
});

function sourceProblemFor(id: string) {
    const source = props.upstream.find((node) => node.id === id);
    if (!source) return '已断开';
    return acceptsCanvasSource(props.node, source) ? '' : '类型不兼容';
}

function labelFor(id: string) {
    const node = props.nodes.find((entry) => entry.id === id);
    return node ? nodeLabel(node) : '已删除节点';
}

function valueOf(event: Event) {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

function setLabel(event: Event) {
    const input = event.target as HTMLInputElement;
    input.value = input.value.trim();
    const node = { ...props.node };
    if (input.value) node.label = input.value;
    else delete node.label;
    emit('update', node);
}

function setTask(taskId: string) {
    if (props.node.type === 'study') emit('update', { ...props.node, taskId });
}

function setSource(source: string) {
    const node = props.node;
    if (node.type === 'deliver') emit('update', { ...node, config: { ...node.config, source } });
    if (node.type === 'csv' || node.type === 'notify') {
        const next = { ...node, config: { ...node.config } } as typeof node;
        if (source) next.config.source = source;
        else delete next.config.source;
        emit('update', next);
    }
}

function addFilter() {
    const node = props.node;
    if (node.type !== 'csv' || node.config.filters.length >= 32) return;
    const filters: Filter[] = [
        ...node.config.filters,
        { column: '', operator: 'equals', value: '' },
    ];
    emit('update', { ...node, config: { ...node.config, filters } });
    void nextTick(() =>
        filterButton.value?.previousElementSibling?.querySelector('input')?.focus(),
    );
}

function updateFilter(index: number, patch: Partial<Filter>) {
    const node = props.node;
    if (node.type !== 'csv') return;
    const filters = node.config.filters.map((filter, item) =>
        item === index ? { ...filter, ...patch } : filter,
    );
    emit('update', { ...node, config: { ...node.config, filters } });
}

function setOperator(index: number, event: Event) {
    const operator = valueOf(event);
    if (Object.hasOwn(operators, operator))
        updateFilter(index, { operator: operator as Filter['operator'] });
}

function removeFilter(index: number) {
    const node = props.node;
    if (node.type !== 'csv') return;
    const filters = node.config.filters.filter((_, item) => item !== index);
    emit('update', { ...node, config: { ...node.config, filters } });
    void nextTick(() => filterButton.value?.focus());
}

function setColumns(event: Event) {
    const node = props.node;
    if (node.type !== 'csv') return;
    const input = event.target as HTMLTextAreaElement;
    const columns = input.value
        .split('\n')
        .map((column) => column.trim().slice(0, 256))
        .filter(Boolean)
        .slice(0, 128);
    input.value = columns.join('\n');
    const config = { ...node.config };
    if (columns.length) config.columns = columns;
    else delete config.columns;
    emit('update', { ...node, config });
}

function toggleSource(id: string) {
    const node = props.node;
    if (node.type !== 'generate') return;
    const sources = node.config.sources.includes(id)
        ? node.config.sources.filter((source) => source !== id)
        : [...node.config.sources, id];
    emit('update', { ...node, config: { ...node.config, sources } });
}

function setFormat(format: string) {
    const node = props.node;
    if (node.type === 'deliver' && (format === 'csv' || format === 'markdown')) {
        emit('update', { ...node, config: { ...node.config, format } });
    }
}

function setText(field: 'instructions' | 'filename' | 'title' | 'body', value: string) {
    const node = props.node;
    if (node.type === 'generate' && field === 'instructions')
        emit('update', { ...node, config: { ...node.config, instructions: value } });
    if (node.type === 'deliver' && field === 'filename')
        emit('update', { ...node, config: { ...node.config, filename: value } });
    if (node.type === 'notify' && (field === 'title' || field === 'body'))
        emit('update', { ...node, config: { ...node.config, [field]: value } });
}
</script>

<style scoped>
.canvas-fields,
.canvas-filters,
.canvas-filter {
    display: grid;
    gap: 0.625rem;
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
}

.canvas-filters,
.canvas-filter {
    padding: 0.625rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.5rem;
}

label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.875rem;
}

.canvas-checkbox {
    grid-template-columns: auto 1fr;
    align-items: start;
    gap: 0.5rem;
    min-block-size: 1.75rem;
    overflow-wrap: anywhere;
}

input:not([type='checkbox']),
select,
textarea {
    width: 100%;
    min-inline-size: 0;
    min-block-size: 2.5rem;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.375rem;
    color: inherit;
    background: var(--scova-surface);
    font: inherit;
}

textarea {
    resize: vertical;
}

.canvas-field-action {
    justify-self: start;
    min-block-size: 2rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.375rem;
    background: var(--scova-surface);
    color: inherit;
    cursor: pointer;
}

:focus-visible {
    outline: 2px solid var(--scova-primary);
    outline-offset: 2px;
}

:disabled {
    cursor: default;
}
</style>
