<template>
    <article
        class="task-card [border-top:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)] min-w-0 break-anywhere cursor-default py-4 px-0 [&.task-row]:(grid grid-cols-[minmax(0,_1fr)_minmax(15rem,_0.6fr)_auto] gap-[0.75rem_1.5rem] items-center) [@media(max-width:_53.999rem)]:[&.task-row]:grid-cols-[minmax(0,_1fr)_auto] [@media(max-width:_29.999rem)]:[&.task-row]:grid-cols-[minmax(0,_1fr)]"
        :class="{ 'task-row': link }"
        :aria-labelledby="headingId"
    >
        <h2
            class="[.task-row_&:is(h2)]:(text-[1.125rem] m-0) [@media(max-width:_53.999rem)]:[.task-row_&:is(h2)]:col-span-full mt-0 mb-3 text-[1.25rem] leading-[1.5] font-semibold mx-0"
            :id="headingId"
        >
            <router-link
                class="title-link cursor-pointer keyboard-focus-wide"
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
        <dl
            class="[.task-row_&:is(dl)]:(grid grid-cols-[minmax(4rem,_0.6fr)_minmax(0,_1fr)] gap-3 text-[0.875rem]) flex flex-wrap gap-[1rem_3rem] m-0"
        >
            <div class="[dl_&:is(div)]:(grid gap-1.5 min-w-0)">
                <dt class="text-muted">状态</dt>
                <dd class="m-0">{{ labels[task.status] }}</dd>
            </div>
            <div class="[dl_&:is(div)]:(grid gap-1.5 min-w-0)" v-if="!link">
                <dt class="text-muted">最近执行</dt>
                <dd class="m-0">
                    <template v-if="runs.isPending.value">正在读取</template>
                    <template v-else-if="runs.isError.value"
                        >暂不可用
                        <button
                            class="keyboard-focus-wide min-h-11 font-inherit text-primary bg-transparent [border:0] cursor-pointer py-1.5 px-2"
                            type="button"
                            @click="runs.refetch()"
                        >
                            重试
                        </button></template
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
            <div class="[dl_&:is(div)]:(grid gap-1.5 min-w-0)">
                <dt class="text-muted">下次执行</dt>
                <dd class="m-0">
                    <time v-if="task.nextRunAt" :datetime="task.nextRunAt">{{
                        localTaskTime(task.nextRunAt, timezone)
                    }}</time
                    ><template v-else>未安排</template>
                </dd>
            </div>
        </dl>
        <navigation-button
            v-if="link"
            class="task-history-link scova-link cursor-pointer keyboard-focus-wide [.task-row_&.task-history-link]:m-0 [@media(max-width:_29.999rem)]:[.task-row_&.task-history-link]:justify-self-start [&&]:(inline-flex items-center min-h-11 max-w-full mt-4)"
            icon="report"
            :to="{ name: 'report-history', query: { taskId: task.id } }"
            >报告历史</navigation-button
        >
    </article>
</template>

<script setup lang="ts">
import NavigationButton from '@/components/common/NavigationButton.vue';
import { useId } from 'vue';
import { RouterLink } from 'vue-router';
import type { Task, RunStatus } from '@scova/models';
import { useLatestTaskRun } from '@/composables/useLatestTaskRun';
import { localTaskTime, type TaskFilter } from '@/composables/useTasks';
const props = withDefaults(
    defineProps<{ task: Task; filter: TaskFilter; timezone: string; link?: boolean }>(),
    { link: true },
);
const headingId = useId();
const { query: runs, latest } = useLatestTaskRun(
    () => props.task.id,
    () => !props.link,
);
const labels = { active: '已启用', paused: '暂停', archived: '归档' };
const runLabels: Record<RunStatus, string> = {
    queued: '排队中',
    running: '执行中',
    recovering: '恢复中',
    cancel_requested: '正在取消',
    canceled: '已取消',
    succeeded: '已完成',
    partial: '已生成结果',
    failed: '失败',
};
</script>
