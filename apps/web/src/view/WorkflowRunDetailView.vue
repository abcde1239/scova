<template>
    <div class="layout-grid gap-4">
        <state-panel v-if="runQuery.isPending.value" state="loading" message="正在读取工作流运行" />
        <state-panel
            v-else-if="runQuery.isError.value"
            state="error"
            :message="toApiError(runQuery.error.value).message"
            retryable
            @retry="runQuery.refetch()"
        />
        <template v-if="run">
            <div class="surface-card p-4 layout-grid gap-3">
                <div class="flex flex-wrap items-center gap-3">
                    <h2 class="m-0">{{ version.data.value?.data.title ?? '工作流运行' }}</h2>
                    <span role="status"
                        >{{ statusLabels[run.status] }} ·
                        {{ run.preview ? '草稿试跑' : '正式运行' }}</span
                    >
                </div>
                <p v-if="run.failureCode" class="m-0" role="alert">{{ run.failureCode }}</p>
                <div class="flex flex-wrap items-center gap-3">
                    <router-link
                        class="internal-link"
                        :to="{ name: 'workflow-detail', params: { workflowId: run.workflowId } }"
                        >打开工作流</router-link
                    >
                    <action-button
                        v-if="run.status === 'queued' || run.status === 'running'"
                        :busy="canceling.isPending.value"
                        @click="cancel"
                        >取消运行</action-button
                    >
                </div>
                <p v-if="error" role="alert" class="m-0">{{ error }}</p>
            </div>
            <workflow-run-results :run="run" :graph="graph" :artifact-id="artifactId" />
            <details v-if="canvas" class="surface-card p-4 min-w-0">
                <summary class="font-semibold">查看本次运行的画布</summary>
                <workflow-canvas :graph="canvas" :tasks="[]" readonly />
            </details>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { isWorkflowCanvasGraph, type WorkflowRun } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import { toApiError } from '@/api/errors';
import {
    cancelWorkflowRunEndpoint,
    workflowRunEndpoint,
    workflowVersionEndpoint,
} from '@/api/workflows';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import WorkflowCanvas from '@/component/workflows/WorkflowCanvas.vue';
import WorkflowRunResults from '@/component/workflows/WorkflowRunResults.vue';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';
import { workflowRunIsActive, workflowStatusLabels as statusLabels } from '@/utils/workflow/serial';

const route = useRoute();
const runId = computed(() => String(route.params.runId));
const lifecycle = useSessionLifecycle();
const error = ref('');
const canceling = useSessionMutation(cancelWorkflowRunEndpoint, lifecycle);
const runQuery = useQuery(
    computed(() => ({
        ...lifecycle.queryOptions(workflowRunEndpoint, { params: { runId: runId.value } }, [
            'workflow-run',
        ]),
        refetchInterval: ({ state }: { state: { data?: ApiResponse<WorkflowRun> } }) =>
            state.data && workflowRunIsActive(state.data.data) ? 2000 : false,
    })),
    lifecycle.queryClient,
);
const run = computed(() => runQuery.data.value?.data);
const version = useQuery(
    computed(() => {
        const options = lifecycle.queryOptions(
            workflowVersionEndpoint,
            {
                params: {
                    workflowId: run.value?.workflowId ?? '',
                    versionId: run.value?.versionId ?? '',
                },
            },
            ['workflow-run-version'],
        );
        return { ...options, enabled: options.enabled && Boolean(run.value?.versionId) };
    }),
    lifecycle.queryClient,
);
const graph = computed(() => run.value?.draftSnapshot ?? version.data.value?.data.graph);
const canvas = computed(() =>
    graph.value && isWorkflowCanvasGraph(graph.value) ? graph.value : undefined,
);
const artifactId = computed(() =>
    typeof route.query.artifact === 'string' ? route.query.artifact : undefined,
);
const target = computed(
    () =>
        run.value?.nodes.find((node) => node.id === artifactId.value && node.output?.artifact)?.id,
);
watch(target, async (id) => {
    if (!id) return;
    await nextTick();
    document.getElementById(`workflow-artifact-${id}`)?.scrollIntoView({ block: 'center' });
});
watch(runId, () => {
    error.value = '';
});

async function cancel() {
    const scope = lifecycle.capture();
    const id = runId.value;
    error.value = '';
    try {
        await canceling.mutateAsync({ input: { params: { runId: id } } });
        if (scope.isCurrent() && id === runId.value) await runQuery.refetch();
    } catch (cause) {
        if (scope.isCurrent() && id === runId.value) error.value = toApiError(cause).message;
    }
}
</script>
