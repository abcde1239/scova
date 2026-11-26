<template>
    <section class="surface-card layout-grid gap-4 p-4" :aria-labelledby="`${id}-heading`">
        <h2 :id="`${id}-heading`" class="m-0">工作流模板</h2>
        <details
            v-if="workflowId && versionId"
            :key="`${lifecycle.session.epoch}:${workflowId}:${versionId}`"
        >
            <summary class="cursor-pointer font-semibold">保存为我的模板</summary>
            <form
                class="layout-grid gap-3 mt-3"
                method="post"
                :aria-labelledby="`${id}-save`"
                @submit.prevent="save"
            >
                <h3 :id="`${id}-save`" class="m-0">从已发布版本保存</h3>
                <label class="layout-grid gap-1">
                    模板名称（必填）
                    <input
                        name="title"
                        class="template-input"
                        required
                        maxlength="160"
                        pattern=".*\S.*"
                    />
                </label>
                <label class="layout-grid gap-1">
                    适用场景
                    <textarea name="description" class="template-input" rows="2" maxlength="1000" />
                </label>
                <label class="layout-grid gap-1">
                    交付说明
                    <textarea name="delivery" class="template-input" rows="2" maxlength="1000" />
                </label>
                <fieldset
                    class="layout-grid gap-2 m-0 p-0 border-none"
                    :disabled="saving.isPending.value"
                >
                    <legend class="font-semibold p-0">公开的运行输入</legend>
                    <div
                        v-for="field in fieldCatalog"
                        :key="field.key"
                        class="flex flex-wrap items-center gap-x-4 gap-y-1"
                    >
                        <label class="flex items-center gap-1">
                            <input
                                v-model="exposed"
                                name="fields"
                                type="checkbox"
                                :value="field.key"
                            />
                            {{ field.label }}
                        </label>
                        <template v-if="exposed.includes(field.key)">
                            <label v-if="field.key !== 'notify'" class="flex items-center gap-1">
                                <input :name="`${field.key}-required`" type="checkbox" />
                                {{ field.label }}必填
                            </label>
                            <label
                                v-if="field.key === 'threshold'"
                                class="flex flex-wrap items-center gap-1"
                            >
                                默认阈值
                                <input
                                    name="threshold-default"
                                    class="template-input template-default"
                                    type="number"
                                    step="any"
                                />
                            </label>
                            <label
                                v-else-if="
                                    field.key === 'inventoryColumn' || field.key === 'period'
                                "
                                class="flex flex-wrap items-center gap-1"
                            >
                                {{ field.label }}默认值
                                <input
                                    :name="`${field.key}-default`"
                                    class="template-input template-default"
                                    :maxlength="field.key === 'period' ? 128 : 256"
                                />
                            </label>
                            <label
                                v-else-if="field.key === 'notify'"
                                class="flex items-center gap-1"
                            >
                                <input name="notify-default" type="checkbox" />
                                默认发送
                            </label>
                        </template>
                    </div>
                </fieldset>
                <div>
                    <action-button type="primary" attr-type="submit" :busy="saving.isPending.value"
                        >保存模板</action-button
                    >
                </div>
            </form>
        </details>
        <state-panel v-if="library.isPending.value" state="loading" message="正在读取模板" />
        <state-panel
            v-else-if="library.isError.value && !items.length"
            state="error"
            :message="toApiError(library.error.value).message"
            retryable
            @retry="library.refetch()"
        />
        <ul v-else class="template-cards list-none p-0 m-0" aria-label="选择要使用的工作流模板">
            <li
                v-for="item in items"
                :key="identity(item)"
                class="template-card layout-grid gap-2 p-3 min-w-0"
            >
                <h3 class="m-0 break-anywhere">{{ item.title }}</h3>
                <p class="m-0 text-muted">
                    {{ item.kind === 'builtin' ? '内置模板' : '我的模板' }} · 版本
                    {{ item.version }}
                </p>
                <p v-if="item.description" class="m-0 break-anywhere">{{ item.description }}</p>
                <p v-if="item.delivery" class="m-0 break-anywhere">{{ item.delivery }}</p>
                <p
                    v-if="item.graph.nodes.some((node) => node.type === 'generate')"
                    class="m-0 text-muted"
                >
                    运行时调用模型
                </p>
                <div>
                    <action-button
                        :disabled="busy"
                        v-bind="{
                            'aria-expanded': selectedId === identity(item),
                            'aria-controls':
                                selectedId === identity(item) ? `${id}-selection` : undefined,
                        }"
                        @click="select(item)"
                        >{{
                            selectedId === identity(item) ? '收起模板' : '使用模板'
                        }}</action-button
                    >
                </div>
            </li>
        </ul>
        <div
            v-if="selected"
            :id="`${id}-selection`"
            :key="selectedId"
            class="layout-grid gap-3 min-w-0"
        >
            <h3 :id="`${id}-run`" ref="selectionHeading" class="m-0" tabindex="-1">
                {{ selected.title }}
            </h3>
            <details>
                <summary class="cursor-pointer">查看包含的步骤</summary>
                <ul class="m-0">
                    <li v-for="node in selected.graph.nodes" :key="node.id">
                        {{ node.label ?? nodeLabels[node.type] }}
                    </li>
                </ul>
            </details>
            <p v-if="selected.requiresBindings" class="m-0 text-muted">
                请复制到画布，为研究节点重新选择任务后再发布。
            </p>
            <form
                v-else
                class="layout-grid gap-3"
                method="post"
                :aria-labelledby="`${id}-run`"
                @submit.prevent="start"
            >
                <fieldset class="layout-grid gap-3 m-0 p-0 border-none" :disabled="busy">
                    <legend class="font-semibold p-0">本次运行输入</legend>
                    <template v-for="field in selected.fields" :key="field.key">
                        <label v-if="field.key === 'notify'" class="flex items-center gap-2">
                            <input :name="field.key" type="checkbox" v-model="notify" />
                            {{ field.label }}
                        </label>
                        <label v-else class="layout-grid gap-1">
                            <span>{{ field.label }}{{ field.required ? '（必填）' : '' }}</span>
                            <input
                                v-if="field.key === 'csv' || field.key === 'json'"
                                :name="field.key"
                                type="file"
                                :accept="
                                    field.key === 'json'
                                        ? '.json,application/json'
                                        : '.csv,text/csv'
                                "
                                :required="field.required && !(field.key === 'csv' && sampleCsv)"
                                @change="field.key === 'csv' && (sampleCsv = '')"
                            />
                            <textarea
                                v-else-if="field.key === 'text'"
                                :name="field.key"
                                class="template-input"
                                rows="3"
                                maxlength="64000"
                                :required="field.required"
                            />
                            <select
                                v-else-if="field.key === 'providerId'"
                                :name="field.key"
                                class="template-input"
                                :required="field.required"
                            >
                                <option value="">
                                    {{ field.required ? '请选择账号已配置的模型' : '账号默认模型' }}
                                </option>
                                <option
                                    v-for="provider in providers.data.value?.data.items ?? []"
                                    :key="provider.id"
                                    :value="provider.id"
                                >
                                    {{ provider.name }} · {{ provider.model }}
                                </option>
                            </select>
                            <input
                                v-else-if="field.key === 'threshold'"
                                :name="field.key"
                                v-model="runValues[field.key]"
                                class="template-input"
                                type="number"
                                step="any"
                                :required="field.required"
                            />
                            <input
                                v-else
                                :name="field.key"
                                v-model="runValues[field.key]"
                                class="template-input"
                                :required="field.required"
                                :maxlength="field.key === 'period' ? 128 : 256"
                            />
                        </label>
                        <div
                            v-if="field.key === 'csv' && sampleAvailable"
                            class="flex flex-wrap items-center gap-2"
                        >
                            <template v-if="sampleCsv">
                                <span class="text-muted"
                                    >已使用示例数据（2 行，库存列
                                    stock）。选择文件会改用你的数据。</span
                                >
                                <action-button text @click="sampleCsv = ''">取消示例</action-button>
                            </template>
                            <action-button v-else text @click="useSample"
                                >使用示例数据</action-button
                            >
                        </div>
                    </template>
                    <p v-if="requiresProvider && providers.isError.value" class="m-0 text-muted">
                        模型列表暂不可用。
                    </p>
                </fieldset>
                <div>
                    <action-button
                        type="primary"
                        attr-type="submit"
                        :busy="starting"
                        :disabled="copying.isPending.value"
                    >
                        {{ attempt ? '运行或重试' : '运行模板' }}
                    </action-button>
                </div>
            </form>
            <div class="flex flex-wrap items-center gap-3">
                <action-button :busy="copying.isPending.value" :disabled="starting" @click="copy"
                    >复制到画布</action-button
                >
                <router-link
                    v-if="latestRunId"
                    class="internal-link"
                    :to="{ name: 'workflow-run-detail', params: { runId: latestRunId } }"
                    >查看本次运行</router-link
                >
                <router-link
                    v-if="selected.workflowId"
                    class="internal-link"
                    :to="{ name: 'workflow-detail', params: { workflowId: selected.workflowId } }"
                    >查看运行历史</router-link
                >
            </div>
        </div>
        <p v-if="problem" ref="problemText" class="m-0" role="alert" tabindex="-1">{{ problem }}</p>
        <p v-if="status" class="m-0" role="status">{{ status }}</p>
    </section>
</template>

<script setup lang="ts">
import { readWorkflowInputFile } from '@/utils/workflow/input-file';
import { useQuery } from '@tanstack/vue-query';
import { computed, nextTick, ref, useId, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { WorkflowCanvasInput, WorkflowTemplate, WorkflowTemplateField } from '@scova/models';
import { listProvidersEndpoint } from '@/api/agent-providers';
import { toApiError } from '@/api/errors';
import { shouldReportQueryError } from '@/api/query';
import {
    copyWorkflowTemplateEndpoint,
    saveWorkflowTemplateEndpoint,
    startWorkflowTemplateEndpoint,
    workflowTemplatesEndpoint,
} from '@/api/workflow-templates';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import {
    useSessionLifecycle,
    useSessionMutation,
    useSessionQuery,
} from '@/composable/useSessionQuery';

const props = defineProps<{ workflowId?: string; versionId?: string }>();
const emit = defineEmits<{
    copied: [workflowId: string];
    started: [workflowId: string, runId: string];
}>();
const id = useId();
const lifecycle = useSessionLifecycle();
const libraryKey = ['workflow-templates'];
const library = useSessionQuery(workflowTemplatesEndpoint, {}, libraryKey, lifecycle);
const copying = useSessionMutation(copyWorkflowTemplateEndpoint, lifecycle);
const saving = useSessionMutation(saveWorkflowTemplateEndpoint, lifecycle);
const startMutation = useSessionMutation(startWorkflowTemplateEndpoint, lifecycle);
const items = computed(() => library.data.value?.data.items ?? []);
const selectedId = ref('');
const selected = computed(() => items.value.find((item) => identity(item) === selectedId.value));
const requiresProvider = computed(() =>
    selected.value?.fields.some((field) => field.key === 'providerId'),
);
const providers = useQuery(
    computed(() => {
        const options = lifecycle.queryOptions(listProvidersEndpoint, {}, ['agent-providers']);
        return { ...options, enabled: options.enabled && requiresProvider.value === true };
    }),
    lifecycle.queryClient,
);
const starting = ref(false);
const busy = computed(() => starting.value || copying.isPending.value);
const attempt = ref<{ payload: string; key: string }>();
const latestRunId = ref('');
const problem = ref('');
const status = ref('');
const problemText = ref<HTMLParagraphElement>();
const selectionHeading = ref<HTMLHeadingElement>();
const exposed = ref<(keyof WorkflowCanvasInput)[]>([]);
const runValues = ref<Record<string, string | number>>({});
const notify = ref(false);
// A two-row inventory sample lets a new account finish a run without preparing a file.
const inventorySample = ['sku,stock', 'sample-A,4', 'sample-B,12', ''].join('\n');
const sampleCsv = ref('');
const sampleAvailable = computed(() =>
    ['csv', 'inventoryColumn'].every((key) =>
        selected.value?.fields.some((field) => field.key === key),
    ),
);
function useSample() {
    sampleCsv.value = inventorySample;
    runValues.value = { ...runValues.value, inventoryColumn: 'stock' };
    if (runValues.value.threshold === undefined || runValues.value.threshold === '')
        runValues.value.threshold = 10;
}
const nodeLabels = {
    start: '开始',
    study: '研究',
    csv: '整理表格',
    merge: '汇合',
    generate: '生成',
    deliver: '交付',
    notify: '站内通知',
    end: '结束',
};
const fieldCatalog = [
    { key: 'json', label: 'JSON 文件' },
    { key: 'csv', label: 'CSV 文件' },
    { key: 'text', label: '补充文本' },
    { key: 'inventoryColumn', label: '库存列名' },
    { key: 'threshold', label: '预警阈值' },
    { key: 'period', label: '报告周期' },
    { key: 'providerId', label: '生成模型' },
    { key: 'notify', label: '站内通知' },
] as const;

function identity(item: WorkflowTemplate) {
    return `${item.id}:${item.version}`;
}

function params(item: WorkflowTemplate) {
    return { templateId: item.id, templateVersion: String(item.version) };
}

function formData(event: SubmitEvent) {
    return new FormData(event.currentTarget as HTMLFormElement);
}

watch(
    () => lifecycle.session.epoch,
    () => {
        selectedId.value = '';
        exposed.value = [];
        runValues.value = {};
        notify.value = false;
        problem.value = '';
        status.value = '';
        latestRunId.value = '';
        attempt.value = undefined;
        starting.value = false;
        copying.reset();
        saving.reset();
        startMutation.reset();
    },
);

watch(
    () => [props.workflowId, props.versionId],
    () => {
        exposed.value = [];
    },
);

async function select(item: WorkflowTemplate) {
    if (busy.value) return;
    const next = identity(item);
    runValues.value = Object.fromEntries(
        item.fields.flatMap((field) =>
            'default' in field && field.default !== undefined && field.key !== 'notify'
                ? [[field.key, field.default]]
                : [],
        ),
    );
    notify.value = item.fields.find((field) => field.key === 'notify')?.default ?? false;
    sampleCsv.value = '';
    selectedId.value = selectedId.value === next ? '' : next;
    attempt.value = undefined;
    latestRunId.value = '';
    problem.value = '';
    status.value = '';
    await nextTick();
    selectionHeading.value?.focus();
}

async function showError(error: unknown) {
    if (!shouldReportQueryError(error)) return;
    problem.value = toApiError(error).message;
    await nextTick();
    problemText.value?.focus();
}

async function readInput(
    fields: WorkflowTemplateField[],
    form: FormData,
): Promise<WorkflowCanvasInput> {
    const entries = await Promise.all(
        fields.map(async ({ key }) => {
            const value = form.get(key);
            if (key === 'notify') return [key, form.has(key)] as const;
            if (key === 'csv' || key === 'json') {
                if (!(value instanceof File) || !value.name)
                    return key === 'csv' && sampleCsv.value ? [key, sampleCsv.value] : undefined;
                return [key, await readWorkflowInputFile(value, key)] as const;
            }
            if (typeof value !== 'string' || !value.trim()) return;
            return [key, key === 'threshold' ? Number(value) : value] as const;
        }),
    );
    return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

async function start(event: SubmitEvent) {
    const template = selected.value;
    if (!template || busy.value) return;
    const scope = lifecycle.capture();
    const form = formData(event);
    problem.value = '';
    status.value = '';
    starting.value = true;
    try {
        let input: WorkflowCanvasInput;
        try {
            input = await readInput(template.fields, form);
        } catch (error) {
            if (scope.isCurrent()) {
                problem.value = error instanceof Error ? error.message : '无法读取模板输入';
                await nextTick();
                problemText.value?.focus();
            }
            return;
        }
        if (!scope.isCurrent()) return;
        const payload = JSON.stringify(input);
        if (attempt.value?.payload !== payload)
            attempt.value = { payload, key: crypto.randomUUID() };
        const { data } = await startMutation.mutateAsync({
            input: { params: params(template), body: { input } },
            options: { idempotencyKey: attempt.value.key },
        });
        if (!scope.isCurrent()) return;
        attempt.value = undefined;
        latestRunId.value = data.run.id;
        status.value = '运行已启动。';
        void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(libraryKey) });
        void lifecycle.queryClient.invalidateQueries({
            queryKey: scope.queryKey(['workflows', data.run.workflowId, 'runs']),
        });
        emit('started', data.run.workflowId, data.run.id);
    } catch (error) {
        if (scope.isCurrent()) await showError(error);
    } finally {
        if (scope.isCurrent()) starting.value = false;
    }
}

async function copy() {
    if (!selected.value || busy.value) return;
    const scope = lifecycle.capture();
    problem.value = '';
    status.value = '';
    try {
        const { data } = await copying.mutateAsync({ input: { params: params(selected.value) } });
        if (!scope.isCurrent()) return;
        status.value = '已复制到画布。';
        void lifecycle.queryClient.invalidateQueries({
            queryKey: scope.queryKey(['workflows', 'list']),
        });
        emit('copied', data.workflow.id);
    } catch (error) {
        if (scope.isCurrent()) await showError(error);
    }
}

function selectedFields(form: FormData): WorkflowTemplateField[] {
    return fieldCatalog
        .filter(({ key }) => exposed.value.includes(key))
        .map<WorkflowTemplateField>(({ key, label }) => {
            const definition = { label, required: form.has(`${key}-required`) };
            const raw = String(form.get(`${key}-default`) ?? '').trim();
            switch (key) {
                case 'threshold':
                    return { key, ...definition, ...(raw ? { default: Number(raw) } : {}) };
                case 'inventoryColumn':
                    return { key, ...definition, ...(raw ? { default: raw } : {}) };
                case 'period':
                    return { key, ...definition, ...(raw ? { default: raw } : {}) };
                case 'notify':
                    return { key, ...definition, default: form.has('notify-default') };
                case 'csv':
                case 'json':
                    return { key, ...definition };
                case 'text':
                    return { key, ...definition };
                case 'providerId':
                    return { key, ...definition };
            }
        });
}

async function save(event: SubmitEvent) {
    const { workflowId, versionId } = props;
    if (!workflowId || !versionId || saving.isPending.value) return;
    const scope = lifecycle.capture();
    const form = event.currentTarget as HTMLFormElement;
    const data = formData(event);
    problem.value = '';
    status.value = '';
    try {
        await saving.mutateAsync({
            input: {
                body: {
                    workflowId,
                    versionId,
                    title: String(data.get('title') ?? ''),
                    description: String(data.get('description') ?? ''),
                    delivery: String(data.get('delivery') ?? ''),
                    fields: selectedFields(data),
                },
            },
        });
        if (!scope.isCurrent()) return;
        if (props.workflowId === workflowId && props.versionId === versionId) {
            form.reset();
            exposed.value = [];
        }
        status.value = '已保存到我的模板。';
        void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(libraryKey) });
    } catch (error) {
        if (scope.isCurrent()) await showError(error);
    }
}
</script>

<style scoped>
.template-cards {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
}

.template-card {
    align-content: start;
    border: 1px solid var(--scova-border);
    border-radius: 0.5rem;
}

.template-input {
    inline-size: min(100%, 32rem);
    min-block-size: 3rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.5rem;
    background: var(--scova-surface);
    color: inherit;
    font: inherit;
    font-size: max(1rem, 1em);
}

.template-default {
    inline-size: min(100%, 12rem);
}
</style>
