<template>
    <section
        id="report-artifact"
        ref="panel"
        class="report-content report-artifact-panel"
        :class="{ 'report-artifact-panel--reading': reading }"
        aria-label="报告交付物"
        @keydown="onKeydown"
        @click="revealCitation"
    >
        <header class="deliverable-heading scova-interface">
            <div>
                <h2><app-icon name="report" />{{ reading ? '完整阅读' : '成果预览' }}</h2>
                <p v-if="report">
                    <span class="artifact-kind">{{ formatLabels[activeFormat] }}</span
                    ><time :datetime="report.publishedAt">{{ savedDate }}</time>
                </p>
            </div>
            <div v-if="report" class="artifact-actions">
                <n-button v-if="reading" @click="emit('conversation')">
                    <app-icon name="back" />返回研究对话
                </n-button>
                <template v-else>
                    <n-button quaternary @click="emit('read')">
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
            <div v-if="report && projected" class="report-document">
                <keep-alive>
                    <component
                        :is="renderer"
                        :key="`${report.id}-${activeFormat}`"
                        :report="projected"
                        :show-changes="false"
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
            <section v-if="report" class="report-baseline" aria-label="历史变化与比较基线">
                <report-changes :report="report" />
            </section>
        </div>
    </section>
</template>

<script setup lang="ts">
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
    { id: 'summary-title', label: '正文', icon: 'report' },
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
    if (!href || !/^#(?:evidence-|answer-|claim-|question-)/.test(href)) return;
    const target = panel.value?.querySelector<HTMLElement>(`#${CSS.escape(href.slice(1))}`);
    if (!target) return;
    event.preventDefault();
    let parent = target.parentElement;
    while (parent && parent !== panel.value) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
    }
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
}
function onKeydown(event: KeyboardEvent) {
    if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        (event.target instanceof Element &&
            event.target.closest('input, textarea, select, dialog, [role="dialog"]'))
    )
        return;
    event.preventDefault();
    emit('close');
}
</script>

<style scoped>
.report-artifact-panel {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 0;
    min-inline-size: 0;
    max-inline-size: 100%;
    padding: 0;
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 48%, transparent);
    border-radius: 1.25rem;
    background: color-mix(in srgb, var(--scova-selected) 25%, var(--scova-surface));
    box-shadow:
        0 1rem 3rem color-mix(in srgb, var(--scova-text) 9%, transparent),
        0 0.125rem 0.5rem color-mix(in srgb, var(--scova-text) 3%, transparent);
    overflow-wrap: anywhere;
    overflow: clip;
    align-self: start;
}
.report-artifact-panel--reading {
    inline-size: 100%;
    max-inline-size: 68rem;
    justify-self: center;
    box-shadow: none;
}
.artifact-scroll {
    display: grid;
    align-content: start;
    gap: 1.5rem;
    min-inline-size: 0;
    min-block-size: 0;
    padding: 1rem;
    scrollbar-gutter: stable;
    scroll-behavior: smooth;
}
.report-document {
    background: var(--scova-surface);
    padding: clamp(1rem, 3vw, 2.5rem);
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 24%, transparent);
    border-radius: 0.875rem;
    box-shadow: 0 0.125rem 0.75rem color-mix(in srgb, var(--scova-text) 3%, transparent);
}
.deliverable-heading,
.artifact-actions,
.report-presentation,
.report-sections {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    min-inline-size: 0;
}
.deliverable-heading {
    align-items: start;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-block-end: 0.0625rem solid color-mix(in srgb, var(--scova-border) 28%, transparent);
    background: var(--scova-surface);
}
.deliverable-heading h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
}
.deliverable-heading p {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.625rem;
    margin: 0.375rem 0 0;
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--scova-muted);
}
.artifact-kind {
    color: var(--scova-primary);
    font-weight: 500;
}
.deliverable-heading time {
    font-size: 0.8125rem;
}
.artifact-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    min-inline-size: 2.75rem;
    min-block-size: 2.75rem;
    padding: 0.5rem;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--scova-text);
    font: inherit;
    cursor: pointer;
}
.artifact-close:hover {
    background: var(--scova-selected);
}
.artifact-close:focus-visible,
.artifact-formats button:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.artifact-actions :deep(.n-button),
.report-sections :deep(.n-button) {
    min-block-size: 2.75rem;
    height: auto;
    max-inline-size: 100%;
    padding-block: 0.625rem;
}
.artifact-actions :deep(.n-button__content),
.report-sections :deep(.n-button__content) {
    gap: 0.375rem;
    white-space: normal;
}
.artifact-formats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    inline-size: 100%;
}
.artifact-formats button {
    min-block-size: 2.75rem;
    padding: 0.625rem 1rem;
    border: 0.0625rem solid transparent;
    border-radius: 0.625rem;
    background: transparent;
    color: var(--scova-muted);
    font: inherit;
    font-size: 0.875rem;
    cursor: pointer;
    transition:
        background-color 180ms ease,
        color 180ms ease;
}
.artifact-formats button[aria-pressed='true'] {
    background: var(--scova-surface);
    color: var(--scova-primary);
    border-color: color-mix(in srgb, var(--scova-border) 35%, transparent);
    box-shadow: 0 0.125rem 0.375rem color-mix(in srgb, var(--scova-text) 4%, transparent);
}
.artifact-formats button:hover {
    background: var(--scova-surface);
}
.report-sections {
    flex-basis: 100%;
}
.report-document,
.report-baseline {
    min-inline-size: 0;
}
.report-baseline {
    border-block-start: 0.0625rem solid color-mix(in srgb, var(--scova-border) 30%, transparent);
    padding-block-start: 1rem;
    padding-inline: 0.5rem;
}
.report-baseline :deep(.report-changes) {
    padding: 0;
    border: 0;
}
.report-baseline :deep(.change-sides) {
    grid-template-columns: minmax(0, 1fr);
}
.report-artifact-panel--reading .report-baseline :deep(.change-sides) {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
}
.report-baseline :deep(.comparison-summary) {
    padding: 0.75rem;
}
@media (max-width: 39.999rem) {
    .artifact-scroll {
        padding: 0.5rem 0.25rem;
    }
    .deliverable-heading {
        padding: 0.875rem;
    }
    .report-document {
        padding: 1rem 0.25rem;
    }
    .report-sections :deep(.n-button) {
        padding-inline: 0.625rem;
    }
}
@media (min-width: 64rem) {
    .report-artifact-panel:not(.report-artifact-panel--reading) {
        position: sticky;
        top: 1rem;
        max-block-size: calc(100dvh - 6rem);
    }
    .report-artifact-panel:not(.report-artifact-panel--reading) .artifact-scroll {
        overflow-y: auto;
        overscroll-behavior-block: contain;
    }
}
@media (prefers-reduced-motion: reduce) {
    .artifact-scroll {
        scroll-behavior: auto;
    }
    .artifact-formats button {
        transition: none;
    }
}
</style>
