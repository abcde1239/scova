<template>
    <details
        class="evidence-source-group scova-citation-tools min-w-0 [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_45%,_transparent)] rounded-3 [background:color-mix(in_srgb,_var(--scova-selected)_16%,_var(--scova-surface))] break-anywhere"
    >
        <summary
            class="source-disclosure-control flex items-center gap-2.5 min-h-11 list-none py-3.5 px-4 [&:is(summary)::-webkit-details-marker]:hidden [@media(max-width:_40rem)]:p-3"
        >
            <span class="source-symbol flex flex-none text-primary" aria-hidden="true"
                ><app-icon name="report"
            /></span>
            <span class="source-label flex-1 min-w-0 font-medium leading-[1.6]">{{
                evidence[0]?.title
            }}</span>
            <span class="source-count flex-none text-muted text-[0.8125rem]"
                >{{ quoteCount }}条引用<span v-if="versions.length > 1">
                    · {{ versions.length }}个版本</span
                ></span
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
            <a
                v-if="link"
                :href="link"
                target="_blank"
                rel="noopener noreferrer"
                class="source-page-link external-link source-inline-action"
            >
                打开网页（新窗口）<app-icon name="source" />
            </a>
            <section
                v-for="(version, versionIndex) in versions"
                :key="version.key"
                class="source-version layout-stack"
            >
                <h4 v-if="versions.length > 1" class="scova-interface font-medium m-0">
                    保存版本 {{ versionIndex + 1 }} ·
                    <time :datetime="version.observedAt">{{ version.observedAt }}</time>
                </h4>
                <div
                    v-for="(quote, index) in version.quotes"
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
                    <evidence-citation :evidence="quote.evidence" embedded hide-source-link />
                </div>
            </section>
        </div>
    </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Evidence } from '@scova/models';
import AppIcon from '@/components/common/AppIcon.vue';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
import {
    distinctEvidenceQuotes,
    evidencePageUrl,
    groupEvidenceVersions,
} from '@/utils/evidence-groups';
import { sourceLink } from '@/composables/useReport';
const props = withDefaults(defineProps<{ evidence: Evidence[]; anchorPrefix?: string }>(), {
    anchorPrefix: 'evidence-',
});
const versions = computed(() =>
    groupEvidenceVersions(props.evidence).map((version) => ({
        ...version,
        quotes: distinctEvidenceQuotes(version.evidence),
    })),
);
const quoteCount = computed(() =>
    versions.value.reduce((sum, version) => sum + version.quotes.length, 0),
);
const link = computed(() =>
    props.evidence[0] ? sourceLink(evidencePageUrl(props.evidence[0])) : undefined,
);
</script>

<style scoped>
.evidence-source-group[open] {
    @apply [border-color:color-mix(in_srgb,_var(--scova-primary)_45%,_var(--scova-border))];
}
.evidence-source-group[open] > summary {
    @apply rounded-b-0;
}
/* Give source titles their own row when large text leaves little inline space. */
@media (max-width: 40rem) {
    .evidence-source-group > summary {
        @apply grid grid-cols-[minmax(0,_1fr)_auto] gap-y-1.5;
    }
    .source-symbol {
        @apply hidden;
    }
    .source-label {
        @apply col-span-2 w-full;
    }
    .source-count {
        @apply row-start-2;
    }
    .source-chevron {
        @apply row-start-2 justify-self-end;
    }
}
</style>
