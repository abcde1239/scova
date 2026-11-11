<template>
    <report-frame :report="report" summary-title="简报概述" class="report-brief">
        <report-changes v-if="showChanges" :report="report" />
        <section
            v-for="section in sections"
            :key="section.kind"
            :aria-labelledby="`claims-${section.kind}`"
            class="claim-section layout-grid gap-5"
        >
            <h3
                :id="`claims-${section.kind}`"
                class="scova-content-title text-[1.25rem] font-semibold m-0"
            >
                {{ section.title }}
            </h3>
            <report-claim
                v-for="claim in section.claims"
                :key="claim.id"
                :report="report"
                :claim="claim"
            />
        </section>
    </report-frame>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import ReportFrame from '@/components/reports/ReportFrame.vue';
import ReportClaim from '@/components/reports/ReportClaim.vue';
import ReportChanges from '@/components/reports/ReportChanges.vue';
import { reportSections } from '@/composables/useReport';
const props = withDefaults(defineProps<{ report: Report; showChanges?: boolean }>(), {
    showChanges: true,
});
const sections = computed(() => reportSections(props.report));
</script>
