<template>
    <div ref="detail" class="report-detail">
        <report-workspace-header
            :report="report"
            :return-to="returnTo"
            @open-artifact="openArtifact"
        />
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
                        <h2 id="report-next-title" class="sr-only">对话与后续研究</h2>
                    </header>
                    <button
                        v-if="report"
                        ref="artifactCard"
                        type="button"
                        class="report-artifact-card scova-interface"
                        aria-controls="report-artifact"
                        :aria-expanded="artifactOpen && !readingOnly"
                        @click="selectArtifact(report.id)"
                    >
                        <app-icon name="report" />
                        <span>
                            <strong>{{ report.title }}</strong>
                            <small
                                >原报告 ·
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
                        :blocked="mergeProtected"
                        :active-merge="mergeActive"
                        @artifacts-change="updateArtifacts"
                        @open-artifact="openConversationArtifact"
                        @merge="mergeAction?.open($event)"
                        @merge-runs-change="updateMergeRuns"
                        @show-merge="mergeAction?.showRuns()"
                    >
                        <template #execution>
                            <report-merge-action
                                v-if="questionIdentity"
                                ref="mergeAction"
                                :key="`merge-${questionIdentity}`"
                                :report-id="String(route.params.reportId)"
                                :report="report"
                                :artifacts="conversationArtifacts"
                                :runs="mergeRuns"
                                @artifact="rememberArtifact"
                                @open-artifact="openConversationArtifact"
                                @protected-change="mergeProtected = $event"
                                @active-change="mergeActive = $event"
                            />
                        </template>
                    </report-questions>
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
                    <report-library-tools
                        :report="report"
                        :report-id="String(route.params.reportId)"
                    />
                </section>
            </div>
            <transition name="artifact-pane">
                <report-artifact-panel
                    :key="routeIdentity"
                    v-show="artifactOpen || readingOnly || !report"
                    v-model:format="selectedFormat"
                    :report="readingReport"
                    :reading="readingOnly"
                    :loading="valid && readingQuery.isPending.value"
                    :error-message="readingError.message"
                    :retryable="
                        readingError.retryable && !readingReport && !readingQuery.isPending.value
                    "
                    @close="closeArtifact"
                    @read="openReading"
                    @conversation="openConversation"
                    @retry="retry"
                >
                    <template #toolbar>
                        <report-artifact-selection
                            :report="report"
                            :selected-artifact-id="selectedArtifactId"
                            :selected-artifact="selectedArtifact"
                            :conversation-artifacts="conversationArtifacts"
                            @select="selectArtifact"
                            @merge="mergeAction?.open($event)"
                        />
                    </template>
                </report-artifact-panel>
            </transition>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import ReportWorkspaceHeader from '@/component/reports/ReportWorkspaceHeader.vue';
import ReportArtifactSelection from '@/component/reports/ReportArtifactSelection.vue';
import ToolSection from '@/component/common/ToolSection.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import ReportArtifactPanel from '@/component/reports/ReportArtifactPanel.vue';
import FeedbackActions from '@/component/reports/FeedbackActions.vue';
import FeedbackEffects from '@/component/reports/FeedbackEffects.vue';
import ReportQuestions from '@/component/reports/ReportQuestions.vue';
import ReportMergeAction from '@/component/reports/ReportMergeAction.vue';
import ReportLibraryTools from '@/component/reports/ReportLibraryTools.vue';
import { savedArtifactFormats } from '@/utils/report/artifacts';
import { useReportWorkspace } from '@/composable/report-workspace/useReportWorkspace';
const detail = ref<HTMLElement>();
const artifactCard = ref<HTMLButtonElement>();
const {
    route,
    accountId,
    returnTo,
    report,
    valid,
    readingQuery,
    readingError,
    readingReport,
    conversationArtifacts,
    mergeRuns,
    mergeProtected,
    mergeActive,
    mergeAction,
    selectedArtifactId,
    selectedArtifact,
    selectArtifact,
    openConversationArtifact,
    rememberArtifact,
    updateArtifacts,
    updateMergeRuns,
    questionIdentity,
    routeIdentity,
    selectedFormat,
    formatLabels,
    readingOnly,
    artifactOpen,
    openArtifact,
    closeArtifact,
    openReading,
    openConversation,
    retry,
} = useReportWorkspace(detail, artifactCard);
</script>

<style scoped>
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.report-detail {
    @apply layout-grid gap-3.5;
}
.companion-heading p {
    @apply text-muted text-[0.875rem] leading-[1.6] m-0;
}
.companion-heading h2 {
    @apply flex items-center gap-2 text-[1rem] font-semibold m-0;
}
.companion-heading {
    @apply grid gap-2;
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
    @apply grid gap-0 [scroll-margin-block-start:1rem] p-2;
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
@media (max-width: 63.999rem) {
    .report-workspace :deep(.report-artifact-panel:not(.report-artifact-panel--reading)) {
        @apply hidden;
    }
    .report-workspace :deep(.report-artifact-panel--reading) {
        @apply fixed inset-0 z-[20] max-h-none h-[100dvh] rounded-none;
    }
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
        @apply p-0;
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
    @apply inline-flex items-center gap-2 min-h-11 internal-link cursor-pointer
        break-anywhere;
}
a:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
</style>
