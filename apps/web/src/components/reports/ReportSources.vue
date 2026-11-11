<template>
    <section id="saved-evidence" class="evidence-appendix" aria-labelledby="saved-evidence-title">
        <h3 id="saved-evidence-title" class="scova-content-title">来源与保存引用</h3>
        <p class="scova-interface">
            每份来源集中保存引用，展开即可核对原文；不同保存版本分别列出。
        </p>
        <evidence-source-group
            v-for="group in groups"
            :key="group.key"
            :evidence="group.evidence"
        />
    </section>
</template>

<script setup lang="ts">
import type { Report } from '@scova/models';
import { computed } from 'vue';
import EvidenceSourceGroup from '@/components/reports/EvidenceSourceGroup.vue';
import { groupEvidence } from '@/utils/evidence-groups';
const props = defineProps<{ report: Report }>();
const groups = computed(() => groupEvidence(props.report.evidence));
</script>

<style scoped>
.evidence-appendix {
    display: grid;
    gap: 0.875rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
    padding-block: 1rem 0;
    border-block-start: 0.0625rem solid var(--scova-border);
}
h3,
p {
    margin: 0;
}
h3 {
    font-size: 1.25rem;
    font-weight: 600;
}
.evidence-appendix,
.evidence-appendix > h3,
.evidence-entry {
    scroll-margin-block-start: 6rem;
}
.evidence-entry {
    min-inline-size: 0;
}
h3:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
