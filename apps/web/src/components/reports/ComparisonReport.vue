<template>
    <report-frame :report="report" format="comparison" class="report-comparison">
        <template #format-notice
            ><report-format-banner format="comparison" :report="report"
        /></template>
        <section
            v-if="showChanges"
            class="comparison-section scova-interface report-grid"
            aria-labelledby="comparison-title"
        >
            <h3 class="text-[1.25rem] font-semibold m-0" id="comparison-title">事实与变化对比</h3>
            <dl class="comparison-context m-0">
                <div>
                    <dt class="text-muted">比较基线执行标识</dt>
                    <dd class="m-0">{{ report.baselineRunId ?? '报告未提供关联的基线执行。' }}</dd>
                </div>
            </dl>
            <aside
                class="comparison-summary layout-grid gap-3 break-anywhere"
                :class="{ 'scova-warning': model.summary.state === 'inconclusive' }"
                role="note"
            >
                <h4 class="text-[1.125rem] font-semibold m-0">{{ model.summary.title }}</h4>
                <p class="m-0">{{ model.summary.message }}</p>
            </aside>
            <p class="m-0" v-if="!model.groups.length">本报告没有提供逐项变化记录。</p>
            <template v-else>
                <p class="m-0" v-if="overflowing" id="comparison-scroll-hint">
                    对比表可左右滚动；聚焦表格区域后可使用左右方向键，Tab 键可进入双方引用。
                </p>
                <div
                    ref="scrollArea"
                    class="comparison-scroll min-w-0 max-w-full [overflow-x:auto] [overscroll-behavior-inline:contain] keyboard-focus-wide"
                    :role="overflowing ? 'region' : undefined"
                    :tabindex="overflowing ? 0 : undefined"
                    :aria-labelledby="overflowing ? 'comparison-caption' : undefined"
                    :aria-describedby="overflowing ? 'comparison-scroll-hint' : undefined"
                >
                    <table
                        ref="table"
                        class="comparison-table scova-table w-full min-w-[43rem] [table-layout:fixed] [border-collapse:collapse] [font-family:var(--scova-font-interface)]"
                    >
                        <caption class="text-start font-semibold pb-4" id="comparison-caption">
                            逐项事实与变化对比
                        </caption>
                        <thead>
                            <tr>
                                <th
                                    class="text-start [vertical-align:top] border-theme break-anywhere font-semibold p-4 [thead_&:is(th)]:bg-surface [&:is(th):first-child]:w-[8rem] [&:is(th):nth-child(2)]:w-[11rem]"
                                    scope="col"
                                >
                                    比较维度
                                </th>
                                <th
                                    class="text-start [vertical-align:top] border-theme break-anywhere font-semibold p-4 [thead_&:is(th)]:bg-surface [&:is(th):first-child]:w-[8rem] [&:is(th):nth-child(2)]:w-[11rem]"
                                    scope="col"
                                >
                                    分类与重要性
                                </th>
                                <th
                                    class="text-start [vertical-align:top] border-theme break-anywhere font-semibold p-4 [thead_&:is(th)]:bg-surface [&:is(th):first-child]:w-[8rem] [&:is(th):nth-child(2)]:w-[11rem]"
                                    scope="col"
                                >
                                    旧值 · 基线
                                </th>
                                <th
                                    class="text-start [vertical-align:top] border-theme break-anywhere font-semibold p-4 [thead_&:is(th)]:bg-surface [&:is(th):first-child]:w-[8rem] [&:is(th):nth-child(2)]:w-[11rem]"
                                    scope="col"
                                >
                                    本次观测 · 新值
                                </th>
                            </tr>
                        </thead>
                        <tbody v-for="group in model.groups" :key="group.kind">
                            <tr
                                v-for="entry in group.entries"
                                :key="entry.record.id"
                                :id="`comparison-change-${entry.record.id}`"
                            >
                                <th
                                    scope="row"
                                    class="fact-key text-start [vertical-align:top] border-theme break-anywhere font-semibold whitespace-pre-wrap p-4 [thead_&:is(th)]:bg-surface [&:is(th):first-child]:w-[8rem] [&:is(th):nth-child(2)]:w-[11rem]"
                                >
                                    {{ entry.record.factKey }}
                                </th>
                                <td
                                    class="text-start [vertical-align:top] border-theme break-anywhere p-4"
                                >
                                    <div class="cell-content report-grid">
                                        <p class="change-kind font-semibold m-0">
                                            {{ group.title }}
                                        </p>
                                        <p class="m-0">
                                            重要性标记：{{
                                                entry.record.important ? '重要' : '未标记为重要'
                                            }}
                                        </p>
                                        <p class="original-text whitespace-pre-wrap m-0">
                                            {{ entry.record.reason }}
                                        </p>
                                    </div>
                                </td>
                                <td
                                    class="old-side text-start [vertical-align:top] border-theme break-anywhere p-4"
                                >
                                    <div class="cell-content report-grid">
                                        <p class="original-text whitespace-pre-wrap m-0">
                                            {{ entry.record.oldValue ?? '未提供旧值' }}
                                        </p>
                                        <p
                                            v-if="entry.missingOldEvidence"
                                            class="scova-warning m-0"
                                        >
                                            旧值缺少可核对引用，这项比较仍待核验。
                                        </p>
                                        <div
                                            v-for="evidence in entry.oldEvidence"
                                            :id="`comparison-${entry.record.id}-old-${evidence.id}`"
                                            :key="evidence.id"
                                            class="table-citation min-w-0 [&.table-citation_*]:[font-family:var(--scova-font-interface)] [&.table-citation_summary]:(min-h-11 box-border pl-3 pr-3) [&.table-citation_a]:(min-h-11 box-border) [&.table-citation_.evidence-body]:(pl-3 pr-3) [&.table-citation_blockquote]:(pl-3 pr-3)"
                                        >
                                            <evidence-link :evidence="evidence" />
                                        </div>
                                        <p class="m-0" v-if="!entry.oldEvidence.length">
                                            未提供旧侧引用。
                                        </p>
                                    </div>
                                </td>
                                <td
                                    class="new-side text-start [vertical-align:top] border-theme break-anywhere p-4"
                                >
                                    <div class="cell-content report-grid">
                                        <p class="original-text whitespace-pre-wrap m-0">
                                            {{ entry.record.newValue ?? '未提供新值' }}
                                        </p>
                                        <div
                                            v-for="evidence in entry.newEvidence"
                                            :id="`comparison-${entry.record.id}-new-${evidence.id}`"
                                            :key="evidence.id"
                                            class="table-citation min-w-0 [&.table-citation_*]:[font-family:var(--scova-font-interface)] [&.table-citation_summary]:(min-h-11 box-border pl-3 pr-3) [&.table-citation_a]:(min-h-11 box-border) [&.table-citation_.evidence-body]:(pl-3 pr-3) [&.table-citation_blockquote]:(pl-3 pr-3)"
                                        >
                                            <evidence-link :evidence="evidence" />
                                        </div>
                                        <p class="m-0" v-if="!entry.newEvidence.length">
                                            未提供本次观测引用。
                                        </p>
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
import EvidenceLink from '@/components/reports/EvidenceLink.vue';
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
