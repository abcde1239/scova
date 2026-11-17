<template>
    <div
        :id="`claim-${claim.id}`"
        class="claim report-grid [.claim_+_&.claim]:(pt-6 [border-top:0.0625rem_solid_var(--scova-border)])"
        :class="{ 'document-claim': compact }"
    >
        <model-answer-tag v-if="claim.kind === 'model_answer'" />
        <p
            v-for="(paragraph, index) in paragraphs"
            :key="index"
            class="scova-reading claim-text whitespace-pre-wrap m-0"
        >
            <template v-if="index === 0 && leadSentence"
                ><strong class="claim-lead font-semibold">{{ leadSentence }}</strong
                >{{ paragraph.slice(leadSentence.length) }}</template
            >
            <template v-else>{{ paragraph }}</template>
        </p>
        <p v-if="claim.kind === 'insufficient'" class="scova-warning scova-interface m-0">
            <strong>待核实，尚不能作为已确认结论</strong>
        </p>
        <p
            v-if="claim.kind === 'insufficient' || claim.kind === 'conflict'"
            class="confidence scova-interface scova-warning m-0"
        >
            {{ claim.confidenceLabel }}
        </p>
    </div>
</template>

<script setup lang="ts">
import type { Claim, Report } from '@scova/models';
import { computed } from 'vue';
import ModelAnswerTag from '@/components/reports/ModelAnswerTag.vue';
const props = withDefaults(
    defineProps<{
        report: Report;
        claim: Claim;
        showEvidence?: boolean;
        compact?: boolean;
        /** Display-only emphasis of the opening sentence; the saved text is unchanged. */
        lead?: boolean;
    }>(),
    {
        showEvidence: true,
        compact: false,
        lead: false,
    },
);
// Honor the author's paragraph boundaries without rewriting saved statements.
const paragraphs = computed(() => props.claim.text.split(/\r?\n[\t ]*\r?\n/));
const leadSentence = computed(() => {
    if (!props.lead) return '';
    const first = paragraphs.value[0] ?? '';
    const match = /^[^。！？!?]+[。！？!?]/u.exec(first);
    // Emphasize only a true sentence that leaves more text after it.
    return match && match[0].length < first.length ? match[0] : '';
});
</script>
