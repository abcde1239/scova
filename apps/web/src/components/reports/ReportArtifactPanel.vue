<template>
    <section
        id="report-artifact"
        ref="panel"
        class="report-content report-artifact-panel"
        :class="[
            `report-artifact-panel--${activeFormat}`,
            { 'report-artifact-panel--reading': reading },
        ]"
        aria-label="报告交付物"
        :role="reading ? 'dialog' : undefined"
        :aria-modal="reading ? true : undefined"
        @keydown="onKeydown"
        @click="revealCitation"
    >
        <header class="deliverable-heading scova-interface">
            <div>
                <p class="artifact-name">{{ report?.title ?? '成果' }}</p>
                <p v-if="report">
                    <span class="artifact-kind">{{ formatLabels[activeFormat] }}</span
                    ><time :datetime="report.publishedAt">{{ savedDate }}</time>
                </p>
            </div>
            <div v-if="report" class="artifact-actions">
                <n-button v-if="reading" @click="emit('conversation')">
                    <app-icon name="back" />返回对话
                </n-button>
                <template v-else>
                    <n-button quaternary v-bind="readButtonAccessibility" @click="emit('read')">
                        完整阅读<app-icon name="source" />
                    </n-button>
                    <button
                        type="button"
                        class="artifact-close"
                        aria-label="关闭成果预览"
                        @click="emit('close')"
                    >
                        <app-icon name="close" />
                    </button>
                </template>
            </div>
        </header>
        <div class="artifact-scroll">
            <slot name="toolbar" />
            <div v-if="report" class="report-presentation scova-interface">
                <nav v-if="formats.length > 1" class="artifact-formats" aria-label="已生成成果">
                    <button
                        v-for="key in formats"
                        :key="key"
                        type="button"
                        :aria-pressed="activeFormat === key"
                        @click="format = key"
                    >
                        {{ formatLabels[key] }}
                    </button>
                </nav>
                <nav class="report-sections" aria-label="报告内容导航">
                    <n-button
                        v-for="section in sections"
                        :key="section.id"
                        tag="a"
                        quaternary
                        type="primary"
                        v-bind="{ href: `#${section.id}` }"
                        @click="jump($event, section.id)"
                    >
                        <app-icon :name="section.icon" />{{ section.label }}
                    </n-button>
                </nav>
            </div>
            <report-changes v-if="report" :report="report" />
            <div v-if="report && projected" class="artifact-document">
                <keep-alive>
                    <component
                        :is="renderer"
                        :key="`${report.id}-${activeFormat}`"
                        :report="projected"
                        :show-changes="false"
                        :show-sources="false"
                    />
                </keep-alive>
            </div>
            <state-panel
                v-else
                :state="loading ? 'loading' : 'error'"
                :message="loading ? '正在读取报告与引用' : errorMessage"
                :retryable="retryable"
                @retry="emit('retry')"
            />
            <report-sources v-if="appendixReport" :report="appendixReport" />
        </div>
    </section>
</template>

<script setup lang="ts">
const readButtonAccessibility = { 'aria-expanded': 'false' };
import { computed, ref } from 'vue';
import { NButton } from 'naive-ui';
import type { Report } from '@scova/models';
import AppIcon from '@/components/common/AppIcon.vue';
import type { IconName } from '@/components/common/icons';
import StatePanel from '@/components/common/StatePanel.vue';
import ReportBrief from '@/components/reports/ReportBrief.vue';
import TopicListReport from '@/components/reports/TopicListReport.vue';
import ComparisonReport from '@/components/reports/ComparisonReport.vue';
import ResearchReport from '@/components/reports/ResearchReport.vue';
import ReportChanges from '@/components/reports/ReportChanges.vue';
import ReportSources from '@/components/reports/ReportSources.vue';
import { artifactReport, savedArtifactFormats } from '@/utils/report-artifacts';

const props = defineProps<{
    report?: Report;
    reading: boolean;
    loading: boolean;
    errorMessage: string;
    retryable: boolean;
}>();
const format = defineModel<Report['format']>('format');
const emit = defineEmits<{
    close: [];
    read: [];
    conversation: [];
    retry: [];
}>();
const panel = ref<HTMLElement>();
const formatLabels = {
    brief: '简报',
    list: '主题清单',
    comparison: '对比表',
    research_report: '研究报告',
};
const renderers = {
    brief: ReportBrief,
    list: TopicListReport,
    comparison: ComparisonReport,
    research_report: ResearchReport,
};
const formats = computed(() => (props.report ? savedArtifactFormats(props.report) : []));
const activeFormat = computed(() =>
    format.value && formats.value.includes(format.value)
        ? format.value
        : (formats.value[0] ?? 'brief'),
);
const projected = computed(() =>
    props.report ? artifactReport(props.report, activeFormat.value) : undefined,
);
const appendixReport = computed(() => {
    if (!props.report || !projected.value) return undefined;
    const ids = new Set(projected.value.evidence.map((entry) => entry.id));
    for (const change of props.report.changes)
        for (const id of [...change.oldEvidenceIds, ...change.newEvidenceIds]) ids.add(id);
    return {
        ...projected.value,
        changes: props.report.changes,
        evidence: props.report.evidence.filter((entry) => ids.has(entry.id)),
    };
});
const renderer = computed(() => renderers[activeFormat.value]);
const savedDate = computed(() =>
    props.report
        ? new Intl.DateTimeFormat('zh-CN', {
              month: 'long',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
          }).format(new Date(props.report.publishedAt))
        : '',
);
const sections: { id: string; label: string; icon: IconName }[] = [
    { id: 'report-title', label: '正文', icon: 'report' },
    { id: 'report-changes-title', label: '变化', icon: 'retry' },
    { id: 'saved-evidence-title', label: '来源', icon: 'source' },
];
function jump(event: MouseEvent, id: string) {
    event.preventDefault();
    const target = panel.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    target.tabIndex = -1;
    target.style.scrollMarginBlockStart = '6rem';
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
}
function revealCitation(event: MouseEvent) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    const href = link?.getAttribute('href');
    if (href === '#coverage-title') {
        const details = panel.value?.querySelector<HTMLDetailsElement>('.coverage details');
        if (!details) return;
        event.preventDefault();
        details.open = true;
        details.querySelector('summary')?.focus();
        details.scrollIntoView({ block: 'nearest' });
        return;
    }
    if (!href || !/^#(?:evidence-|answer-|claim-|question-)/.test(href)) return;
    const target = panel.value?.querySelector<HTMLElement>(`#${CSS.escape(href.slice(1))}`);
    if (!target) return;
    event.preventDefault();
    let parent = target.parentElement;
    while (parent && parent !== panel.value) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
    }
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
}
function onKeydown(event: KeyboardEvent) {
    if (props.reading && event.key === 'Tab' && !event.defaultPrevented) {
        const controls = [
            ...(panel.value?.querySelectorAll<HTMLElement>(
                'a[href], button, input, textarea, select, summary, [tabindex="0"]',
            ) ?? []),
        ].filter(
            (element) =>
                element.getClientRects().length &&
                !element.matches(':disabled') &&
                !element.closest('details:not([open]) :not(summary)'),
        );
        const first = controls[0],
            last = controls.at(-1);
        if (
            first &&
            last &&
            (event.shiftKey ? document.activeElement === first : document.activeElement === last)
        ) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        }
        return;
    }
    if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        (event.target instanceof Element &&
            (event.target.closest('input, textarea, select') ||
                (event.target.closest('dialog, [role="dialog"]') &&
                    event.target.closest('dialog, [role="dialog"]') !== panel.value)))
    )
        return;
    event.preventDefault();
    if (props.reading) emit('conversation');
    else emit('close');
}
</script>

<style scoped>
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.report-artifact-panel {
    @apply layout-grid grid-rows-[auto_minmax(0,_1fr)] gap-0 max-w-full
        [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_48%,_transparent)] rounded-5
        [background:color-mix(in_srgb,_var(--scova-selected)_25%,_var(--scova-surface))]
        [box-shadow:0_1rem_3rem_color-mix(in_srgb,_var(--scova-text)_9%,_transparent),_0_0.125rem_0.5rem_color-mix(in_srgb,_var(--scova-text)_3%,_transparent)]
        break-anywhere [overflow:clip] [align-self:start] p-0;
}
.report-artifact-panel--reading {
    @apply w-full justify-self-center [box-shadow:none] max-h-[calc(100dvh_-_6rem)];
}
.report-artifact-panel--reading .artifact-scroll {
    @apply [overflow-y:auto] [overscroll-behavior-block:contain];
}
.artifact-document {
    @apply w-full max-w-[64rem] mx-auto [box-sizing:border-box];
}
.report-artifact-panel--comparison .artifact-document {
    @apply max-w-full;
}
.report-artifact-panel--list .artifact-document {
    @apply max-w-[88rem];
}
.artifact-scroll {
    @apply layout-grid [align-content:start] gap-6 min-h-0 [scrollbar-gutter:stable]
        [scroll-behavior:smooth] p-4;
}
.artifact-document {
    @apply p-[clamp(0.5rem,_2vw,_1.5rem)];
}
.deliverable-heading,
.artifact-actions,
.report-presentation,
.report-sections {
    @apply flex flex-wrap items-center gap-[0.5rem_0.75rem] min-w-0;
}
.deliverable-heading {
    @apply items-start justify-between pt-4 pr-5 pb-4 pl-5
        [border-bottom:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_28%,_transparent)]
        bg-surface;
}
.deliverable-heading .artifact-name {
    @apply text-[1rem] font-semibold m-0 [text-wrap:balance];
}
.deliverable-heading p:not(.artifact-name) {
    @apply flex flex-wrap items-center gap-2.5 mt-1.5 mr-0 mb-0 ml-0 text-[0.875rem] leading-[1.6]
        text-muted;
}
.artifact-kind {
    @apply text-primary font-medium;
}
.deliverable-heading time {
    @apply text-[0.8125rem];
}
.artifact-close {
    @apply font-inherit inline-flex items-center justify-center flex-none min-w-11 min-h-11 [border:0]
        rounded-2 bg-transparent text-default cursor-pointer p-2;
}
.artifact-close:hover {
    @apply [background:var(--scova-selected)];
}
.artifact-close:focus-visible,
.artifact-formats button:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
.artifact-actions :deep(.n-button),
.report-sections :deep(.n-button) {
    @apply min-h-11 h-auto max-w-full pt-2.5 pb-2.5;
}
.artifact-actions :deep(.n-button__content),
.report-sections :deep(.n-button__content) {
    @apply gap-1.5 whitespace-normal;
}
.artifact-formats {
    @apply flex flex-wrap gap-1.5 w-full;
}
.artifact-formats button {
    @apply min-h-11 pt-2.5 pr-4 pb-2.5 pl-4 [border:0.0625rem_solid_transparent] rounded-2.5
        bg-transparent text-muted [font-family:inherit] text-[0.875rem] [font-weight:inherit]
        [font-style:inherit] leading-[inherit] [font-variant:inherit] cursor-pointer
        [transition:background-color_180ms_ease,_color_180ms_ease];
}
.artifact-formats button[aria-pressed='true'] {
    @apply bg-surface text-primary
        [border-color:color-mix(in_srgb,_var(--scova-border)_35%,_transparent)]
        [box-shadow:0_0.125rem_0.375rem_color-mix(in_srgb,_var(--scova-text)_4%,_transparent)];
}
.artifact-formats button:hover {
    @apply bg-surface;
}
.report-sections {
    @apply [flex-basis:100%];
}
.artifact-document {
    @apply min-w-0;
}
@media (max-width: 39.999rem) {
    .artifact-scroll {
        @apply pt-2 pr-1 pb-2 pl-1;
    }
    .deliverable-heading {
        @apply p-3.5;
    }
    .artifact-document {
        @apply pt-4 pr-1 pb-4 pl-1;
    }
    .report-sections :deep(.n-button) {
        @apply pl-2.5 pr-2.5;
    }
}
@media (min-width: 64rem) {
    .report-artifact-panel:not(.report-artifact-panel--reading) {
        @apply sticky [top:1rem] max-h-[calc(100dvh_-_6rem)];
    }
    .report-artifact-panel:not(.report-artifact-panel--reading) .artifact-scroll {
        @apply [overflow-y:auto] [overscroll-behavior-block:contain];
    }
}
@media (prefers-reduced-motion: reduce) {
    .artifact-scroll {
        @apply [scroll-behavior:auto];
    }
    .artifact-formats button {
        @apply [transition:none];
    }
}
</style>
