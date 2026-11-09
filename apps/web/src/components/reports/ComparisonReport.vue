<template>
    <report-frame :report="report" format="comparison" class="report-comparison">
        <template #format-notice
            ><report-format-banner format="comparison" :report="report"
        /></template>
        <section
            v-if="showChanges"
            class="comparison-section scova-interface"
            aria-labelledby="comparison-title"
        >
            <h3 id="comparison-title">事实与变化对比</h3>
            <dl class="comparison-context">
                <div>
                    <dt>比较基线执行标识</dt>
                    <dd>{{ report.baselineRunId ?? '报告未提供关联的基线执行。' }}</dd>
                </div>
            </dl>
            <aside
                class="comparison-summary"
                :class="{ 'scova-warning': model.summary.state === 'inconclusive' }"
                role="note"
            >
                <h4>{{ model.summary.title }}</h4>
                <p>{{ model.summary.message }}</p>
            </aside>
            <p v-if="!model.groups.length">本报告没有提供逐项变化记录。</p>
            <template v-else>
                <p v-if="overflowing" id="comparison-scroll-hint">
                    对比表可左右滚动；聚焦表格区域后可使用左右方向键，Tab 键可进入双方引用。
                </p>
                <div
                    ref="scrollArea"
                    class="comparison-scroll"
                    :role="overflowing ? 'region' : undefined"
                    :tabindex="overflowing ? 0 : undefined"
                    :aria-labelledby="overflowing ? 'comparison-caption' : undefined"
                    :aria-describedby="overflowing ? 'comparison-scroll-hint' : undefined"
                >
                    <table ref="table" class="comparison-table scova-table">
                        <caption id="comparison-caption">
                            逐项事实与变化对比
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">比较维度</th>
                                <th scope="col">分类与重要性</th>
                                <th scope="col">旧值 · 基线</th>
                                <th scope="col">本次观测 · 新值</th>
                            </tr>
                        </thead>
                        <tbody v-for="group in model.groups" :key="group.kind">
                            <tr
                                v-for="entry in group.entries"
                                :key="entry.record.id"
                                :id="`comparison-change-${entry.record.id}`"
                            >
                                <th scope="row" class="fact-key">{{ entry.record.factKey }}</th>
                                <td>
                                    <div class="cell-content">
                                        <p class="change-kind">{{ group.title }}</p>
                                        <p>
                                            重要性标记：{{
                                                entry.record.important ? '重要' : '未标记为重要'
                                            }}
                                        </p>
                                        <p class="original-text">{{ entry.record.reason }}</p>
                                    </div>
                                </td>
                                <td class="old-side">
                                    <div class="cell-content">
                                        <p class="original-text">
                                            {{ entry.record.oldValue ?? '未提供旧值' }}
                                        </p>
                                        <p v-if="entry.missingOldEvidence" class="scova-warning">
                                            旧值缺少可核对引用，这项比较仍待核验。
                                        </p>
                                        <div
                                            v-for="evidence in entry.oldEvidence"
                                            :id="`comparison-${entry.record.id}-old-${evidence.id}`"
                                            :key="evidence.id"
                                            class="table-citation"
                                        >
                                            <evidence-citation :evidence="evidence" />
                                        </div>
                                        <p v-if="!entry.oldEvidence.length">未提供旧侧引用。</p>
                                    </div>
                                </td>
                                <td class="new-side">
                                    <div class="cell-content">
                                        <p class="original-text">
                                            {{ entry.record.newValue ?? '未提供新值' }}
                                        </p>
                                        <div
                                            v-for="evidence in entry.newEvidence"
                                            :id="`comparison-${entry.record.id}-new-${evidence.id}`"
                                            :key="evidence.id"
                                            class="table-citation"
                                        >
                                            <evidence-citation :evidence="evidence" />
                                        </div>
                                        <p v-if="!entry.newEvidence.length">未提供本次观测引用。</p>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>
        </section>
        <report-findings-table v-if="!report.coverage.reportValue" :report="report" />
    </report-frame>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Report } from '@scova/models';
import ReportFrame from '@/components/reports/ReportFrame.vue';
import ReportFindingsTable from '@/components/reports/ReportFindingsTable.vue';
import ReportFormatBanner from '@/components/reports/ReportFormatBanner.vue';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
import { reportComparison } from '@/utils/report-comparison';
const props = withDefaults(defineProps<{ report: Report; showChanges?: boolean }>(), {
    showChanges: true,
});
const model = computed(() => reportComparison(props.report));
const scrollArea = ref<HTMLElement>();
const table = ref<HTMLTableElement>();
const overflowing = ref(false);
let observer: ResizeObserver | undefined;
function measureOverflow() {
    const element = scrollArea.value;
    overflowing.value = !!element && element.scrollWidth > element.clientWidth;
}
async function observeTable() {
    await nextTick();
    observer?.disconnect();
    if (scrollArea.value) observer?.observe(scrollArea.value);
    if (table.value) observer?.observe(table.value);
    measureOverflow();
}
onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(measureOverflow);
    window.addEventListener('resize', measureOverflow);
    void observeTable();
});
watch(() => props.report, observeTable);
onUnmounted(() => {
    observer?.disconnect();
    window.removeEventListener('resize', measureOverflow);
});
</script>

<style scoped>
.comparison-section,
.comparison-summary,
.claim-section,
.cell-content {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
h3,
h4,
p,
dl,
dd {
    margin: 0;
}
h3 {
    font-size: 1.25rem;
    font-weight: 600;
}
h4 {
    font-size: 1.125rem;
    font-weight: 600;
}
dt {
    color: var(--scova-muted);
}
.comparison-summary {
    gap: 0.75rem;
}
.comparison-scroll {
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
}
.comparison-scroll:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.comparison-table {
    inline-size: 100%;
    min-inline-size: 43rem;
    table-layout: fixed;
    border-collapse: collapse;
}
caption {
    text-align: start;
    font-weight: 600;
    padding-block-end: 1rem;
}
th,
td {
    padding: 1rem;
    text-align: start;
    vertical-align: top;
    border: 0.0625rem solid var(--scova-border);
    overflow-wrap: anywhere;
}
th {
    font-weight: 600;
}
thead th {
    background: var(--scova-surface);
}
th:first-child {
    inline-size: 8rem;
}
th:nth-child(2) {
    inline-size: 11rem;
}
.fact-key,
.original-text {
    white-space: pre-wrap;
}
.change-kind {
    font-weight: 600;
}
.table-citation {
    min-inline-size: 0;
}
.comparison-table,
.table-citation :deep(*) {
    font-family: var(--scova-font-interface);
}
.table-citation :deep(summary),
.table-citation :deep(a) {
    min-block-size: 2.75rem;
    box-sizing: border-box;
}
.table-citation :deep(summary),
.table-citation :deep(.evidence-body),
.table-citation :deep(blockquote) {
    padding-inline: 0.75rem;
}
</style>
