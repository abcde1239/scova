<template>
    <report-frame :report="report" format="list" class="report-topic-list">
        <template #format-notice><report-format-banner format="list" :report="report" /></template>
        <report-changes v-if="showChanges" :report="report" />
        <section
            v-for="section in sections"
            :key="section.kind"
            class="topic-section layout-grid gap-5"
            :aria-labelledby="`claims-${section.kind}`"
        >
            <header class="topic-heading flex flex-wrap items-baseline gap-[0.5rem_1rem]">
                <h3
                    :id="`claims-${section.kind}`"
                    class="scova-content-title text-[1.25rem] font-semibold m-0"
                >
                    {{ section.title }}
                </h3>
                <span class="scova-interface [.topic-heading_&:is(span)]:text-muted"
                    >{{ section.claims.length }} 项</span
                >
            </header>
            <ul
                class="topic-items layout-stack grid-cols-[repeat(auto-fit,_minmax(min(100%,_20rem),_1fr))] list-none m-0 p-0"
                role="list"
            >
                <li
                    class="border-theme rounded-3 [background:color-mix(in_srgb,_var(--scova-selected)_28%,_var(--scova-surface))] min-w-0 p-4 [@media(max-width:_40rem)]:(pl-0 pr-0 [border-inline:0] rounded-0 bg-transparent)"
                    v-for="(claim, index) in section.claims"
                    :key="claim.id"
                >
                    <span
                        class="topic-number scova-interface text-muted block mb-4 text-[1.25rem] [font-variant-numeric:tabular-nums]"
                        aria-hidden="true"
                        >{{ String(index + 1).padStart(2, '0') }}</span
                    >
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
