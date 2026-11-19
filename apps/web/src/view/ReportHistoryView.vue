<template>
    <section ref="container" class="report-history layout-grid gap-6" aria-label="历史报告列表">
        <div class="history-tools flex flex-wrap gap-[1rem_2rem] items-end">
            <label class="layout-grid gap-2 max-w-full"
                >筛选任务
                <select
                    class="[appearance:auto] min-w-0 max-w-full min-h-11 [font-family:inherit] [font-size:inherit] [font-weight:inherit] [font-style:inherit] leading-[1.5] [font-variant:inherit] text-default bg-surface border-theme rounded-2 cursor-pointer py-2 px-4 keyboard-focus-wide"
                    :value="taskId === null ? 'invalid' : (taskId ?? '')"
                    @change="changeFilter"
                >
                    <option v-if="taskId === null" value="invalid" disabled>
                        任务地址无效，请重新选择
                    </option>
                    <option value="">全部任务</option>
                    <option
                        v-if="taskId && !taskOptions.some((task) => task.id === taskId)"
                        :value="taskId"
                    >
                        当前筛选任务
                    </option>
                    <option v-for="task in taskOptions" :key="task.id" :value="task.id">
                        {{ task.title }}
                    </option>
                </select>
            </label>
            <action-button
                :busy="query.isRefetching.value && !query.isFetchingNextPage.value"
                :disabled="!valid || query.isFetchingNextPage.value"
                @click="refresh"
                ><app-icon name="retry" />刷新报告</action-button
            >
        </div>
        <div
            class="task-options-status flex flex-wrap gap-4 items-center [&.task-options-status:empty]:hidden"
        >
            <p class="break-anywhere m-0" v-if="tasks.query.isPending.value" role="status">
                正在读取任务选项，报告历史独立加载。
            </p>
            <template v-else-if="tasks.query.isError.value">
                <p class="break-anywhere m-0" role="status">
                    任务选项暂时无法读取；当前合法任务筛选仍可读取报告历史。
                </p>
                <action-button :busy="tasks.query.isFetching.value" @click="retryTasks"
                    >重试任务选项</action-button
                >
            </template>
            <div
                v-if="tasks.query.hasNextPage.value && !taskOptionsHidden"
                class="scova-pagination"
            >
                <action-button :busy="tasks.query.isFetchingNextPage.value" @click="moreTasks"
                    >加载更多任务选项</action-button
                >
            </div>
        </div>
        <state-panel v-if="!valid" state="error" :message="error.message" />
        <state-panel v-else-if="query.isPending.value" state="loading" message="正在读取报告历史" />
        <state-panel
            v-else-if="query.isError.value"
            state="error"
            :message="`${items.length ? '已保留上次读取的报告。' : ''}${error.message}`"
            retryable
            @retry="retry"
        />
        <state-panel v-else-if="!items.length" state="empty" icon="report" message="暂无报告" />
        <div v-if="items.length" class="history-list min-w-0">
            <report-history-entry
                v-for="item in items"
                :key="item.id"
                :item="item"
                @open="openReport"
            />
        </div>
        <div
            v-if="items.length && query.hasNextPage.value && !error.hidden"
            class="history-pagination scova-pagination"
        >
            <action-button
                :busy="query.isFetchingNextPage.value"
                :disabled="query.isRefetching.value && !query.isFetchingNextPage.value"
                @click="more"
                >{{
                    query.isFetchNextPageError.value ? '重试加载更多报告' : '加载更多报告'
                }}</action-button
            >
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import ReportHistoryEntry from '@/component/reports/ReportHistoryEntry.vue';
import {
    reportHistoryError,
    reportHistoryPath,
    reportHistoryPosition,
    reportHistoryTask,
    useReportHistory,
} from '@/composable/useReportHistory';
import { useTasks } from '@/composable/useTasks';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
const route = useRoute();
const router = useRouter();
const lifecycle = useSessionLifecycle();
const taskId = computed(() => reportHistoryTask(route.query.taskId));
const { query, items, error, valid, prepareFilter } = useReportHistory(taskId, lifecycle);
const tasks = useTasks('all', lifecycle);
const taskOptionsHidden = computed(
    () => tasks.query.isError.value && reportHistoryError(tasks.query.error.value).hidden,
);
const taskOptions = computed(() => (taskOptionsHidden.value ? [] : tasks.items.value));
const container = ref<HTMLElement>();
let filterRevision = 0;
function focusReport(id?: string) {
    if (id) document.getElementById(`history-report-${id}`)?.focus({ preventScroll: true });
    else container.value?.querySelector('select')?.focus({ preventScroll: true });
}
async function changeFilter(event: Event) {
    const target = event.target as HTMLSelectElement;
    const next = reportHistoryTask(target.value);
    if (next === null || next === taskId.value) return;
    const revision = ++filterRevision;
    if (
        !(await prepareFilter(next)) ||
        revision !== filterRevision ||
        route.name !== 'report-history'
    )
        return;
    await router.replace({ name: 'report-history', query: next ? { taskId: next } : {} });
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (
        revision === filterRevision &&
        route.name === 'report-history' &&
        target.isConnected &&
        document.activeElement === document.getElementById('main-content')
    )
        target.focus({ preventScroll: true });
}
async function refresh() {
    if (!valid.value) return;
    const focused = container.value?.contains(document.activeElement);
    await query.refetch();
    await nextTick();
    if (focused && document.activeElement === document.body) focusReport(items.value[0]?.id);
}
async function more() {
    const focused = container.value?.contains(document.activeElement);
    const previous = new Set(items.value.map((item) => item.id));
    await query.fetchNextPage();
    await nextTick();
    if (focused && document.activeElement === document.body)
        focusReport(
            items.value.find((item) => !previous.has(item.id))?.id ?? items.value.at(-1)?.id,
        );
}
async function retry() {
    if (query.isFetchNextPageError.value && !error.value.restart) await more();
    else await refresh();
}
async function moreTasks() {
    const focused = container.value?.contains(document.activeElement);
    await tasks.query.fetchNextPage();
    await nextTick();
    if (focused && document.activeElement === document.body) focusReport();
}
async function retryTasks() {
    if (
        tasks.query.isFetchNextPageError.value &&
        !reportHistoryError(tasks.query.error.value).restart
    )
        await moreTasks();
    else await tasks.query.refetch();
}
function openReport(reportId: string, event: MouseEvent) {
    if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        taskId.value === null
    )
        return;
    // Preserve Vue Router state; only client position goes into browser history.
    window.history.replaceState(
        {
            ...window.history.state,
            reportHistoryRestore: {
                path: reportHistoryPath(taskId.value),
                accountId: lifecycle.session.user?.id ?? '',
                scroll: window.scrollY,
                focusId: reportId,
            },
        },
        '',
    );
}
onMounted(async () => {
    const position = reportHistoryPosition(
        window.history.state?.reportHistoryRestore,
        lifecycle.session.user?.id,
    );
    if (!position || taskId.value === null || position.path !== reportHistoryPath(taskId.value))
        return;
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (
        route.name !== 'report-history' ||
        taskId.value === null ||
        position.path !== reportHistoryPath(taskId.value) ||
        position.accountId !== lifecycle.session.user?.id
    )
        return;
    focusReport(position.focusId);
    window.scrollTo({ top: position.scroll });
});
</script>
