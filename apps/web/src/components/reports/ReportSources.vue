<template>
    <section id="saved-evidence" class="evidence-appendix" aria-labelledby="saved-evidence-title">
        <h3 id="saved-evidence-title" class="scova-content-title">来源与保存引用</h3>
        <p class="scova-interface">
            以下按报告保存顺序列出可访问证据；孤立来源不会被猜测归入某条结论。
        </p>
        <div
            v-for="evidence in report.evidence"
            :id="`evidence-${evidence.id}`"
            :key="evidence.id"
            class="evidence-entry"
        >
            <evidence-citation :evidence="evidence" />
        </div>
    </section>
</template>

<script setup lang="ts">
import type { Report } from '@scova/models';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
defineProps<{ report: Report }>();
</script>

<style scoped>
.evidence-appendix {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
    padding-block: 2rem;
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
@media (max-width: 40rem) {
    .evidence-entry :deep(summary),
    .evidence-entry :deep(.evidence-body),
    .evidence-entry :deep(blockquote) {
        padding-inline: 0.5rem;
    }
}
</style>
