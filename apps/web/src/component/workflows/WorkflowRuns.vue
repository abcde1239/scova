<template>
    <section class="surface-card p-4 layout-grid gap-4" aria-labelledby="workflow-runs-heading">
        <h2 id="workflow-runs-heading" class="m-0">运行工作流</h2>
        <p v-if="!published" class="m-0 text-muted">发布版本后即可启动运行。</p>
        <form v-else class="layout-grid gap-3" method="post" @submit.prevent="start">
            <div class="layout-grid gap-2 max-w-[32rem]">
                <label for="workflow-version">发布版本</label>
                <select
                    id="workflow-version"
                    v-model="versionId"
                    class="workflow-select"
                    required
                    :disabled="starting.isPending.value"
                >
                    <option v-for="version in versionOptions" :key="version.id" :value="version.id">
                        版本 {{ version.version
                        }}{{ version.id === published.id ? '（最新）' : '' }}
                    </option>
                </select>
            </div>
            <p v-if="selectedVersion" class="m-0 text-muted">
                {{ selectedVersion.title }} · {{ selectedVersion.bindings.length }} 个研究节点
            </p>
            <div v-if="versions.isError.value || versions.hasNextPage.value">
                <action-button
                    :busy="versions.isFetching.value"
                    @click="versions.isError.value ? versions.refetch() : versions.fetchNextPage()"
                >
                    {{ versions.isError.value ? '重试读取发布版本' : '加载更早的版本' }}
                </action-button>
            </div>
            <div>
                <action-button
                    type="primary"
                    attr-type="submit"
                    :disabled="!selectedVersion"
                    :busy="starting.isPending.value"
                >
                    {{
                        startKeys.has(versionId) && !starting.isPending.value
                            ? '重试启动'
                            : '启动运行'
                    }}
                </action-button>
            </div>
        </form>
        <p v-if="problem" role="alert" class="m-0">{{ problem }}</p>
        <p v-if="actionResult" role="status" class="m-0">{{ actionResult }}</p>

        <div v-if="published || items.length" class="layout-grid gap-2">
            <h3 class="m-0">运行历史</h3>
            <state-panel
                v-if="history.isPending.value"
                state="loading"
                message="正在读取运行历史"
            />
            <state-panel
                v-else-if="history.isError.value && !items.length"
                state="error"
                :message="toApiError(history.error.value).message"
                retryable
                @retry="history.refetch()"
            />
            <p v-else-if="!items.length" class="text-muted m-0">暂无运行</p>
            <ul v-else class="layout-grid gap-2 m-0 p-0 list-none" aria-label="选择要查看的运行">
                <li v-for="item in items" :key="item.id" class="min-w-0">
                    <action-button
                        v-bind="{ 'aria-pressed': runId === item.id }"
                        @click="selectRun(item.id)"
                        >{{ runTime.format(new Date(item.createdAt)) }} ·
                        {{ statusLabels[(run?.id === item.id ? run : item).status] }}</action-button
                    >
                </li>
            </ul>
            <div v-if="history.hasNextPage.value">
                <action-button
                    :busy="history.isFetchingNextPage.value"
                    @click="history.fetchNextPage()"
                    >{{
                        history.isFetchNextPageError.value ? '重试加载' : '加载更多运行'
                    }}</action-button
                >
            </div>
        </div>

        <section v-if="runId" class="layout-grid gap-3" aria-labelledby="workflow-run-heading">
            <h3 id="workflow-run-heading" ref="runHeading" class="m-0" tabindex="-1">运行详情</h3>
            <state-panel
                v-if="runQuery.isPending.value"
                state="loading"
                message="正在读取运行详情"
            />
            <state-panel
                v-else-if="runQuery.isError.value"
                state="error"
                :message="toApiError(runQuery.error.value).message"
                retryable
                @retry="runQuery.refetch()"
            />
            <template v-if="run">
                <p class="m-0 break-anywhere" role="status">
                    {{ statusLabels[run.status] }} ·
                    {{ run.mode === 'live' ? '实际运行' : '演示运行' }}
                    <template v-if="run.failureCode"> · {{ run.failureCode }}</template>
                </p>
                <div v-if="canCancel">
                    <action-button :busy="canceling.isPending.value" @click="cancel"
                        >取消运行</action-button
                    >
                </div>
                <ol class="layout-grid gap-2 m-0 p-0 list-none" aria-label="节点运行状态">
                    <li
                        v-for="node in run.nodes"
                        :key="node.id"
                        class="run-node layout-grid gap-1 break-anywhere"
                    >
                        <span class="font-semibold"
                            >{{ nodeLabels[node.type] }} · {{ statusLabels[node.status] }}</span
                        >
                        <span v-if="node.type === 'study'">执行尝试 {{ node.attempt }}</span>
                        <span v-if="node.failureCode">{{ node.failureCode }}</span>
                        <router-link
                            v-if="node.childRunId"
                            class="internal-link"
                            :to="{ name: 'run-detail', params: { runId: node.childRunId } }"
                        >
                            查看研究执行{{
                                node.childStatus ? `（${childStatusLabel(node.childStatus)}）` : ''
                            }}
                        </router-link>
                    </li>
                </ol>
            </template>
        </section>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type { Run, WorkflowRun, WorkflowVersionListSchema } from '@scova/models';
import {
    cancelWorkflowRunEndpoint,
    startWorkflowEndpoint,
    workflowRunEndpoint,
    workflowRunsEndpoint,
    workflowVersionsEndpoint,
    type WorkflowDetail,
} from '@/api/workflows';
import type { ApiResponse } from '@/api/client';
import { toApiError } from '@/api/errors';
import { shouldReportQueryError } from '@/api/query';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';
import { useWorkflowPages } from '@/composable/useWorkflowPages';
import { workflowRunIsActive } from '@/utils/workflow/serial';

const props = defineProps<{ workflowId: string; published: WorkflowDetail['publishedVersion'] }>();
const lifecycle = useSessionLifecycle();
const lifetime = new AbortController();
onScopeDispose(() => lifetime.abort());
const runTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const statusLabels = {
    queued: '排队中',
    running: '运行中',
    cancel_requested: '取消中',
    succeeded: '已完成',
    canceled: '已取消',
    failed: '失败',
    pending: '待运行',
    skipped: '已跳过',
};
const nodeLabels = { start: '开始', study: '研究', end: '结束' };
const historyKey = ['workflows', props.workflowId, 'runs'];
const { query: history, items } = useWorkflowPages<WorkflowRun>(
    lifecycle,
    historyKey,
    (scope, query, signal) =>
        scope.request(
            workflowRunsEndpoint,
            { params: { workflowId: props.workflowId }, query },
            { signal },
        ),
    () => props.published !== null,
);
const versionId = ref(props.published?.id ?? '');
const runId = ref('');
const problem = ref('');
const actionResult = ref('');
const runHeading = ref<HTMLElement>();
const starting = useSessionMutation(startWorkflowEndpoint, lifecycle);
const canceling = useSessionMutation(cancelWorkflowRunEndpoint, lifecycle);
const startKeys = reactive(new Map<string, string>());

const versionsKey = ['workflows', props.workflowId, 'versions'];
const { query: versions, items: publishedVersions } = useWorkflowPages<
    (typeof WorkflowVersionListSchema.static)['items'][number]
>(
    lifecycle,
    versionsKey,
    (scope, query, signal) =>
        scope.request(
            workflowVersionsEndpoint,
            { params: { workflowId: props.workflowId }, query },
            { signal },
        ),
    () => props.published !== null,
);
const versionOptions = computed(() => {
    const latest = props.published;
    return latest
        ? [latest, ...publishedVersions.value.filter((version) => version.id !== latest.id)]
        : [];
});
const selectedVersion = computed(() =>
    versionOptions.value.find((version) => version.id === versionId.value),
);
watch(
    () => props.published?.id,
    (id, previous) => {
        if (!versionId.value || versionId.value === previous) versionId.value = id ?? '';
        void lifecycle.queryClient.invalidateQueries({
            queryKey: lifecycle.capture().queryKey(versionsKey),
        });
    },
);

function runOptions(id: string) {
    return lifecycle.queryOptions(workflowRunEndpoint, { params: { runId: id } }, [
        'workflows',
        props.workflowId,
        'run',
    ]);
}
const runQuery = useQuery(
    computed(() => {
        const options = runOptions(runId.value);
        return {
            ...options,
            enabled: options.enabled && !!runId.value,
            refetchOnReconnect: true,
            refetchInterval: (query: {
                state: { status: string; data?: ApiResponse<WorkflowRun> };
            }) => (query.state.data && workflowRunIsActive(query.state.data.data) ? 2_000 : false),
        };
    }),
    lifecycle.queryClient,
);
const run = computed(() => runQuery.data.value?.data);
const canCancel = computed(() => run.value?.status === 'queued' || run.value?.status === 'running');

function childStatusLabel(status: Run['status']) {
    const labels = { ...statusLabels, recovering: '恢复中', partial: '部分完成' };
    return labels[status];
}

function selectRun(id: string) {
    runId.value = id;
    void nextTick(() => runHeading.value?.focus());
}

watch(
    () => run.value?.status,
    (status, previous) => {
        if (previous && status && previous !== status)
            void lifecycle.queryClient.invalidateQueries({
                queryKey: lifecycle.capture().queryKey(historyKey),
            });
    },
);

async function start() {
    if (!selectedVersion.value || starting.isPending.value) return;
    const scope = lifecycle.capture();
    const body = { versionId: selectedVersion.value.id };
    const attempt = body.versionId;
    const key = startKeys.get(attempt) ?? crypto.randomUUID();
    startKeys.set(attempt, key);
    problem.value = '';
    actionResult.value = '';
    try {
        const { data } = await starting.mutateAsync({
            input: { params: { workflowId: props.workflowId }, body },
            options: { idempotencyKey: key, signal: lifetime.signal },
        });
        if (!scope.isCurrent() || lifetime.signal.aborted) return;
        startKeys.delete(attempt);
        selectRun(data.run.id);
        actionResult.value = data.reused ? '已找到此前请求启动的运行' : '已请求启动工作流';
        void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(historyKey) });
    } catch (error) {
        if (scope.isCurrent() && !lifetime.signal.aborted && shouldReportQueryError(error)) {
            const apiError = toApiError(error);
            if (apiError.status && apiError.status < 500 && !apiError.retryable)
                startKeys.delete(attempt);
            problem.value = apiError.message;
        }
    }
}

async function cancel() {
    if (!run.value || !canCancel.value || canceling.isPending.value) return;
    const scope = lifecycle.capture();
    const id = run.value.id;
    problem.value = '';
    actionResult.value = '';
    try {
        const result = await canceling.mutateAsync({
            input: { params: { runId: id } },
            options: { signal: lifetime.signal },
        });
        if (!scope.isCurrent() || lifetime.signal.aborted) return;
        const queryKey = runOptions(id).queryKey;
        await lifecycle.queryClient.cancelQueries({ queryKey, exact: true });
        if (!scope.isCurrent() || lifetime.signal.aborted) return;
        lifecycle.queryClient.setQueryData(queryKey, result);
        if (runId.value === id) actionResult.value = '已请求取消运行';
        void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(historyKey) });
    } catch (error) {
        if (scope.isCurrent() && !lifetime.signal.aborted && shouldReportQueryError(error))
            problem.value = toApiError(error).message;
    }
}
</script>

<style scoped>
.workflow-select {
    min-block-size: 2.75rem;
    inline-size: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.5rem;
    background: var(--scova-surface);
    color: inherit;
    font: inherit;
}

.workflow-select:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
}

.run-node {
    padding: 0.75rem;
    border: 1px solid var(--scova-border);
    border-radius: 0.5rem;
}
</style>
