<template>
    <article class="task-card" :aria-labelledby="headingId">
        <h2 :id="headingId">
            <router-link
                v-if="link"
                :to="{
                    name: 'task-summary',
                    params: { taskId: task.id },
                    query: { status: filter },
                }"
                >{{ task.title }}</router-link
            >
            <template v-else>{{ task.title }}</template>
        </h2>
        <dl>
            <div>
                <dt>状态</dt>
                <dd>{{ labels[task.status] }}</dd>
            </div>
            <div v-if="!link">
                <dt>最近执行</dt>
                <dd>
                    <template v-if="runs.isPending.value">正在读取</template>
                    <template v-else-if="runs.isError.value"
                        >暂不可用
                        <button type="button" @click="runs.refetch()">重试</button></template
                    >
                    <template v-else-if="latest"
                        ><time :datetime="latest.queuedAt">{{
                            localTaskTime(latest.queuedAt, timezone)
                        }}</time>
                        · {{ runLabels[latest.status] }}</template
                    >
                    <template v-else>尚无执行</template>
                </dd>
            </div>
            <div>
                <dt>下次执行</dt>
                <dd>
                    <time v-if="task.nextRunAt" :datetime="task.nextRunAt">{{
                        localTaskTime(task.nextRunAt, timezone)
                    }}</time
                    ><template v-else>未安排</template>
                </dd>
            </div>
        </dl>
        <router-link
            v-if="link"
            class="task-history-link"
            :to="{ name: 'report-history', query: { taskId: task.id } }"
            >报告历史</router-link
        >
    </article>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { RouterLink } from 'vue-router';
import type { Task, RunStatus } from '@scova/models';
import { taskRunsEndpoint, taskKeys } from '@/api/tasks';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { localTaskTime, type TaskFilter } from '@/composables/useTasks';
const props = withDefaults(
    defineProps<{ task: Task; filter: TaskFilter; timezone: string; link?: boolean }>(),
    { link: true },
);
const headingId = useId();
const lifecycle = useSessionLifecycle();
const runs = useQuery(
    computed(() => ({
        ...lifecycle.queryOptions(
            taskRunsEndpoint,
            { params: { taskId: props.task.id }, query: { limit: 1 } },
            taskKeys.runs(props.task.id),
        ),
        enabled: !props.link && !!lifecycle.session.user,
    })),
    lifecycle.queryClient,
);
const latest = computed(() => runs.data.value?.data.items[0]);
const labels = { active: '进行中', paused: '暂停', archived: '归档' };
const runLabels: Record<RunStatus, string> = {
    queued: '排队中',
    running: '执行中',
    recovering: '恢复中',
    cancel_requested: '正在取消',
    canceled: '已取消',
    succeeded: '已完成',
    partial: '部分完成',
    failed: '失败',
};
</script>

<style scoped>
.task-card {
    padding-block: 1.75rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
    cursor: default;
}
h2 {
    margin: 0 0 1.25rem;
    font-size: 1.25rem;
    line-height: 1.5;
    font-weight: 600;
}
a {
    color: inherit;
    text-decoration: none;
    cursor: pointer;
}
a:hover {
    color: var(--scova-primary);
    text-decoration: underline;
    text-underline-offset: 0.2em;
}
.task-history-link {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    margin-block-start: 1rem;
    color: var(--scova-primary);
}
a:focus-visible,
button:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
dl {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 3rem;
    margin: 0;
}
dl div {
    display: grid;
    gap: 0.375rem;
    min-inline-size: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0;
}
button {
    min-block-size: 2.75rem;
    padding: 0.375rem 0.5rem;
    font: inherit;
    color: var(--scova-primary);
    background: transparent;
    border: 0;
    cursor: pointer;
}
</style>
