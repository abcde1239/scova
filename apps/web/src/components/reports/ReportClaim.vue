<template>
    <div :id="`claim-${claim.id}`" class="claim">
        <p class="scova-reading claim-text">{{ claim.text }}</p>
        <p class="confidence scova-interface">证据说明：{{ claim.confidenceLabel }}</p>
        <div v-if="evidence.length" class="citations">
            <div
                v-for="item in evidence"
                :id="`claim-${claim.id}-evidence-${item.id}`"
                :key="item.id"
                class="citation"
            >
                <evidence-citation :evidence="item" />
            </div>
        </div>
        <p v-else class="scova-interface">这条结论未提供直接引用，应结合证据不足说明阅读。</p>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Claim, Report } from '@scova/models';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
import { claimEvidence } from '@/composables/useReport';
const props = defineProps<{ report: Report; claim: Claim }>();
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
.confidence {
    color: var(--scova-muted);
}
@media (max-width: 40rem) {
    .citation :deep(summary),
    .citation :deep(.evidence-body),
    .citation :deep(blockquote) {
        padding-inline: 0.5rem;
    }
}
</style>
