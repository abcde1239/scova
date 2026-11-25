<template>
    <section class="workbench-overview" aria-label="项目面板">
        <div class="overview-tabs" role="tablist" aria-label="项目面板" @keydown="moveTab">
            <button
                v-for="entry in tabs"
                :id="tabId(entry.id)"
                :key="entry.id"
                type="button"
                role="tab"
                :aria-selected="tab === entry.id"
                :aria-controls="panelId(entry.id)"
                :tabindex="tab === entry.id ? 0 : -1"
                @click="tab = entry.id"
            >
                {{ entry.label }}
            </button>
        </div>
        <div
            v-for="entry in tabs"
            :id="panelId(entry.id)"
            :key="entry.id"
            role="tabpanel"
            :hidden="tab !== entry.id"
            :aria-labelledby="tabId(entry.id)"
            tabindex="0"
        >
            <div v-if="tab === entry.id" class="overview-content">
                <template v-if="entry.id === 'overview'">
                    <section v-for="group in groups" :key="group.title" class="overview-group">
                        <div class="overview-group-heading">
                            <h3>{{ group.title }}</h3>
                            <button
                                v-if="group.title === '最新成果' && detail.recentReports.length > 3"
                                type="button"
                                class="internal-link"
                                @click="activateTab('results')"
                            >
                                查看成果
                            </button>
                        </div>
                        <p v-if="!group.rows.length" class="text-muted text-sm m-0">
                            {{ group.empty }}
                        </p>
                        <ul v-else class="overview-list">
                            <li v-for="row in group.rows" :key="row.id">
                                <router-link v-if="row.to" :to="row.to" class="internal-link">
                                    {{ row.title }}
                                </router-link>
                                <button
                                    v-else
                                    type="button"
                                    class="internal-link"
                                    @click="selectRow(row)"
                                >
                                    {{ row.title }}
                                </button>
                                <template v-if="row.status || row.at">
                                    <div class="overview-meta">
                                        <span v-if="row.status">{{ row.status }}</span>
                                        <time v-if="row.at" :datetime="row.at">
                                            {{ localTaskTime(row.at) }}
                                        </time>
                                    </div>
                                </template>
                            </li>
                        </ul>
                    </section>
                </template>
                <template v-else-if="entry.id === 'results'">
                    <h3 class="m-0">最近报告</h3>
                    <p v-if="!detail.recentReports.length" class="m-0 text-muted text-sm">
                        暂无报告
                    </p>
                    <ul v-else class="overview-list">
                        <li v-for="report in detail.recentReports" :key="report.id">
                            <router-link
                                class="internal-link"
                                :to="{ name: 'report-detail', params: { reportId: report.id } }"
                            >
                                {{ report.title }}
                            </router-link>
                            <div class="overview-meta">
                                <time :datetime="report.publishedAt">{{
                                    localTaskTime(report.publishedAt)
                                }}</time>
                                <button
                                    type="button"
                                    class="internal-link"
                                    @click="emit('open-report', report.id)"
                                >
                                    侧栏阅读<span class="sr-only">：{{ report.title }}</span>
                                </button>
                            </div>
                        </li>
                    </ul>
                </template>
                <template v-else-if="entry.id === 'tasks'">
                    <h3 class="m-0">项目任务</h3>
                    <router-link
                        :to="{
                            name: 'project-task-create',
                            params: { projectId: detail.project.id },
                        }"
                        class="internal-link"
                    >
                        新建项目任务
                    </router-link>
                    <p v-if="!detail.tasks.items.length" class="m-0 text-muted text-sm">暂无任务</p>
                    <ul v-else class="overview-list">
                        <li v-for="task in detail.tasks.items" :key="task.id">
                            <router-link :to="taskLocation(task.id)" class="internal-link">
                                {{ task.title }}
                            </router-link>
                            <span class="text-muted text-sm">{{ taskStatuses[task.status] }}</span>
                        </li>
                    </ul>
                </template>
                <slot v-else name="settings">
                    <h3 class="m-0">项目资料</h3>
                    <dl class="overview-settings m-0">
                        <dt>名称</dt>
                        <dd>{{ detail.project.name }}</dd>
                        <dt>创建时间</dt>
                        <dd>
                            <time :datetime="detail.project.createdAt">{{
                                localTaskTime(detail.project.createdAt)
                            }}</time>
                        </dd>
                    </dl>
                </slot>
            </div>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, useId } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { ProjectDetailResponse, ProjectThreadItem, TaskStatus } from '@scova/models';
import { notificationStatus } from '@/composable/useNotifications';
import { localTaskTime } from '@/composable/useTasks';

type Tab = 'overview' | 'results' | 'tasks' | 'settings';
type Row = {
    id: string;
    title: string;
    status?: string;
    at?: string;
} & ({ to: RouteLocationRaw; action?: never } | { to?: never; action: 'report' | 'item' });

const props = defineProps<{
    detail: ProjectDetailResponse;
    items?: readonly ProjectThreadItem[];
}>();
const emit = defineEmits<{
    'open-report': [reportId: string];
    'focus-item': [itemId: string];
}>();
const tab = defineModel<Tab>('tab', { default: 'overview' });
const id = useId();
const tabId = (key: Tab) => `${id}-tab-${key}`;
const panelId = (key: Tab) => `${id}-panel-${key}`;
const tabs = [
    { id: 'overview', label: '概览' },
    { id: 'results', label: '成果' },
    { id: 'tasks', label: '任务' },
    { id: 'settings', label: '设定' },
] as const;
const taskStatuses: Record<TaskStatus, string> = {
    active: '已启用',
    paused: '已暂停',
    archived: '已归档',
};
const activeStatuses = new Set(['queued', 'running', 'recovering', 'cancel_requested']);
const taskLocation = (taskId: string) => ({ name: 'task-summary', params: { taskId } });

async function activateTab(key: Tab) {
    tab.value = key;
    await nextTick();
    document.getElementById(tabId(key))?.focus();
}
function moveTab(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const current = tabs.findIndex((entry) => entry.id === tab.value);
    const index = {
        ArrowLeft: (current + tabs.length - 1) % tabs.length,
        ArrowRight: (current + 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
    }[event.key];
    if (typeof index !== 'number') return;
    event.preventDefault();
    void activateTab(tabs[index]!.id);
}
function selectRow(row: Row) {
    if (row.action === 'report') emit('open-report', row.id);
    if (row.action === 'item') emit('focus-item', row.id);
}

const groups = computed<{ title: string; empty: string; rows: Row[] }[]>(() => {
    const items = props.items ?? [];
    const resolved = new Set(
        items
            .filter((item) => item.status === 'applied' || item.status === 'rejected')
            .map((item) => item.payload.actionId),
    );
    const next = props.detail.nextRun;
    const upcoming = props.detail.tasks.items.flatMap((task) =>
        task.status === 'active' && task.nextRunAt && task.id !== next?.taskId
            ? [{ taskId: task.id, title: task.title, at: task.nextRunAt }]
            : [],
    );
    if (next) upcoming.push(next);
    upcoming.sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.taskId.localeCompare(b.taskId),
    );
    return [
        {
            title: '待处理',
            empty: '当前会话没有待处理事项',
            rows: items
                .filter(
                    (item) =>
                        ['plan', 'schedule', 'disambiguation'].includes(item.kind) &&
                        item.status === 'pending' &&
                        !resolved.has(item.id),
                )
                .slice(-3)
                .reverse()
                .map((item) => {
                    const config = item.payload.config;
                    const title =
                        config && typeof config === 'object' && 'title' in config
                            ? config.title
                            : item.payload.title;
                    return {
                        id: item.id,
                        title: typeof title === 'string' && title.trim() ? title : '查看待处理事项',
                        status: item.kind === 'disambiguation' ? '待选择' : '待确认',
                        action: 'item',
                    };
                }),
        },
        {
            title: '进行中',
            empty: '近期没有进行中的执行',
            rows: props.detail.recentRuns
                .filter((run) => activeStatuses.has(run.status))
                .slice(0, 3)
                .map((run) => ({
                    id: run.id,
                    title: run.title,
                    at: run.queuedAt,
                    status: notificationStatus[run.status],
                    to: { name: 'run-detail', params: { runId: run.id } },
                })),
        },
        {
            title: '最新成果',
            empty: '暂无报告',
            rows: props.detail.recentReports.slice(0, 3).map((report) => ({
                id: report.id,
                title: report.title,
                at: report.publishedAt,
                action: 'report',
            })),
        },
        {
            title: '下次运行',
            empty: '暂无计划运行',
            rows: upcoming.slice(0, 3).map((task) => ({
                id: task.taskId,
                title: task.title,
                at: task.at,
                to: taskLocation(task.taskId),
            })),
        },
    ];
});
</script>

<style scoped>
.workbench-overview {
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.overview-tabs {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-block-end: 1px solid var(--scova-border);
    padding-inline: 0.75rem;
}
.workbench-overview button {
    appearance: none;
    border: 0;
    padding: 0;
    background: transparent;
    font: inherit;
    cursor: pointer;
}
.overview-tabs button {
    min-block-size: 2.75rem;
    padding: 0.45rem 0.2rem;
    border-block-end: 2px solid transparent;
    color: var(--scova-muted);
}
.overview-tabs button[aria-selected='true'] {
    border-block-end-color: var(--scova-primary);
    color: var(--scova-primary);
    font-weight: 600;
}
.overview-content,
.overview-group,
.overview-list,
.overview-list li {
    display: grid;
    gap: 0.5rem;
    min-inline-size: 0;
}
.overview-content {
    gap: 1rem;
    padding: 1rem;
}
.overview-group:not(:last-child) {
    padding-block-end: 1rem;
    border-block-end: 1px solid var(--scova-border);
}
.overview-group-heading,
.overview-meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.25rem 0.75rem;
    align-items: baseline;
}
.overview-group-heading h3 {
    margin: 0;
    font-size: 0.875rem;
}
.overview-list {
    margin: 0;
    padding: 0;
    list-style: none;
}
.overview-list li {
    gap: 0.125rem;
    padding-block: 0.25rem;
}
.overview-list .internal-link,
.overview-content > .internal-link {
    justify-self: start;
    text-align: start;
}
.overview-meta {
    color: var(--scova-muted);
    font-size: 0.8125rem;
}
.overview-settings {
    display: grid;
    grid-template-columns: minmax(min-content, auto) minmax(0, 1fr);
    gap: 0.5rem 0.75rem;
}
.overview-settings dd {
    margin: 0;
}
.workbench-overview :is(button, a):focus-visible {
    outline: 2px solid var(--scova-primary);
    outline-offset: 2px;
}
[role='tabpanel']:focus-visible {
    outline: 2px solid var(--scova-primary);
    outline-offset: -3px;
}
</style>
