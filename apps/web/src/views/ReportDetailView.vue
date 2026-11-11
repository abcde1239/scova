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
        <div
            class="report-workspace"
            :class="{
                'report-workspace--reading': readingOnly || !questionIdentity,
                'report-workspace--closed': !artifactOpen && !!report && !readingOnly,
            }"
        >
            <div v-show="!readingOnly && !!questionIdentity" class="report-conversation-column">
                <section
                    id="report-conversation"
                    class="report-companion"
                    aria-labelledby="report-next-title"
                    tabindex="-1"
                >
                    <header class="companion-heading scova-interface">
                        <router-link
                            v-if="report?.conversation"
                            :to="`/reports/${report.conversation.reportId}?questionId=${report.conversation.questionId}`"
                            >返回原报告对话</router-link
                        >
                        <h2 id="report-next-title"><app-icon name="question" />对话与后续研究</h2>
                        <p>基于这份报告的保存证据作答。补充搜索需单独确认后续研究。</p>
                    </header>
                    <button
                        v-if="report"
                        ref="artifactCard"
                        type="button"
                        class="report-artifact-card scova-interface"
                        aria-controls="report-artifact"
                        :aria-expanded="artifactOpen && !readingOnly"
                        @click="openArtifact"
                    >
                        <app-icon name="report" />
                        <span>
                            <strong>{{ report.title }}</strong>
                            <small
                                >已保存 ·
                                {{
                                    savedArtifactFormats(report)
                                        .map((format) => formatLabels[format])
                                        .join('、')
                                }}
                                · 打开成果</small
                            >
                        </span>
                        <app-icon name="source" />
                    </button>
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
            </div>
            <transition name="artifact-pane">
                <report-artifact-panel
                    :key="routeIdentity"
                    v-show="artifactOpen || readingOnly || !report"
                    v-model:format="selectedFormat"
                    :report="report"
                    :reading="readingOnly"
                    :loading="valid && query.isPending.value"
                    :error-message="error.message"
                    :retryable="error.retryable && valid && query.isError.value"
                    @close="closeArtifact"
                    @read="openReading"
                    @conversation="openConversation"
                    @retry="retry"
                />
            </transition>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRaw, watch } from 'vue';
import { useRoute } from 'vue-router';
import NavigationButton from '@/components/common/NavigationButton.vue';
import ToolSection from '@/components/common/ToolSection.vue';
import type { Report } from '@scova/models';
import AppIcon from '@/components/common/AppIcon.vue';
import ReportArtifactPanel from '@/components/reports/ReportArtifactPanel.vue';
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
import { useReport } from '@/composables/useReport';
import { reportEndpoint } from '@/api/reports';
import { inboxReturn } from '@/composables/useInbox';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { savedArtifactFormats } from '@/utils/report-artifacts';
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
const artifactOpen = ref(true);
const artifactCard = ref<HTMLButtonElement>();
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
watch(
    routeIdentity,
    () => {
        questionIdentity.value = '';
        readingOnly.value = false;
        artifactOpen.value = true;
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
async function openArtifact() {
    const identity = routeIdentity.value;
    artifactOpen.value = true;
    readingOnly.value = false;
    await nextTick();
    if (identity !== routeIdentity.value || !report.value) return;
    detail.value?.querySelector<HTMLButtonElement>('.artifact-close')?.focus();
}
async function closeArtifact() {
    if (readingOnly.value) return;
    const identity = routeIdentity.value;
    artifactOpen.value = false;
    await nextTick();
    if (identity === routeIdentity.value) artifactCard.value?.focus();
}
async function openReading() {
    const identity = routeIdentity.value;
    readingOnly.value = true;
    artifactOpen.value = true;
    await nextTick();
    if (identity !== routeIdentity.value || !report.value) return;
    const title = detail.value?.querySelector<HTMLElement>('#report-title');
    title?.focus({ preventScroll: true });
    title?.scrollIntoView({ block: 'start' });
}
async function openConversation() {
    const identity = routeIdentity.value;
    readingOnly.value = false;
    artifactOpen.value = true;
    await nextTick();
    if (identity !== routeIdentity.value) return;
    const target = detail.value?.querySelector<HTMLElement>('#report-conversation');
    const input = target?.querySelector<HTMLTextAreaElement>('textarea:not([readonly])');
    (input ?? target)?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
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
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.report-detail {
    @apply layout-grid gap-3.5;
}
.workspace-heading {
    @apply flex flex-wrap items-center gap-[0.75rem_1rem] min-w-0;
}
.workspace-heading {
    @apply justify-between;
}
.workspace-heading > div {
    @apply min-w-0 break-anywhere;
}
.workspace-eyebrow {
    @apply font-semibold m-0;
}
.workspace-description,
.companion-heading p {
    @apply text-muted text-[0.875rem] leading-[1.6] m-0;
}
.workspace-description {
    @apply mt-1.5;
}
.companion-heading h2 {
    @apply flex items-center gap-2 text-[1rem] font-semibold m-0;
}
.companion-heading {
    @apply grid gap-2 pb-6 [border-bottom:0.0625rem_solid_var(--scova-border)] mb-4;
}
.report-workspace {
    @apply layout-stack relative grid-cols-[minmax(0,_1fr)] items-start;
}
.report-conversation-column,
.report-companion {
    @apply min-w-0;
}
.report-conversation-column {
    @apply grid gap-4 [align-content:start];
}
.report-companion {
    @apply grid gap-0 border-theme rounded-3.5 bg-surface [scroll-margin-block-start:1rem] p-4;
}
.report-companion:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
.report-companion :deep(.questions),
.report-companion :deep(.feedback-effects),
.tool-section :deep(.feedback-actions),
.tool-section :deep(.notes-panel),
.tool-section :deep(.report-bookmarks) {
    @apply w-full [border:0] bg-transparent p-0;
}
.report-companion :deep(.questions),
.report-companion :deep(.feedback-effects) {
    @apply pt-2 pb-6;
}
.report-companion :deep(.tool-section h2) {
    @apply text-[1rem];
}
.report-companion :deep(.tool-section h2 .n-icon) {
    @apply hidden;
}
.report-bookmarks {
    @apply layout-stack break-anywhere [border-top:0.0625rem_solid_var(--scova-border)] pt-4 pb-4;
}
.report-bookmarks h2 {
    @apply flex items-center gap-2;
}
.report-source-history {
    @apply layout-grid gap-3;
}
.report-bookmarks h2 {
    @apply text-[1.25rem] m-0;
}
select {
    @apply font-inherit w-full min-w-0 max-w-full min-h-11 border-theme rounded-2 bg-surface
        text-default cursor-pointer p-2.5;
}
select:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
select:disabled {
    @apply cursor-not-allowed;
}
.report-tools {
    @apply flex flex-wrap gap-2 justify-self-start max-w-full p-0;
}
@media (min-width: 64rem) {
    .report-workspace {
        @apply grid-cols-[minmax(0,_0.9fr)_minmax(0,_1.1fr)] gap-6;
    }
    .report-workspace--reading,
    .report-workspace--closed {
        @apply grid-cols-[minmax(0,_1fr)];
    }
}
@media (max-width: 39.999rem) {
    .report-companion {
        @apply p-2;
    }
    .report-tools :deep(.navigation-button) {
        @apply pl-2.5 pr-2.5;
    }
}
.report-artifact-card {
    @apply font-inherit flex items-center gap-3 w-full min-w-0 min-h-11 mb-6 border-theme rounded-3
        bg-surface text-default text-start cursor-pointer p-4;
}
.report-artifact-card > span:not(.app-icon) {
    @apply layout-grid flex-1 gap-1.5 break-anywhere;
}
.report-artifact-card strong {
    @apply font-medium;
}
.report-artifact-card small {
    @apply text-muted text-[0.875rem];
}
.report-artifact-card:hover {
    @apply [background:var(--scova-selected)];
}
.report-artifact-card {
    @apply [transition:background-color_180ms_ease,_box-shadow_180ms_ease,_transform_180ms_ease];
}
.report-artifact-card:hover {
    @apply [transform:translateY(-0.125rem)]
        [box-shadow:0_0.375rem_1rem_color-mix(in_srgb,_var(--scova-text)_5%,_transparent)];
}
.artifact-pane-enter-active,
.artifact-pane-leave-active {
    @apply [transition:opacity_220ms_ease,_transform_220ms_cubic-bezier(0.2,_0.7,_0.2,_1)];
}
@media (min-width: 64rem) {
    .artifact-pane-leave-active {
        @apply absolute [top:0] [right:0] w-[calc(55%_-_0.75rem)] [pointer-events:none];
    }
}
.artifact-pane-enter-from,
.artifact-pane-leave-to {
    @apply opacity-0 [transform:translateX(1.25rem)_scale(0.985)];
}
@media (prefers-reduced-motion: reduce) {
    .artifact-pane-enter-active,
    .artifact-pane-leave-active,
    .report-artifact-card {
        @apply [transition:none];
    }
    .artifact-pane-enter-from,
    .artifact-pane-leave-to,
    .report-artifact-card:hover {
        @apply [transform:none];
    }
}
.report-artifact-card:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
a {
    @apply inline-flex items-center gap-2 min-h-11 text-primary cursor-pointer underline-offset-[0.2em]
        break-anywhere;
}
a:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
</style>
