<template>
    <div class="task-center">
        <template v-if="!taskId">
            <div class="task-toolbar">
                <task-filters :value="filter" @change="changeFilter" />
                <navigation-button class="back-link" icon="create" :to="{ name: 'task-create' }"
                    >新建任务</navigation-button
                >
            </div>
            <p class="scope-note">筛选已加载任务 · 时间按 {{ timezone }} 显示</p>
            <state-panel v-if="query.isPending.value" state="loading" />
            <state-panel
                v-else-if="query.isError.value && !query.data.value"
                state="error"
                message="任务读取失败"
                retryable
                @retry="query.refetch()"
            />
            <template v-else>
                <state-panel
                    v-if="!items.length"
                    state="empty"
                    :message="
                        query.hasNextPage.value
                            ? '已加载页无匹配任务，可继续加载'
                            : '没有匹配的任务'
                    "
                />
                <div class="task-list">
                    <task-card
                        v-for="task in items"
                        :key="task.id"
                        :task="task"
                        :filter="filter"
                        :timezone="timezone"
                    />
                </div>
                <state-panel
                    v-if="query.isFetchNextPageError.value"
                    state="error"
                    message="后续任务读取失败"
                    retryable
                    @retry="query.fetchNextPage()"
                />
                <state-panel
                    v-else-if="query.isRefetchError.value"
                    state="error"
                    message="任务刷新失败，当前显示上次读取的内容"
                    retryable
                    @retry="query.refetch()"
                />
                <div v-if="query.hasNextPage.value" class="scova-pagination">
                    <action-button
                        :busy="query.isFetchingNextPage.value"
                        @click="query.fetchNextPage()"
                        >{{
                            query.isFetchingNextPage.value ? '正在加载' : '加载更多'
                        }}</action-button
                    >
                </div>
            </template>
        </template>
        <template v-else>
            <navigation-button
                class="back-link"
                icon="back"
                :to="{ name: 'tasks', query: { status: filter } }"
                >返回任务</navigation-button
            >
            <state-panel v-if="detail.isPending.value" state="loading" />
            <state-panel
                v-else-if="detail.isError.value && (!detail.data.value || detailUnavailable)"
                state="error"
                message="任务不可用，请检查权限或稍后重试"
                retryable
                @retry="detail.refetch()"
            />
            <template v-else-if="detail.data.value">
                <state-panel
                    v-if="detail.isError.value"
                    state="error"
                    message="任务摘要刷新失败，当前显示上次读取的内容"
                    retryable
                    @retry="detail.refetch()"
                />
                <navigation-button
                    class="back-link"
                    icon="edit"
                    :to="{ name: 'task-edit', params: { taskId } }"
                    >编辑任务配置</navigation-button
                >
                <p class="scope-note">时间按 {{ timezone }} 显示</p>
                <p class="scope-note">
                    任务启用表示允许后续计划；本次是否正在运行请查看执行历史。手动任务完成后仍会保持启用。
                </p>
                <task-card
                    :task="detail.data.value.data.task"
                    :filter="filter"
                    :timezone="timezone"
                    :link="false"
                />
                <dl class="task-summary">
                    <dt>查阅主题</dt>
                    <dd>{{ detail.data.value.data.version.config.topic }}</dd>
                    <dt>目标</dt>
                    <dd>{{ detail.data.value.data.version.config.goal }}</dd>
                    <dt>任务计划时区</dt>
                    <dd>{{ detail.data.value.data.version.config.timezone }}</dd>
                </dl>
                <task-run-history :task-id="detail.data.value.data.task.id" />
                <run-actions
                    :task-id="detail.data.value.data.task.id"
                    :task-status="detail.data.value.data.task.status"
                    :output-format="detail.data.value.data.version.config.outputFormat"
                />
                <task-lifecycle-actions :task-id="detail.data.value.data.task.id" />
            </template>
        </template>
    </div>
</template>

<script setup lang="ts">
import NavigationButton from '@/components/common/NavigationButton.vue';
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import { taskEndpoint, taskKeys } from '@/api/tasks';
import { toApiError } from '@/api/errors';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { useTasks, readTaskFilter, type TaskFilter } from '@/composables/useTasks';
import TaskCard from '@/components/tasks/TaskCard.vue';
import TaskFilters from '@/components/tasks/TaskFilters.vue';
import TaskRunHistory from '@/components/tasks/TaskRunHistory.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import RunActions from '@/components/run/RunActions.vue';
import TaskLifecycleActions from '@/components/tasks/TaskLifecycleActions.vue';
const route = useRoute();
const router = useRouter();
const lifecycle = useSessionLifecycle();
const filter = computed(() => readTaskFilter(route.query.status));
const taskId = computed(() => (typeof route.params.taskId === 'string' ? route.params.taskId : ''));
const { query, items } = useTasks(filter, lifecycle, () => !taskId.value);
const detail = useQuery(
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
const detailUnavailable = computed(() => {
    const error = detail.error.value ? toApiError(detail.error.value) : undefined;
    return (
        [401, 403, 404].includes(error?.status ?? 0) ||
        error?.kind === 'validation' ||
        error?.kind === 'protocol'
    );
});
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function changeFilter(value: TaskFilter) {
    void router.push({ name: 'tasks', query: { status: value } });
}
</script>

<style scoped>
.task-center {
    display: grid;
    justify-items: stretch;
    gap: 1rem;
    min-inline-size: 0;
    cursor: default;
}
.scope-note {
    color: var(--scova-muted);
    margin: 0;
    font-size: 0.875rem;
}
.task-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1.5rem;
}
.task-list {
    display: grid;
    gap: 0;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
}
.task-center > :deep(.scova-action-button) {
    justify-self: start;
}
.back-link {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    justify-self: start;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
.back-link:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.task-summary {
    margin: 0;
    display: grid;
    gap: 0.75rem;
    overflow-wrap: anywhere;
}
.task-summary dt {
    color: var(--scova-muted);
}
.task-summary dd {
    margin: 0 0 1rem;
}
.task-center > :deep(.run-actions),
.task-center > :deep(.task-lifecycle) {
    padding-inline: 0;
    padding-block: 2rem 0;
    border-block-start: 0.0625rem solid var(--scova-border);
    border-radius: 0;
    background: transparent;
}
</style>
