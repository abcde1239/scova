<template>
    <report-frame
        :report="report"
        :show-sources="showSources"
        :show-changes="showChanges"
        format="comparison"
        class="report-comparison"
    >
        <template #format-notice
            ><report-format-banner format="comparison" :report="report"
        /></template>
        <report-findings-table v-if="!report.coverage.reportValue" :report="report" />
    </report-frame>
</template>
<script setup lang="ts">
import type { Report } from '@scova/models';
import ReportFrame from '@/component/reports/ReportFrame.vue';
import ReportFindingsTable from '@/component/reports/ReportFindingsTable.vue';
import ReportFormatBanner from '@/component/reports/ReportFormatBanner.vue';
withDefaults(defineProps<{ report: Report; showChanges?: boolean; showSources?: boolean }>(), {
    showChanges: true,
    showSources: true,
});
</script>
