<template>
    <div
        :id="`claim-${claim.id}`"
        class="claim report-grid [.claim_+_&.claim]:(pt-6 [border-top:0.0625rem_solid_var(--scova-border)])"
    >
        <p class="scova-reading claim-text whitespace-pre-wrap m-0">{{ claim.text }}</p>
        <p v-if="claim.kind === 'insufficient'" class="scova-warning scova-interface m-0">
            <strong>待核实，尚不能作为已确认结论</strong>
        </p>
        <details
            v-if="claim.kind === 'fact' || claim.kind === 'inference'"
            class="confidence-details scova-interface text-muted"
        >
            <summary class="[.confidence-details_&:is(summary)]:cursor-pointer">
                {{ claim.kind === 'fact' ? '来源事实' : '来源归纳' }} · 查看说明
            </summary>
            <p class="confidence text-muted m-0 [.confidence-details_&:is(p)]:mt-2">
                {{ `证据说明：${claim.confidenceLabel}` }}
            </p>
        </details>
        <p
            v-else
            class="confidence scova-interface text-muted m-0 [&.claim]:(grid gap-5 min-w-0 break-anywhere) [.claim_+_&.claim]:(pt-6 [border-top:0.0625rem_solid_var(--scova-border)])"
            :class="{ 'scova-warning': claim.kind === 'insufficient' || claim.kind === 'conflict' }"
        >
            {{ `证据说明：${claim.confidenceLabel}` }}
        </p>
        <nav
            v-if="showEvidence && evidence.length"
            class="citations report-grid"
            aria-label="本条内容的来源"
        >
            <a
                v-for="item in evidence"
                :id="`claim-${claim.id}-evidence-${item.id}`"
                :key="item.id"
                class="citation min-w-0 min-h-11 inline-flex items-center text-primary underline-offset-[0.2em] keyboard-focus-wide [@media(max-width:_40rem)]:[&.citation_summary]:(pl-2 pr-2)"
                :href="`#evidence-${item.id}`"
            >
                来源 {{ report.evidence.findIndex((entry) => entry.id === item.id) + 1 }} ·
                {{ item.title }}
            </a>
        </nav>
        <p v-else-if="showEvidence" class="scova-interface m-0">
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
