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
.report-detail {
    display: grid;
    gap: 0.875rem;
    min-inline-size: 0;
}
.workspace-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1rem;
    min-inline-size: 0;
}
.workspace-heading {
    justify-content: space-between;
}
.workspace-heading > div {
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.workspace-eyebrow {
    margin: 0;
    font-weight: 600;
}
.workspace-description,
.companion-heading p {
    margin: 0;
    color: var(--scova-muted);
    font-size: 0.875rem;
    line-height: 1.6;
}
.workspace-description {
    margin-block-start: 0.375rem;
}
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
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
    min-inline-size: 0;
}
.report-conversation-column,
.report-companion {
    min-inline-size: 0;
}
.report-conversation-column {
    display: grid;
    gap: 1rem;
    align-content: start;
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
@media (min-width: 64rem) {
    .report-workspace {
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
        gap: 1.5rem;
    }
    .report-workspace--reading,
    .report-workspace--closed {
        grid-template-columns: minmax(0, 1fr);
    }
}
@media (max-width: 39.999rem) {
    .report-companion {
        padding: 0.5rem;
    }
    .report-tools :deep(.navigation-button) {
        padding-inline: 0.625rem;
    }
}
.report-artifact-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    inline-size: 100%;
    min-inline-size: 0;
    min-block-size: 2.75rem;
    margin-block-end: 1.5rem;
    padding: 1rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.75rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    font: inherit;
    text-align: start;
    cursor: pointer;
}
.report-artifact-card > span:not(.app-icon) {
    display: grid;
    flex: 1;
    min-inline-size: 0;
    gap: 0.375rem;
    overflow-wrap: anywhere;
}
.report-artifact-card strong {
    font-weight: 500;
}
.report-artifact-card small {
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.report-artifact-card:hover {
    background: var(--scova-selected);
}
.report-artifact-card {
    transition:
        background-color 180ms ease,
        box-shadow 180ms ease,
        transform 180ms ease;
}
.report-artifact-card:hover {
    transform: translateY(-0.125rem);
    box-shadow: 0 0.375rem 1rem color-mix(in srgb, var(--scova-text) 5%, transparent);
}
.artifact-pane-enter-active,
.artifact-pane-leave-active {
    transition:
        opacity 220ms ease,
        transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
}
@media (min-width: 64rem) {
    .artifact-pane-leave-active {
        position: absolute;
        inset-block-start: 0;
        inset-inline-end: 0;
        inline-size: calc(55% - 0.75rem);
        pointer-events: none;
    }
}
.artifact-pane-enter-from,
.artifact-pane-leave-to {
    opacity: 0;
    transform: translateX(1.25rem) scale(0.985);
}
@media (prefers-reduced-motion: reduce) {
    .artifact-pane-enter-active,
    .artifact-pane-leave-active,
    .report-artifact-card {
        transition: none;
    }
    .artifact-pane-enter-from,
    .artifact-pane-leave-to,
    .report-artifact-card:hover {
        transform: none;
    }
}
.report-artifact-card:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
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
