<template>
    <report-frame :report="report" class="report-topic-list">
        <section
            v-for="section in sections"
            :key="section.kind"
            class="topic-section"
            :aria-labelledby="`claims-${section.kind}`"
        >
            <h3 :id="`claims-${section.kind}`" class="scova-content-title">{{ section.title }}</h3>
            <ul class="topic-items" role="list">
                <li v-for="claim in section.claims" :key="claim.id">
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
import { reportSections } from '@/composables/useReport';
const props = defineProps<{ report: Report }>();
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
    margin: 0;
    padding-inline-start: 1.5rem;
    min-inline-size: 0;
}
li {
    padding-inline-start: 0.25rem;
    min-inline-size: 0;
}
li + li {
    margin-block-start: 1.5rem;
    padding-block-start: 1.5rem;
    border-block-start: 0.0625rem solid var(--scova-border);
}
li::marker {
    color: var(--scova-muted);
}
@media (max-width: 40rem) {
    .topic-items {
        padding-inline-start: 0;
        list-style: none;
    }
    li {
        padding-inline-start: 0;
    }
}
</style>
