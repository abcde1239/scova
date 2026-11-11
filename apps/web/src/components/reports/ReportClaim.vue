<template>
    <div :id="`claim-${claim.id}`" class="claim">
        <p class="scova-reading claim-text">{{ claim.text }}</p>
        <p v-if="claim.kind === 'insufficient'" class="scova-warning scova-interface">
            <strong>待核实，尚不能作为已确认结论</strong>
        </p>
        <details
            v-if="claim.kind === 'fact' || claim.kind === 'inference'"
            class="confidence-details scova-interface"
        >
            <summary>{{ claim.kind === 'fact' ? '来源事实' : '来源归纳' }} · 查看说明</summary>
            <p class="confidence">{{ `证据说明：${claim.confidenceLabel}` }}</p>
        </details>
        <p
            v-else
            class="confidence scova-interface"
            :class="{ 'scova-warning': claim.kind === 'insufficient' || claim.kind === 'conflict' }"
        >
            {{ `证据说明：${claim.confidenceLabel}` }}
        </p>
        <nav v-if="showEvidence && evidence.length" class="citations" aria-label="本条内容的来源">
            <a
                v-for="item in evidence"
                :id="`claim-${claim.id}-evidence-${item.id}`"
                :key="item.id"
                class="citation"
                :href="`#evidence-${item.id}`"
            >
                来源 {{ report.evidence.findIndex((entry) => entry.id === item.id) + 1 }} ·
                {{ item.title }}
            </a>
        </nav>
        <p v-else-if="showEvidence" class="scova-interface">
            这条内容暂时没有可展开的直接引用，保留为线索。
        </p>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Claim, Report } from '@scova/models';
import { claimEvidence } from '@/composables/useReport';
const props = withDefaults(
    defineProps<{ report: Report; claim: Claim; showEvidence?: boolean }>(),
    {
        showEvidence: true,
    },
);
const evidence = computed(() => claimEvidence(props.report, props.claim));
</script>

<style scoped>
.claim,
.citations {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.citation {
    min-inline-size: 0;
    min-block-size: 2.75rem;
    display: inline-flex;
    align-items: center;
    color: var(--scova-primary);
    text-underline-offset: 0.2em;
}
.citation:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
p {
    margin: 0;
}
.claim + .claim {
    padding-block-start: 1.5rem;
    border-block-start: 0.0625rem solid var(--scova-border);
}
.claim-text {
    white-space: pre-wrap;
}
.confidence,
.confidence-details {
    color: var(--scova-muted);
}
.confidence-details summary {
    cursor: pointer;
}
.confidence-details p {
    margin-block-start: 0.5rem;
}
@media (max-width: 40rem) {
    .citation :deep(summary) {
        padding-inline: 0.5rem;
    }
}
</style>
