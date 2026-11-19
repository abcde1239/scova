<template>
    <section
        class="report-changes report-grid scova-interface"
        :style="reading.variables"
        aria-labelledby="report-changes-title"
    >
        <div class="comparison-summary flex flex-wrap items-center gap-x-4 gap-y-1">
            <h3
                id="report-changes-title"
                class="text-[1rem] font-semibold m-0"
                :class="{ 'scova-partial': summary.state === 'inconclusive' }"
            >
                {{ summary.title }}
            </h3>
            <span v-if="summary.message">{{ summary.message }}</span>
            <a
                v-if="report.baseline"
                class="navigation-link"
                :href="`/reports/${report.baseline.reportId}`"
                >对比 {{ localTaskTime(report.baseline.publishedAt) }} 的报告<app-icon
                    name="chevron"
            /></a>
            <a
                v-else-if="report.baselineRunId"
                class="navigation-link"
                :href="`/runs/${report.baselineRunId}`"
                >上次执行<app-icon name="chevron"
            /></a>
            <a
                v-if="summary.title === '未设为比较起点'"
                class="navigation-link"
                href="#coverage-title"
                >查看缺口<app-icon name="chevron"
            /></a>
        </div>
        <report-change-entry
            v-for="entry in primary"
            :key="entry.record.id"
            :entry="entry"
            :report="report"
        />
        <details v-if="other.length">
            <summary class="source-disclosure-control min-h-11 py-2 px-2">
                其他 {{ other.length }} 项
            </summary>
            <div class="layout-grid gap-4 pt-3">
                <report-change-entry
                    v-for="entry in other"
                    :key="entry.record.id"
                    :entry="entry"
                    :report="report"
                />
            </div>
        </details>
    </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import AppIcon from '@/component/common/AppIcon.vue';
import ReportChangeEntry from '@/component/reports/ReportChangeEntry.vue';
import { changeSummary, mapReportChanges } from '@/utils/report/changes';
import { useReadingTypography } from '@/composable/useReadingTypography';
import { localTaskTime } from '@/composable/useTasks';
const { reading } = useReadingTypography();
const props = defineProps<{ report: Report }>();
const groups = computed(() => mapReportChanges(props.report));
const primary = computed(() =>
    groups.value
        .filter((group) => ['changed', 'new', 'uncertain'].includes(group.kind))
        .flatMap((group) => group.entries),
);
const other = computed(() =>
    groups.value
        .filter((group) =>
            ['duplicate', 'duplicate_candidate', 'non_material'].includes(group.kind),
        )
        .flatMap((group) => group.entries),
);
const summary = computed(() => changeSummary(props.report));
</script>
