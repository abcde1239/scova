<template>
    <details class="evidence-source-group scova-citation-tools">
        <summary>
            <span class="source-symbol" aria-hidden="true"><app-icon name="source" /></span>
            <span class="source-label">{{ evidence[0]?.title }}</span>
            <span class="source-count">{{ quotes.length }}条引用</span>
            <span class="source-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="source-quotes">
            <div
                v-for="(quote, index) in quotes"
                :id="`${anchorPrefix}${quote.evidence.id}`"
                :key="quote.evidence.id"
                class="source-quote evidence-entry"
                tabindex="-1"
            >
                <span
                    v-for="id in quote.ids.filter((id) => id !== quote.evidence.id)"
                    :id="`${anchorPrefix}${id}`"
                    :key="id"
                    class="evidence-entry"
                    tabindex="-1"
                />
                <span class="quote-number scova-interface">引用 {{ index + 1 }}</span>
                <evidence-citation :evidence="quote.evidence" embedded />
            </div>
        </div>
    </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Evidence } from '@scova/models';
import AppIcon from '@/components/common/AppIcon.vue';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
import { distinctEvidenceQuotes } from '@/utils/evidence-groups';
const props = withDefaults(defineProps<{ evidence: Evidence[]; anchorPrefix?: string }>(), {
    anchorPrefix: 'evidence-',
});
const quotes = computed(() => distinctEvidenceQuotes(props.evidence));
</script>

<style scoped>
.evidence-source-group {
    min-inline-size: 0;
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 45%, transparent);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--scova-selected) 16%, var(--scova-surface));
    overflow-wrap: anywhere;
}
summary {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.875rem 1rem;
    min-block-size: 2.75rem;
    list-style: none;
    cursor: pointer;
}
summary::-webkit-details-marker {
    display: none;
}
.source-symbol {
    display: flex;
    flex: none;
    color: var(--scova-primary);
}
.source-label {
    flex: 1;
    min-inline-size: 0;
    font-weight: 500;
    line-height: 1.6;
}
.source-count {
    flex: none;
    color: var(--scova-muted);
    font-size: 0.8125rem;
}
.source-chevron {
    flex: none;
    color: var(--scova-muted);
    transition: transform 180ms ease;
}
details[open] .source-chevron {
    transform: rotate(180deg);
}
.source-quotes {
    display: grid;
    gap: 1rem;
    padding: 0 1rem 1rem;
    min-inline-size: 0;
}
.source-quote {
    display: grid;
    gap: 0.375rem;
    min-inline-size: 0;
}
.quote-number {
    color: var(--scova-muted);
    font-size: 0.8125rem;
}
.evidence-entry {
    scroll-margin-block-start: 6rem;
}
summary:focus-visible,
.evidence-entry:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.125rem;
}
@media (prefers-reduced-motion: reduce) {
    .source-chevron {
        transition: none;
    }
}
@media (max-width: 40rem) {
    summary {
        padding: 0.75rem;
    }
    .source-quotes {
        padding-inline: 0.375rem;
    }
}
</style>
