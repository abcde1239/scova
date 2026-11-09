<template>
    <div ref="detail" class="report-detail">
        <header class="workspace-heading scova-interface">
            <div>
                <p class="workspace-eyebrow">信息搜索 · 报告工作区</p>
                <p class="workspace-description">阅读报告、核对来源，围绕已有资料继续提问。</p>
            </div>
            <nav class="report-tools" aria-label="报告阅读工具">
                <navigation-button
                    v-if="returnTo"
                    :to="{ path: returnTo.path, state: { inboxRestore: { ...returnTo } } }"
                >
                    <app-icon name="back" />返回收件箱
                </navigation-button>
                <navigation-button to="/account/appearance" icon="appearance" label="阅读外观"
                    >外观</navigation-button
                >
                <navigation-button v-if="report" :to="`/runs/${report.runId}`" icon="tasks"
                    >执行详情</navigation-button
                >
            </nav>
        </header>
        <nav
            v-if="questionIdentity"
            class="workspace-actions scova-interface"
            aria-label="工作区视图"
        >
            <n-button
                v-bind="{ 'aria-pressed': readingOnly, 'aria-controls': 'report-conversation' }"
                @click="readingOnly = !readingOnly"
            >
                <app-icon name="report" />{{ readingOnly ? '显示对话' : '专注阅读' }}
            </n-button>
            <n-button @click="openConversation"><app-icon name="question" />围绕报告提问</n-button>
            <p>原运行日志保留在执行详情中。</p>
        </nav>
        <div
            class="report-workspace"
            :class="{ 'report-workspace--reading': readingOnly || !questionIdentity }"
        >
            <section class="report-content" aria-label="报告交付物">
                <div class="deliverable-heading scova-interface">
                    <h2><app-icon name="report" />报告交付物</h2>
                    <span v-if="report">已保存 · {{ formatLabels[report.format] }}</span>
                </div>
                <div class="report-presentation scova-interface">
                    <template v-if="report">
                        <label for="report-format">报告形式</label>
                        <select
                            id="report-format"
                            v-model="selectedFormat"
                            aria-describedby="report-format-help"
                        >
                            <option value="brief">简报</option>
                            <option value="list">主题清单</option>
                            <option value="comparison">对比表</option>
                            <option value="research_report">研究报告</option>
                        </select>
                        <p id="report-format-help">临时切换，刷新恢复保存形式。</p>
                        <nav class="report-sections" aria-label="报告内容导航">
                            <n-button
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: '#summary-title' }"
                                @click="jump($event, 'summary-title')"
                                ><app-icon name="report" />正文</n-button
                            >
                            <n-button
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: `#${changesTarget}` }"
                                @click="jump($event, changesTarget)"
                                ><app-icon name="retry" />变化</n-button
                            >
                            <n-button
                                tag="a"
                                quaternary
                                type="primary"
                                v-bind="{ href: '#saved-evidence-title' }"
                                @click="jump($event, 'saved-evidence-title')"
                                ><app-icon name="source" />来源</n-button
                            >
                        </nav>
                    </template>
                </div>
                <component
                    :is="renderer"
                    v-if="report"
                    :key="`${routeIdentity}-${selectedFormat}`"
                    :report="report"
                    :show-changes="false"
                />
                <state-panel
                    v-if="!report"
                    :state="valid && query.isPending.value ? 'loading' : 'error'"
                    :message="valid && query.isPending.value ? '正在读取报告与引用' : error.message"
                    :retryable="error.retryable && valid && query.isError.value"
                    @retry="retry"
                />
            </section>
            <div v-show="!readingOnly && !!questionIdentity" class="report-sidebar">
                <section
                    id="report-conversation"
                    class="report-companion"
                    aria-labelledby="report-next-title"
                    tabindex="-1"
                >
                    <header class="companion-heading scova-interface">
                        <h2 id="report-next-title"><app-icon name="question" />对话与后续研究</h2>
                        <p>基于这份报告的保存证据作答。补充搜索需单独确认后续研究。</p>
                    </header>
                    <report-questions
                        v-if="questionIdentity"
                        :key="questionIdentity"
                        :report-id="String(route.params.reportId)"
                        :report="report"
                    />
                    <feedback-effects
                        v-if="report"
                        :key="`effects-${accountId}-${report.id}`"
                        :report="report"
                    />
                    <tool-section
                        v-if="report"
                        label="调整后续研究"
                        icon="settings"
                        class="feedback-tool"
                    >
                        <feedback-actions
                            v-if="report"
                            :key="`feedback-${accountId}-${report.id}`"
                            :report="report"
                        />
                    </tool-section>
                    <tool-section
                        v-if="notesSession === notesIdentity"
                        label="笔记"
                        icon="edit"
                        class="notes-tool"
                    >
                        <notes-panel
                            v-if="notesSession === notesIdentity"
                            :key="`notes-${notesIdentity}`"
                            :targets="noteTargets"
                            :initial-target="{ kind: 'report', id: String(route.params.reportId) }"
                            :available="!!report"
                        />
                    </tool-section>
                    <tool-section
                        v-if="report"
                        label="收藏与来源"
                        icon="bookmark"
                        class="bookmarks-tool"
                    >
                        <section
                            v-if="report"
                            class="report-bookmarks scova-interface"
                            aria-labelledby="report-bookmark-title"
                        >
                            <h2 id="report-bookmark-title">
                                <app-icon name="bookmark" />收藏报告来源
                            </h2>
                            <label for="bookmark-source">选择收藏来源</label>
                            <select
                                id="bookmark-source"
                                v-model="selectedSource"
                                :disabled="bookmarkBusy"
                            >
                                <option value="">请选择一份资料</option>
                                <option
                                    v-for="source in sources"
                                    :key="source.id"
                                    :value="source.id"
                                >
                                    {{ source.title }}
                                </option>
                            </select>
                            <p v-if="chosenSource">{{ chosenSource.title }}</p>
                            <nav
                                v-if="chosenSource"
                                class="report-source-history"
                                aria-label="所选来源历史与快照"
                            >
                                <navigation-button
                                    :to="sourceHistoryLink(chosenSource.id)"
                                    icon="library"
                                    >查看来源历史</navigation-button
                                >
                                <navigation-button
                                    v-for="evidence in chosenSnapshots"
                                    :key="evidence.snapshotId"
                                    :to="sourceHistoryLink(evidence.sourceId, evidence.snapshotId)"
                                    >查看保存快照（{{ evidence.observedAt }}）</navigation-button
                                >
                            </nav>
                            <bookmark-action
                                v-if="chosenSource"
                                :key="`${accountId}-${report.id}-${chosenSource.id}`"
                                :source-id="chosenSource.id"
                                :report-id="report.id"
                            />
                        </section>
                    </tool-section>
                </section>
                <section v-if="report" class="report-baseline" aria-label="历史变化与比较基线">
                    <report-changes :report="report" />
                </section>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRaw, watch } from 'vue';
import { useRoute } from 'vue-router';
import { NButton } from 'naive-ui';
import NavigationButton from '@/components/common/NavigationButton.vue';
import ToolSection from '@/components/common/ToolSection.vue';
import type { Report } from '@scova/models';
import AppIcon from '@/components/common/AppIcon.vue';
import ReportBrief from '@/components/reports/ReportBrief.vue';
import TopicListReport from '@/components/reports/TopicListReport.vue';
import ComparisonReport from '@/components/reports/ComparisonReport.vue';
import ResearchReport from '@/components/reports/ResearchReport.vue';
import FeedbackActions from '@/components/reports/FeedbackActions.vue';
import FeedbackEffects from '@/components/reports/FeedbackEffects.vue';
import BookmarkAction from '@/components/library/BookmarkAction.vue';
import NotesPanel from '@/components/library/NotesPanel.vue';
import ReportQuestions from '@/components/reports/ReportQuestions.vue';
import ReportChanges from '@/components/reports/ReportChanges.vue';
import {
    bookmarkOrigin,
    bookmarksPending,
    reportBookmarkSources,
} from '@/composables/useBookmarks';
import StatePanel from '@/components/common/StatePanel.vue';
import { useReport } from '@/composables/useReport';
import { reportEndpoint } from '@/api/reports';
import { inboxReturn } from '@/composables/useInbox';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
const route = useRoute();
const lifecycle = useSessionLifecycle();
const accountId = computed(() => lifecycle.session.user?.id);
const returnTo = computed(() => {
    void route.fullPath;
    return inboxReturn(window.history.state?.inboxReturn, accountId.value);
});
const {
    query,
    report: queryReport,
    valid,
    error,
} = useReport(() => route.params.reportId, lifecycle);
const report = computed(() => {
    const value = queryReport.value;
    const reportId = route.params.reportId;
    if (!value || !valid.value || value.id !== reportId) return undefined;
    const current = lifecycle.queryClient.getQueryData(
        lifecycle.queryOptions(reportEndpoint, { params: { reportId } }, ['reports', reportId])
            .queryKey,
    );
    // Vue Query updates its observer in a pre-flush watcher. A synchronous identity change
    // must not initialize a new reading selection or editor from the old observer's result.
    return toRaw(current) === toRaw(query.data.value) ? value : undefined;
});
const notesIdentity = computed(
    () => `${lifecycle.session.epoch}:${accountId.value}:${route.params.reportId}`,
);
const notesSession = ref('');
watch(
    () => report.value,
    (value) => {
        if (value && lifecycle.session.user && valid.value)
            notesSession.value = notesIdentity.value;
    },
    { immediate: true, flush: 'sync' },
);
const selectedSource = ref('');
const bookmarkBusy = computed(() => bookmarksPending(lifecycle));
const sources = computed(() => (report.value ? reportBookmarkSources(report.value) : []));
const noteTargets = computed(() =>
    report.value
        ? [
              {
                  kind: 'report' as const,
                  id: report.value.id,
                  label: `本报告：${report.value.title}`,
              },
              ...sources.value.map((source) => ({
                  kind: 'source' as const,
                  id: source.id,
                  label: source.title,
              })),
          ]
        : [],
);
const chosenSource = computed(() =>
    sources.value.find((source) => source.id === selectedSource.value),
);
const chosenSnapshots = computed(() => [
    ...new Map(
        (report.value?.evidence ?? [])
            .filter((entry) => entry.sourceId.toLowerCase() === chosenSource.value?.id)
            .map((entry) => [entry.snapshotId.toLowerCase(), entry]),
    ).values(),
]);
function sourceHistoryLink(sourceId: string, snapshotId?: string) {
    return {
        path: `/library/sources/${sourceId}/snapshots${snapshotId ? `/${snapshotId}` : ''}`,
        ...(report.value
            ? { state: { bookmarkOrigin: bookmarkOrigin(lifecycle, report.value.id, sourceId) } }
            : {}),
    };
}
watch(
    () => `${accountId.value}-${report.value?.id}`,
    () => {
        selectedSource.value = '';
    },
);
// Keep only the editor identity, never a second Report cache, across same-owner read failures.
const questionIdentity = ref('');
const routeIdentity = computed(
    () => `${lifecycle.session.epoch}:${accountId.value ?? ''}:${route.params.reportId}`,
);
const selectedFormat = ref<Report['format']>();
const readingOnly = ref(false);
const formatLabels = {
    brief: '简报',
    list: '主题清单',
    comparison: '对比表',
    research_report: '研究报告',
};
let formatIdentity = '';
watch(
    [routeIdentity, report],
    ([identity, value]) => {
        if (formatIdentity !== identity) {
            formatIdentity = identity;
            selectedFormat.value = undefined;
        }
        if (value && selectedFormat.value === undefined) selectedFormat.value = value.format;
    },
    { immediate: true, flush: 'sync' },
);
const renderers = {
    brief: ReportBrief,
    list: TopicListReport,
    comparison: ComparisonReport,
    research_report: ResearchReport,
};
const renderer = computed(() => renderers[selectedFormat.value ?? 'brief']);
const changesTarget = 'report-changes-title';
watch(
    routeIdentity,
    () => {
        questionIdentity.value = '';
        readingOnly.value = false;
    },
    { flush: 'sync' },
);
watch(
    report,
    (value) => {
        if (value) questionIdentity.value = routeIdentity.value;
    },
    { immediate: true, flush: 'sync' },
);
const detail = ref<HTMLElement>();
async function openConversation() {
    readingOnly.value = false;
    await nextTick();
    const target = detail.value?.querySelector<HTMLElement>('#report-conversation');
    const input = target?.querySelector<HTMLTextAreaElement>('textarea:not([readonly])');
    (input ?? target)?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
}
async function jump(event: MouseEvent, id: string) {
    event.preventDefault();
    if (id === changesTarget) {
        readingOnly.value = false;
        await nextTick();
    }
    const target = detail.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    target.tabIndex = -1;
    target.style.scrollMarginBlockStart = '6rem';
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
}
async function retry() {
    const restoreFocus = detail.value?.contains(document.activeElement);
    await query.refetch();
    if (restoreFocus && report.value) {
        await nextTick();
        detail.value?.querySelector<HTMLElement>('#report-title')?.focus();
    }
}
</script>

<style scoped>
.report-detail {
    display: grid;
    gap: 0.875rem;
    min-inline-size: 0;
}
.workspace-heading,
.workspace-actions,
.deliverable-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1rem;
    min-inline-size: 0;
}
.workspace-heading {
    justify-content: space-between;
}
.workspace-heading > div,
.workspace-actions > * {
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.workspace-eyebrow {
    margin: 0;
    font-weight: 600;
}
.workspace-description,
.workspace-actions p,
.companion-heading p,
.deliverable-heading span {
    margin: 0;
    color: var(--scova-muted);
    font-size: 0.875rem;
    line-height: 1.6;
}
.workspace-description {
    margin-block-start: 0.375rem;
}
.workspace-actions :deep(.n-button__content) {
    gap: 0.5rem;
    white-space: normal;
}
.workspace-actions :deep(.n-button) {
    min-block-size: 2.75rem;
    height: auto;
    padding-block: 0.625rem;
}
.workspace-actions :deep([aria-pressed='true']) {
    color: var(--scova-primary);
    background: var(--scova-selected);
}
.deliverable-heading {
    justify-content: space-between;
    padding-block-end: 1rem;
    border-block-end: 0.0625rem solid var(--scova-border);
}
.deliverable-heading h2,
.companion-heading h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
}
.companion-heading {
    display: grid;
    gap: 0.5rem;
    padding-block-end: 1.5rem;
    border-block-end: 0.0625rem solid var(--scova-border);
    margin-block-end: 1rem;
}
.report-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
    min-inline-size: 0;
}
.report-content,
.report-sidebar,
.report-baseline,
.report-companion {
    min-inline-size: 0;
}
.report-sidebar {
    display: grid;
    gap: 1rem;
    align-content: start;
}
.report-baseline {
    padding: 1rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.875rem;
    background: var(--scova-surface);
}
.report-baseline :deep(.report-changes) {
    padding: 0;
    border: 0;
}
.report-baseline :deep(.change-sides) {
    grid-template-columns: minmax(0, 1fr);
}
.report-baseline :deep(.comparison-summary) {
    padding: 0.75rem 0;
    border-inline-start: 0;
}
.report-content {
    padding: clamp(1rem, 2vw, 2rem);
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.875rem;
    background: var(--scova-surface);
}
.report-companion {
    display: grid;
    gap: 0;
    padding: 1rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.875rem;
    background: var(--scova-surface);
    scroll-margin-block-start: 1rem;
}
.report-companion:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.report-companion :deep(.questions),
.report-companion :deep(.feedback-effects),
.tool-section :deep(.feedback-actions),
.tool-section :deep(.notes-panel),
.tool-section :deep(.report-bookmarks) {
    inline-size: 100%;
    padding: 0;
    border: 0;
    background: transparent;
}
.report-companion :deep(.questions),
.report-companion :deep(.feedback-effects) {
    padding-block: 0.5rem 1.5rem;
}
.report-companion :deep(.tool-section h2) {
    font-size: 1rem;
}
.report-companion :deep(.tool-section h2 .n-icon) {
    display: none;
}
.report-bookmarks {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block: 1rem;
}
.report-presentation {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.875rem;
    inline-size: 100%;
    min-inline-size: 0;
    padding-block: 1rem 1.5rem;
}
.report-presentation select {
    inline-size: auto;
    flex: 0 1 12rem;
}
.report-presentation p {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
}
.report-sections {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-inline-start: auto;
}
.report-sections :deep(.n-button) {
    min-block-size: 2.75rem;
    height: auto;
    font-size: 1rem;
}
.report-sections :deep(.n-button__content) {
    gap: 0.375rem;
}
.report-bookmarks h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.report-source-history {
    display: grid;
    gap: 0.75rem;
    min-inline-size: 0;
}
.report-bookmarks h2 {
    margin: 0;
    font-size: 1.25rem;
}
select {
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: 100%;
    min-block-size: 2.75rem;
    padding: 0.625rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.5rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    font: inherit;
    cursor: pointer;
}
select:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
select:disabled {
    cursor: not-allowed;
}
.report-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0;
    justify-self: start;
    max-inline-size: 100%;
}
@media (min-width: 80rem) {
    .report-workspace {
        grid-template-columns: minmax(0, 1fr) minmax(22rem, 25rem);
        gap: 1.5rem;
    }
    .report-workspace--reading {
        grid-template-columns: minmax(0, 1fr);
    }
    .report-workspace--reading .report-content {
        inline-size: min(100%, 64rem);
        justify-self: center;
    }
}
@media (max-width: 39.999rem) {
    .report-content,
    .report-baseline,
    .report-companion {
        padding: 0.5rem;
    }
    .report-presentation {
        gap: 0.5rem;
        padding-block: 0.25rem 0.5rem;
    }
    .report-sections {
        gap: 0.375rem;
        margin-inline-start: 0;
    }
    .report-sections :deep(.n-button),
    .report-tools :deep(.navigation-button) {
        padding-inline: 0.625rem;
    }
}
a {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
    overflow-wrap: anywhere;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
