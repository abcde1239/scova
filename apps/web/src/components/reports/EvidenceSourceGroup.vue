<template>
    <details
        class="evidence-source-group scova-citation-tools min-w-0 [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_45%,_transparent)] rounded-3 [background:color-mix(in_srgb,_var(--scova-selected)_16%,_var(--scova-surface))] break-anywhere"
    >
        <summary
            class="flex items-center gap-2.5 min-h-11 list-none cursor-pointer py-3.5 px-4 [&:is(summary)::-webkit-details-marker]:hidden focus-visible:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem]) [@media(max-width:_40rem)]:p-3"
        >
            <span class="source-symbol flex flex-none text-primary" aria-hidden="true"
                ><app-icon name="source"
            /></span>
            <span class="source-label flex-1 min-w-0 font-medium leading-[1.6]">{{
                evidence[0]?.title
            }}</span>
            <span class="source-count flex-none text-muted text-[0.8125rem]"
                >{{ quotes.length }}条引用</span
            >
            <span
                class="source-chevron flex-none text-muted [transition:transform_180ms_ease] [details[open]_&.source-chevron]:[transform:rotate(180deg)] [@media(prefers-reduced-motion:_reduce)]:[transition:none]"
                aria-hidden="true"
                >⌄</span
            >
        </summary>
        <div
            class="source-quotes layout-stack pt-0 pb-4 px-4 [@media(max-width:_40rem)]:(pl-1.5 pr-1.5)"
        >
            <div
                v-for="(quote, index) in quotes"
                :id="`${anchorPrefix}${quote.evidence.id}`"
                :key="quote.evidence.id"
                class="source-quote evidence-entry layout-grid gap-1.5 [scroll-margin-block-start:6rem] focus-visible:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem])"
                tabindex="-1"
            >
                <span
                    v-for="id in quote.ids.filter((id) => id !== quote.evidence.id)"
                    :id="`${anchorPrefix}${id}`"
                    :key="id"
                    class="evidence-entry [scroll-margin-block-start:6rem] focus-visible:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem])"
                    tabindex="-1"
                />
                <span class="quote-number scova-interface text-muted text-[0.8125rem]"
                    >引用 {{ index + 1 }}</span
                >
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
