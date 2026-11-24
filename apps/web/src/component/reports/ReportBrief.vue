<template>
    <report-frame
        :report="report"
        :show-sources="showSources"
        :show-changes="showChanges"
        :workspace="!!$slots['section-navigation']"
        summary-title="简报概述"
        class="report-brief"
    >
        <template v-if="$slots['section-navigation']" #after-summary
            ><slot name="section-navigation"
        /></template>
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
import ReportFrame from '@/component/reports/ReportFrame.vue';
import ReportClaim from '@/component/reports/ReportClaim.vue';
import { reportSections } from '@/utils/report/summary';
const props = withDefaults(
    defineProps<{ report: Report; showChanges?: boolean; showSources?: boolean }>(),
    {
        showChanges: true,
        showSources: true,
    },
);
const sections = computed(() => reportSections(props.report));
</script>
