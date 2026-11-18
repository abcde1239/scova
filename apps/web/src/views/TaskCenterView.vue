<template>
    <div
        class="task-center layout-stack [justify-items:stretch] cursor-default [&.task-center_>_.scova-action-button]:justify-self-start [&.task-center_>_.run-actions]:(pt-8 pb-0 [border-top:0.0625rem_solid_var(--scova-border)] rounded-0 bg-transparent px-0) [&.task-center_>_.task-lifecycle]:(pt-8 pb-0 [border-top:0.0625rem_solid_var(--scova-border)] rounded-0 bg-transparent px-0)"
    >
        <template v-if="!taskId">
            <div
                class="task-toolbar flex flex-wrap items-center justify-between gap-[0.75rem_1.5rem] [@media(max-width:_47.999rem)]:(flex-col items-start)"
            >
                <task-filters :value="filter" @change="changeFilter" />
                <div
                    class="task-toolbar-actions flex flex-wrap items-center justify-start gap-2 min-w-0"
                >
                    <action-button
                        quaternary
                        :busy="query.isFetching.value"
                        @click="query.refetch()"
                    >
                        <app-icon name="retry" />刷新
                    </action-button>
                    <navigation-button icon="create" :to="{ name: 'task-create' }">
                        新建任务
                    </navigation-button>
                </div>
            </div>
            <p class="scope-note text-muted text-[0.875rem] m-0">
                筛选已加载任务 · 时间按 {{ timezone }} 显示
            </p>
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
                <task-bulk-list
                    :key="filter"
                    :tasks="items"
                    :filter="filter"
                    :timezone="timezone"
                    :unavailable="query.isError.value || query.isPending.value"
                />
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
                <p class="scope-note text-muted text-[0.875rem] leading-relaxed m-0">
                    时间按 {{ timezone }}
                    显示。任务启用表示允许后续计划，是否正在运行请查看执行历史；手动任务完成后仍保持启用。
                </p>
                <task-card
                    :task="detail.data.value.data.task"
                    :filter="filter"
                    :timezone="timezone"
                    :link="false"
                />
                <dl class="task-summary grid gap-3 break-anywhere m-0">
                    <dt class="[.task-summary_&:is(dt)]:text-muted">查阅主题</dt>
                    <dd class="[.task-summary_&:is(dd)]:(mt-0 mb-4 mx-0)">
                        {{ detail.data.value.data.version.config.topic }}
                    </dd>
                    <dt class="[.task-summary_&:is(dt)]:text-muted">目标</dt>
                    <dd class="[.task-summary_&:is(dd)]:(mt-0 mb-4 mx-0)">
                        {{ detail.data.value.data.version.config.goal }}
                    </dd>
                    <dt class="[.task-summary_&:is(dt)]:text-muted">任务计划时区</dt>
                    <dd class="[.task-summary_&:is(dd)]:(mt-0 mb-4 mx-0)">
                        {{ detail.data.value.data.version.config.timezone }}
                    </dd>
                </dl>
                <task-run-history :task-id="detail.data.value.data.task.id" />
                <run-actions
                    :task-id="detail.data.value.data.task.id"
                    :task-status="detail.data.value.data.task.status"
                />
                <task-lifecycle-actions :task-id="detail.data.value.data.task.id" />
            </template>
        </template>
    </div>
</template>

<script setup lang="ts">
import NavigationButton from '@/components/common/NavigationButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import { taskEndpoint, taskKeys } from '@/api/tasks';
import { toApiError } from '@/api/errors';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { useTasks, readTaskFilter, type TaskFilter } from '@/composables/useTasks';
import TaskCard from '@/components/tasks/TaskCard.vue';
import TaskBulkList from '@/components/tasks/TaskBulkList.vue';
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
