<template>
    <report-frame :report="report" format="list" class="report-topic-list">
        <template #format-notice><report-format-banner format="list" :report="report" /></template>
        <report-changes v-if="showChanges" :report="report" />
        <section
            v-for="section in sections"
            :key="section.kind"
            class="topic-section"
            :aria-labelledby="`claims-${section.kind}`"
        >
            <header class="topic-heading">
                <h3 :id="`claims-${section.kind}`" class="scova-content-title">
                    {{ section.title }}
                </h3>
                <span class="scova-interface">{{ section.claims.length }} 项</span>
            </header>
            <ul class="topic-items" role="list">
                <li v-for="(claim, index) in section.claims" :key="claim.id">
                    <span class="topic-number scova-interface" aria-hidden="true">{{
                        String(index + 1).padStart(2, '0')
                    }}</span>
                    <report-claim :report="report" :claim="claim" />
                </li>
            </ul>
        </section>
    </report-frame>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import ReportFrame from '@/components/reports/ReportFrame.vue';
import ReportClaim from '@/components/reports/ReportClaim.vue';
import ReportChanges from '@/components/reports/ReportChanges.vue';
import ReportFormatBanner from '@/components/reports/ReportFormatBanner.vue';
import { reportSections } from '@/composables/useReport';
const props = withDefaults(defineProps<{ report: Report; showChanges?: boolean }>(), {
    showChanges: true,
});
const sections = computed(() => reportSections(props.report));
</script>

<style scoped>
.topic-section {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
}
h3 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
}
.topic-items {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    gap: 1rem;
    margin: 0;
    padding: 0;
    min-inline-size: 0;
    list-style: none;
}
li {
    padding: 1rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--scova-selected) 28%, var(--scova-surface));
    min-inline-size: 0;
}
.topic-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 1rem;
}
.topic-heading span,
.topic-number {
    color: var(--scova-muted);
}
.topic-number {
    display: block;
    margin-block-end: 1rem;
    font-size: 1.25rem;
    font-variant-numeric: tabular-nums;
}
@media (max-width: 40rem) {
    li {
        padding-inline: 0;
        border-inline: 0;
        border-radius: 0;
        background: transparent;
    }
}
</style>
