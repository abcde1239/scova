<template>
    <report-frame :report="report" summary-title="简报概述" class="report-brief">
        <template #format-notice>
            <p v-if="report.format !== 'brief'" class="scova-interface">
                当前按基础简报展示结构化结论与引用；尚不提供原报告格式的专属布局。
            </p>
        </template>
        <section
            v-for="section in sections"
            :key="section.kind"
            :aria-labelledby="`claims-${section.kind}`"
            class="claim-section"
        >
            <h3 :id="`claims-${section.kind}`" class="scova-content-title">{{ section.title }}</h3>
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
import { reportSections } from '@/composables/useReport';
const props = defineProps<{ report: Report }>();
const sections = computed(() => reportSections(props.report));
</script>

<style scoped>
.claim-section {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
}
h3 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
}
p {
    margin: 0;
}
</style>
