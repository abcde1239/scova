<template>
    <section
        id="report-artifact"
        ref="panel"
        class="report-content report-artifact-panel"
        :class="[
            `report-artifact-panel--${activeFormat}`,
            {
                'report-artifact-panel--reading': reading,
                'report-artifact-panel--printable': printable && projected,
            },
        ]"
        aria-label="报告交付物"
        :role="reading ? 'dialog' : undefined"
        :aria-modal="reading ? true : undefined"
        @keydown="onKeydown"
        @click="revealCitation"
    >
        <header class="deliverable-heading scova-interface">
            <div class="artifact-version">
                <slot name="toolbar" />
            </div>
            <div class="artifact-actions">
                <template v-if="report">
                    <report-workspace-menu
                        ref="exportMenu"
                        label="导出成果"
                        icon="download"
                        placement="bottom-end"
                    >
                        <template #default="{ close }">
                            <report-export-button
                                :key="`${report.id}:md`"
                                :report-id="report.id"
                                format="markdown"
                                compact
                            />
                            <report-export-button
                                :key="`${report.id}:json`"
                                :report-id="report.id"
                                format="json"
                                compact
                            />
                            <button
                                v-if="projected"
                                type="button"
                                class="workspace-menu-item"
                                @click="
                                    close();
                                    printReport();
                                "
                            >
                                打印 / 另存为 PDF
                            </button>
                        </template>
                    </report-workspace-menu>
                    <report-workspace-menu label="更多成果操作" icon="more" placement="bottom-end">
                        <template #default="{ close }">
                            <slot v-if="!reading" name="actions" :close="close" />
                            <router-link class="workspace-menu-item" :to="`/runs/${report.runId}`"
                                >执行详情</router-link
                            >
                            <router-link class="workspace-menu-item" to="/account/appearance"
                                >阅读外观</router-link
                            >
                            <router-link
                                class="workspace-menu-item"
                                :to="`/tasks/${report.taskId}/edit`"
                                >修改定期研究设置</router-link
                            >
                        </template>
                    </report-workspace-menu>
                </template>
                <button
                    v-if="reading"
                    type="button"
                    class="artifact-control artifact-return"
                    @click="emit('conversation')"
                >
                    <app-icon name="back" />返回对话
                </button>
                <template v-else>
                    <button
                        v-if="report"
                        type="button"
                        class="artifact-control"
                        title="完整阅读"
                        aria-label="完整阅读"
                        @click="emit('read')"
                    >
                        <app-icon name="source" />
                    </button>
                    <button
                        type="button"
                        class="artifact-control artifact-close"
                        title="关闭成果预览"
                        aria-label="关闭成果预览"
                        @click="emit('close')"
                    >
                        <app-icon name="close" />
                    </button>
                </template>
            </div>
        </header>
        <div class="artifact-scroll">
            <nav
                v-if="report && formats.length > 1"
                class="artifact-formats scova-interface"
                aria-label="已生成成果"
            >
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
            <div v-if="report && projected" class="artifact-document">
                <keep-alive>
                    <component
                        :is="renderer"
                        :key="`${report.id}-${activeFormat}`"
                        :report="projected"
                        :show-changes="false"
                        :show-sources="false"
                    >
                        <template #section-navigation>
                            <nav class="report-sections scova-interface" aria-label="报告内容导航">
                                <a
                                    v-for="section in sections"
                                    :key="section.id"
                                    :href="`#${section.id}`"
                                    @click="jump($event, section.id)"
                                    >{{ section.label }}</a
                                >
                            </nav>
                        </template>
                    </component>
                </keep-alive>
            </div>
            <state-panel
                v-else
                :state="loading ? 'loading' : 'error'"
                :message="loading ? '正在读取报告与引用' : errorMessage"
                :retryable="retryable"
                @retry="emit('retry')"
            />
            <report-changes v-if="report" :report="report" />
            <report-sources v-if="appendixReport" :report="appendixReport" />
            <details
                v-if="report"
                :key="`chart-${report.id}`"
                class="border-theme rounded-2 scova-interface"
                @toggle="chartOpen = ($event.currentTarget as HTMLDetailsElement).open || chartOpen"
            >
                <summary class="source-disclosure-control min-h-11 py-2 px-4 font-semibold">
                    引用来源图表
                </summary>
                <report-source-chart
                    v-if="chartOpen"
                    :report="report"
                    :visible-evidence-ids="appendixReport?.evidence.map((entry) => entry.id) ?? []"
                />
            </details>
            <details
                v-if="report"
                :key="`attachments-${report.id}`"
                class="border-theme rounded-2 scova-interface"
                @toggle="attachmentsOpen = ($event.currentTarget as HTMLDetailsElement).open"
            >
                <summary class="source-disclosure-control min-h-11 py-2 px-4 font-semibold">
                    私有参考附件
                </summary>
                <report-attachments v-if="attachmentsOpen" :report-id="report.id" />
            </details>
        </div>
    </section>
</template>

<script setup lang="ts">
const chartOpen = ref(false);
const attachmentsOpen = ref(false);
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ReportExportButton from '@/component/reports/ReportExportButton.vue';
import ReportWorkspaceMenu from '@/component/reports/ReportWorkspaceMenu.vue';
import type { Report } from '@scova/models';
import AppIcon from '@/component/common/AppIcon.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import ReportBrief from '@/component/reports/ReportBrief.vue';
import TopicListReport from '@/component/reports/TopicListReport.vue';
import ComparisonReport from '@/component/reports/ComparisonReport.vue';
import ResearchReport from '@/component/reports/ResearchReport.vue';
import ReportChanges from '@/component/reports/ReportChanges.vue';
import ReportSources from '@/component/reports/ReportSources.vue';
import ReportSourceChart from '@/component/reports/ReportSourceChart.vue';
import ReportAttachments from '@/component/reports/ReportAttachments.vue';
import { artifactReport, savedArtifactFormats } from '@/utils/report/artifacts';

const props = defineProps<{
    report?: Report;
    reading: boolean;
    printable?: boolean;
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
const exportMenu = ref<InstanceType<typeof ReportWorkspaceMenu>>();
let returnToExport = false;
const printDisclosures = new Set<HTMLDetailsElement>();

function preparePrint() {
    if (!props.printable || !projected.value) return;
    const disclosures = panel.value?.querySelectorAll<HTMLDetailsElement>(
        ':is(.artifact-document, .report-changes, .evidence-appendix) details:not([open])',
    );
    for (const details of disclosures ?? []) {
        printDisclosures.add(details);
        details.open = true;
    }
}

function restoreAfterPrint() {
    for (const details of printDisclosures) details.open = false;
    printDisclosures.clear();
    if (returnToExport) exportMenu.value?.focus();
    returnToExport = false;
}

function printReport() {
    returnToExport = true;
    window.print();
}

onMounted(() => {
    window.addEventListener('beforeprint', preparePrint);
    window.addEventListener('afterprint', restoreAfterPrint);
});
onBeforeUnmount(() => {
    window.removeEventListener('beforeprint', preparePrint);
    window.removeEventListener('afterprint', restoreAfterPrint);
    restoreAfterPrint();
});
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
watch(
    () => props.report?.id,
    () => {
        chartOpen.value = false;
        attachmentsOpen.value = false;
    },
);
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
const sections = [
    { id: 'report-title', label: '正文' },
    { id: 'report-changes-title', label: '变化' },
    { id: 'saved-evidence-title', label: '来源' },
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
.report-artifact-panel {
    @apply grid grid-rows-[auto_minmax(0,_1fr)] min-w-0 max-w-full gap-0 bg-surface break-anywhere;
    border-inline-start: 1px solid color-mix(in srgb, var(--scova-border) 40%, transparent);
}
.report-artifact-panel--reading {
    border-inline-start: 0;
    max-block-size: calc(100dvh - 5rem);
}
.report-artifact-panel--reading .artifact-scroll {
    overflow-y: auto;
    overscroll-behavior-block: contain;
}
.artifact-scroll {
    @apply grid [align-content:start] gap-6 min-h-0 p-[clamp(0.875rem,_2.8vw,_2.75rem)];
    scrollbar-gutter: stable;
    overflow-x: clip;
}
.artifact-scroll > * {
    width: 100%;
    max-width: 64rem;
    min-width: 0;
    margin-inline: auto;
}
.report-artifact-panel--comparison .artifact-document,
.report-artifact-panel--list .artifact-document {
    max-width: 88rem;
}
.deliverable-heading,
.artifact-actions,
.artifact-formats,
.report-sections {
    @apply flex flex-wrap items-center gap-1 min-w-0;
}
.deliverable-heading {
    @apply justify-between gap-2 py-2 px-3 bg-surface;
    min-width: 0;
    border-block-end: 1px solid color-mix(in srgb, var(--scova-border) 40%, transparent);
    z-index: 1;
}
.artifact-version {
    flex: 1 1 7rem;
    min-width: 0;
}
.artifact-actions {
    margin-inline-start: auto;
    max-inline-size: 100%;
}
.artifact-control,
.artifact-formats button,
.report-sections a {
    @apply inline-flex flex-none items-center justify-center min-h-9 border-0 rounded-2 bg-transparent text-muted font-inherit cursor-pointer;
    transition:
        color 140ms ease,
        background-color 140ms ease,
        scale 140ms ease;
}
.artifact-control {
    @apply min-w-9 gap-1 px-2;
}
.artifact-return {
    font-size: 0.8125rem;
}
.artifact-formats {
    @apply gap-2;
}
.artifact-formats button,
.report-sections a {
    @apply px-3 text-sm;
}
.artifact-control:hover,
.artifact-formats button:hover,
.artifact-formats button[aria-pressed='true'],
.report-sections a:hover {
    @apply [background:var(--scova-selected)] text-default;
}
.artifact-control:active {
    scale: 0.96;
}
.artifact-control:focus-visible,
.artifact-formats button:focus-visible,
.report-sections a:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -1px;
}
.report-sections {
    @apply gap-2;
}
.report-sections a {
    @apply no-underline;
}
@media (pointer: coarse) {
    .artifact-control,
    .artifact-formats button,
    .report-sections a {
        @apply min-h-11;
    }
    .artifact-control {
        @apply min-w-11;
    }
}
@media (width >= 64rem) {
    .report-artifact-panel:not(.report-artifact-panel--reading) {
        @apply sticky top-0 max-h-[100dvh];
    }
    .report-artifact-panel:not(.report-artifact-panel--reading) .artifact-scroll {
        @apply [overflow-y:auto] [overscroll-behavior-block:contain];
    }
}
@media (prefers-reduced-motion: reduce) {
    .artifact-control,
    .artifact-formats button,
    .report-sections a {
        transition: none;
        scale: none;
    }
}
</style>

<style>
@media print {
    /* Remove the workbench and conversation chrome from the report's ancestor chain. */
    :where(body, body *):has(.report-artifact-panel--printable)
        > :not(:has(.report-artifact-panel--printable), .report-artifact-panel--printable),
    .report-artifact-panel--printable .deliverable-heading,
    .report-artifact-panel--printable
        .artifact-scroll
        > :not(.artifact-document, .report-changes, .evidence-appendix) {
        display: none !important;
    }

    :where(body, body *):has(.report-artifact-panel--printable),
    .report-artifact-panel--printable,
    .report-artifact-panel--printable :is(.artifact-scroll, .artifact-document) {
        display: block !important;
        position: static !important;
        transform: none !important;
        width: auto !important;
        min-height: 0 !important;
        max-height: none !important;
        max-width: none !important;
        height: auto !important;
        overflow: visible !important;
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
        margin: 0 !important;
        padding: 0 !important;
    }

    .report-artifact-panel--printable {
        color-scheme: light;
        --scova-text: #171717;
        --scova-muted: #404040;
        --scova-primary: #174076;
        --scova-border: #c7c7c7;
        --scova-canvas: #fff;
        --scova-surface: #fff;
        --scova-selected: #f3f3f3;
        color: var(--scova-text);
    }

    .report-artifact-panel--printable :is(.matrix-scroll, .findings-scroll) {
        overflow: visible;
    }

    .report-artifact-panel--printable table {
        min-width: 0;
    }

    .report-artifact-panel--printable :is(h2, h3, h4, summary) {
        break-after: avoid;
    }
}
</style>
