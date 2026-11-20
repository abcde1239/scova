<template>
    <div class="layout-grid gap-6">
        <form class="layout-grid gap-2 max-w-[32rem]" method="post" @submit.prevent="create">
            <label for="workflow-create-title">新工作流名称</label>
            <div class="flex flex-wrap items-start gap-2">
                <input
                    id="workflow-create-title"
                    v-model="title"
                    class="min-w-0 flex-1 basis-44 min-h-11 px-3 py-2 rounded-2 bg-surface text-default border border-solid border-[var(--scova-border)] keyboard-focus-wide"
                    name="title"
                    required
                    maxlength="160"
                    pattern=".*\S.*"
                    :disabled="mutation.isPending.value"
                />
                <action-button type="primary" attr-type="submit" :busy="mutation.isPending.value">
                    创建工作流
                </action-button>
            </div>
            <p v-if="creationError" class="m-0" role="alert">{{ creationError }}</p>
        </form>

        <state-panel v-if="query.isPending.value" state="loading" message="正在读取工作流" />
        <state-panel
            v-else-if="query.isError.value && !items.length"
            state="error"
            :message="toApiError(query.error.value).message"
            retryable
            @retry="query.refetch()"
        />
        <state-panel v-else-if="!items.length" state="empty" message="暂无工作流" />
        <ul v-else class="layout-grid gap-2 list-none p-0 m-0">
            <li
                v-for="workflow in items"
                :key="workflow.id"
                class="surface-card p-4 break-anywhere"
            >
                <router-link
                    class="internal-link font-semibold"
                    :to="{ name: 'workflow-detail', params: { workflowId: workflow.id } }"
                    >{{ workflow.title }}</router-link
                >
            </li>
        </ul>
        <div v-if="query.hasNextPage.value">
            <action-button :busy="query.isFetchingNextPage.value" @click="query.fetchNextPage()">
                {{ query.isFetchNextPageError.value ? '重试加载' : '加载更多工作流' }}
            </action-button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { createWorkflowEndpoint, workflowsEndpoint } from '@/api/workflows';
import { toApiError } from '@/api/errors';
import { shouldReportQueryError } from '@/api/query';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';
import { useWorkflowPages } from '@/composable/useWorkflowPages';
import { serialGraph } from '@/utils/workflow/serial';

const lifecycle = useSessionLifecycle();
const router = useRouter();
const listKey = ['workflows', 'list'];
const title = ref('');
const creationError = ref('');
const { query, items } = useWorkflowPages(lifecycle, listKey, (scope, query, signal) =>
    scope.request(workflowsEndpoint, { query }, { signal }),
);
const mutation = useSessionMutation(createWorkflowEndpoint, lifecycle);

watch(
    () => lifecycle.session.epoch,
    () => {
        title.value = '';
        creationError.value = '';
        mutation.reset();
    },
);

async function create() {
    if (mutation.isPending.value || !title.value.trim()) return;
    const scope = lifecycle.capture();
    creationError.value = '';
    try {
        const { data } = await mutation.mutateAsync({
            input: {
                body: {
                    title: title.value.trim(),
                    graph: serialGraph({ id: 'start', type: 'start' }, [], {
                        id: 'end',
                        type: 'end',
                    }),
                },
            },
        });
        if (!scope.isCurrent()) return;
        title.value = '';
        void lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(listKey) });
        if (router.currentRoute.value.name === 'workflows')
            await router.push({
                name: 'workflow-detail',
                params: { workflowId: data.workflow.id },
            });
    } catch (error) {
        if (scope.isCurrent() && shouldReportQueryError(error))
            creationError.value = toApiError(error).message;
    }
}
</script>
