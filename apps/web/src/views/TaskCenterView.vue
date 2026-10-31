<template>
    <div class="task-center">
        <template v-if="!taskId">
            <router-link class="back-link" :to="{ name: 'task-create' }">新建任务</router-link>
            <task-filters :value="filter" @change="changeFilter" />
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
                <action-button
                    v-if="query.hasNextPage.value"
                    :busy="query.isFetchingNextPage.value"
                    @click="query.fetchNextPage()"
                    >{{ query.isFetchingNextPage.value ? '正在加载' : '加载更多' }}</action-button
                >
            </template>
        </template>
        <template v-else>
            <router-link class="back-link" :to="{ name: 'tasks', query: { status: filter } }"
                >返回任务</router-link
            >
            <state-panel v-if="detail.isPending.value" state="loading" />
            <state-panel
                v-else-if="detail.isError.value"
                state="error"
                message="任务不可用，请检查权限或稍后重试"
                retryable
                @retry="detail.refetch()"
            />
            <template v-else-if="detail.data.value">
                <router-link class="back-link" :to="{ name: 'task-edit', params: { taskId } }"
                    >编辑任务配置</router-link
                >
                <p class="scope-note">时间按 {{ timezone }} 显示</p>
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
            </template>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { taskEndpoint, taskKeys } from '@/api/tasks';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { useTasks, readTaskFilter, type TaskFilter } from '@/composables/useTasks';
import TaskCard from '@/components/tasks/TaskCard.vue';
import TaskFilters from '@/components/tasks/TaskFilters.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import ActionButton from '@/components/common/ActionButton.vue';
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
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function changeFilter(value: TaskFilter) {
    void router.push({ name: 'tasks', query: { status: value } });
}
</script>

<style scoped>
.task-center {
    display: grid;
    justify-items: stretch;
    gap: 1.5rem;
    min-inline-size: 0;
    cursor: default;
}
.scope-note {
    color: var(--scova-muted);
}
.task-list {
    display: grid;
    gap: 0.5rem;
}
.task-list :deep(.task-card + .task-card) {
    border-block-start: 0.0625rem solid var(--scova-border);
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
</style>
