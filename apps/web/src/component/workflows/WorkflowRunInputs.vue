<template>
    <fieldset class="layout-grid gap-3 min-w-0 m-0 p-0 border-none" :disabled="busy">
        <legend class="font-semibold p-0">本次运行输入</legend>
        <label v-if="acceptsDataFile" class="layout-grid gap-1">
            {{ hasTableNode ? '选择 CSV 或 JSON 文件' : '选择 JSON 文件' }}（最大 256 KiB）
            <input
                type="file"
                name="workflow-data"
                :accept="
                    hasTableNode ? '.csv,text/csv,.json,application/json' : '.json,application/json'
                "
                :aria-invalid="fileError ? true : undefined"
                :aria-describedby="fileError ? errorId : undefined"
                @change="readDataFile"
            />
        </label>
        <p v-if="fileName" class="m-0 text-muted">已选择 {{ fileName }}</p>
        <p v-if="fileError" :id="errorId" class="m-0" role="alert">{{ fileError }}</p>
        <label class="layout-grid gap-1">
            补充文本
            <textarea
                :value="input.text ?? ''"
                class="workflow-input"
                rows="3"
                maxlength="64000"
                @input="setText('text', $event)"
            />
        </label>
        <label v-if="showInventoryColumn" class="layout-grid gap-1">
            库存列名
            <input
                :value="input.inventoryColumn ?? ''"
                class="workflow-input"
                maxlength="256"
                @input="setText('inventoryColumn', $event)"
            />
        </label>
        <label v-if="showThreshold" class="layout-grid gap-1">
            预警阈值
            <input
                :value="input.threshold ?? ''"
                class="workflow-input"
                type="number"
                step="any"
                @input="setThreshold"
            />
        </label>
        <label v-if="showPeriod" class="layout-grid gap-1">
            报告周期
            <input
                :value="input.period ?? ''"
                class="workflow-input"
                maxlength="128"
                @input="setText('period', $event)"
            />
        </label>
        <label v-if="hasGenerator" class="layout-grid gap-1">
            模型
            <select
                class="workflow-input"
                :value="input.providerId ?? ''"
                @change="setText('providerId', $event)"
            >
                <option value="">账号默认模型</option>
                <option
                    v-for="provider in providers?.items ?? []"
                    :key="provider.id"
                    :value="provider.id"
                >
                    {{ provider.name }} · {{ provider.model }}
                </option>
            </select>
        </label>
        <p v-if="hasGenerator && providerQuery.isError.value" class="m-0 text-muted">
            模型列表暂不可用。
        </p>
        <label v-if="hasNotification" class="flex items-center gap-2">
            <input type="checkbox" :checked="input.notify !== false" @change="setNotify" />
            启用通知节点
        </label>
    </fieldset>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { WorkflowCanvasGraph, WorkflowCanvasInput } from '@scova/models';
import { listProvidersEndpoint } from '@/api/agent-providers';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import { readWorkflowInputFile } from '@/utils/workflow/input-file';

const props = defineProps<{ graph: WorkflowCanvasGraph; busy?: boolean }>();
const emit = defineEmits<{ filePending: [value: boolean]; fileInvalid: [value: boolean] }>();
const input = defineModel<WorkflowCanvasInput>({ required: true });
const fileName = ref('');
const fileError = ref('');
const errorId = useId();
const rawConfig = computed(() => JSON.stringify(props.graph.nodes));
const hasTableNode = computed(() => props.graph.nodes.some((node) => node.type === 'csv'));
const acceptsDataFile = computed(
    () =>
        hasTableNode.value ||
        props.graph.nodes.some(
            (node) =>
                node.type === 'generate' ||
                (node.type === 'deliver' && node.config.format === 'json'),
        ),
);
const hasGenerator = computed(() => props.graph.nodes.some((node) => node.type === 'generate'));
const hasNotification = computed(() => props.graph.nodes.some((node) => node.type === 'notify'));
const showInventoryColumn = computed(() => rawConfig.value.includes('{{inventoryColumn}}'));
const showThreshold = computed(() => rawConfig.value.includes('{{threshold}}'));
const showPeriod = computed(() => rawConfig.value.includes('{{period}}'));
const lifecycle = useSessionLifecycle();
const providerQuery = useQuery(
    computed(() => {
        const options = lifecycle.queryOptions(listProvidersEndpoint, {}, ['agent-providers']);
        return { ...options, enabled: options.enabled && hasGenerator.value };
    }),
    lifecycle.queryClient,
);
const providers = computed(() => providerQuery.data.value?.data);

function setText(key: 'text' | 'providerId' | 'period' | 'inventoryColumn', event: Event) {
    const next = { ...input.value };
    const value = (event.target as HTMLInputElement).value;
    if (value) next[key] = value;
    else delete next[key];
    input.value = next;
}
function setThreshold(event: Event) {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    const next = { ...input.value };
    if (Number.isFinite(value)) next.threshold = value;
    else delete next.threshold;
    input.value = next;
}
function setNotify(event: Event) {
    input.value = { ...input.value, notify: (event.target as HTMLInputElement).checked };
}
async function readDataFile(event: Event) {
    const field = event.target as HTMLInputElement;
    const file = field.files?.[0];
    fileName.value = '';
    fileError.value = '';
    const next = { ...input.value };
    delete next.csv;
    delete next.json;
    input.value = next;
    emit('fileInvalid', false);
    if (!file) return;
    emit('filePending', true);
    try {
        const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
        if (format === 'csv' && (!hasTableNode.value || !file.name.toLowerCase().endsWith('.csv')))
            throw new Error(hasTableNode.value ? '请选择 CSV 或 JSON 文件' : '请选择 JSON 文件');
        const text = await readWorkflowInputFile(file, format);
        input.value = { ...input.value, [format]: text };
        fileName.value = file.name;
    } catch (error) {
        emit('fileInvalid', true);
        fileError.value = error instanceof Error ? error.message : '读取文件失败';
        field.value = '';
    } finally {
        emit('filePending', false);
    }
}
</script>

<style scoped>
.workflow-input {
    inline-size: min(100%, 32rem);
    min-block-size: 2.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.5rem;
    background: var(--scova-surface);
    color: inherit;
}
</style>
