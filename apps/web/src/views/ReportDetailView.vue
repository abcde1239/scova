<template>
    <div ref="detail" class="report-detail">
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
            </nav>
        </div>
        <div class="report-workspace">
            <div class="report-content">
                <component
                    :is="renderer"
                    v-if="report"
                    :key="`${routeIdentity}-${selectedFormat}`"
                    :report="report"
                />
                <state-panel
                    v-if="!report"
                    :state="valid && query.isPending.value ? 'loading' : 'error'"
                    :message="valid && query.isPending.value ? '正在读取报告与引用' : error.message"
                    :retryable="error.retryable && valid && query.isError.value"
                    @retry="retry"
                />
            </div>
            <div class="report-companion">
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
                        <h2 id="report-bookmark-title"><app-icon name="bookmark" />收藏报告来源</h2>
                        <label for="bookmark-source">选择收藏来源</label>
                        <select
                            id="bookmark-source"
                            v-model="selectedSource"
                            :disabled="bookmarkBusy"
                        >
                            <option value="">请选择一份资料</option>
                            <option v-for="source in sources" :key="source.id" :value="source.id">
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
const changesTarget = computed(() =>
    selectedFormat.value === 'comparison' ? 'comparison-title' : 'report-changes-title',
);
watch(
    routeIdentity,
    () => {
        questionIdentity.value = '';
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
function jump(event: MouseEvent, id: string) {
    event.preventDefault();
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
.report-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
    min-inline-size: 0;
}
.report-content,
.report-companion {
    min-inline-size: 0;
}
.report-content {
    padding-block: 0.5rem;
}
.report-companion {
    display: grid;
    gap: 0;
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
@media (min-width: 75rem) {
    .report-workspace {
        grid-template-columns: minmax(0, 1fr) minmax(21rem, 0.4fr);
        gap: 2.5rem;
    }
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
    padding-block: 0.25rem 0.75rem;
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
@media (max-width: 39.999rem) {
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
