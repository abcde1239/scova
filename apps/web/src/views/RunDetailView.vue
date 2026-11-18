<template>
    <state-panel v-if="!execution.id.value" state="error" message="执行地址无效，请检查链接" />
    <execution-detail v-else-if="execution.run.value" :execution="execution" />
    <state-panel
        v-else
        :state="execution.query.isError.value ? 'error' : 'loading'"
        :message="failure"
        :retryable="execution.query.isError.value"
        @retry="retry"
    />
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onScopeDispose, watch, watchEffect } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { breadcrumbContext } from '@/layout/breadcrumbs';
import { taskEndpoint, taskKeys } from '@/api/tasks';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { useRoute, useRouter } from 'vue-router';
import StatePanel from '@/components/common/StatePanel.vue';
import ExecutionDetail from '@/components/run/ExecutionDetail.vue';
import { useExecution } from '@/composables/useExecution';
import { useSearchApiSuggestion } from '@/composables/useSearchApiSuggestion';
const route = useRoute();
const router = useRouter();
const searchSuggestion = useSearchApiSuggestion();
const execution = useExecution(() => String(route.params.runId ?? ''), {
    onEvent: searchSuggestion.onEvent,
    onReset: searchSuggestion.reset,
});
const lifecycle = useSessionLifecycle();
const context = inject(breadcrumbContext, undefined);
const taskId = computed(() => execution.run.value?.taskId ?? '');
const task = useQuery(
    computed(() => ({
        ...lifecycle.queryOptions(
            taskEndpoint,
            { params: { taskId: taskId.value } },
            taskKeys.detail(taskId.value),
        ),
        enabled: !!taskId.value && !!lifecycle.session.user,
    })),
    lifecycle.queryClient,
);
watchEffect(() => {
    if (!context) return;
    const detail = !task.isError.value ? task.data.value?.data : undefined;
    context.value = taskId.value
        ? {
              path: route.fullPath,
              to: `/tasks/${taskId.value}`,
              label: detail?.task.id === taskId.value ? detail.version.config.title : '任务摘要',
          }
        : undefined;
});
onScopeDispose(() => {
    if (context) context.value = undefined;
});
let watchedRun: string | undefined;
// Only follow an execution observed in progress. Opening its history remains an explicit detail view.
watch(
    () => [execution.run.value, execution.reportId.value] as const,
    ([run, reportId]) => {
        if (!run || route.params.runId !== run.id) {
            watchedRun = undefined;
            return;
        }
        if (['queued', 'running', 'recovering', 'cancel_requested'].includes(run.status))
            watchedRun = run.id;
        if (watchedRun === run.id && reportId && ['succeeded', 'partial'].includes(run.status)) {
            watchedRun = undefined;
            void router.replace(`/reports/${reportId}`);
        }
    },
    { immediate: true },
);
async function retry() {
    const path = route.fullPath;
    await execution.query.refetch();
    await nextTick();
    if (route.fullPath === path && execution.run.value)
        document.getElementById('execution-status')?.focus();
}
const failure = computed(() => {
    const error = execution.query.error.value;
    if (!error) return '正在读取执行快照';
    if ('status' in error && error.status === 404) return '执行不存在或无权访问';
    if ('status' in error && error.status === 403) return '无权查看此执行';
    return '暂时无法读取执行，请检查连接后重试';
});
</script>
