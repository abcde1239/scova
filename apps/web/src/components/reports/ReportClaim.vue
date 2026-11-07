<template>
    <div :id="`claim-${claim.id}`" class="claim">
        <p class="scova-reading claim-text">{{ claim.text }}</p>
        <p v-if="claim.kind === 'insufficient'" class="scova-warning scova-interface">
            <strong>需要补充材料</strong> · 这条线索的来源依据较少，详情见下方引用。
        </p>
        <p
            class="confidence scova-interface"
            :class="{ 'scova-warning': claim.kind === 'insufficient' || claim.kind === 'conflict' }"
        >
            {{ `证据说明：${claim.confidenceLabel}` }}
        </p>
        <div v-if="showEvidence && evidence.length" class="citations">
            <div
                v-for="item in evidence"
                :id="`claim-${claim.id}-evidence-${item.id}`"
                :key="item.id"
                class="citation"
            >
                <evidence-citation :evidence="item" />
            </div>
        </div>
        <p v-else-if="showEvidence" class="scova-interface">
            这条内容暂时没有可展开的直接引用，保留为线索。
        </p>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Claim, Report } from '@scova/models';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
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
