<template>
    <section
        id="saved-evidence"
        class="evidence-appendix layout-grid gap-3.5 break-anywhere pt-4 pb-0 [border-top:0.0625rem_solid_var(--scova-border)] [scroll-margin-block-start:6rem]"
        aria-labelledby="saved-evidence-title"
    >
        <h3
            id="saved-evidence-title"
            class="scova-content-title text-[1.25rem] font-semibold m-0 keyboard-focus-wide [.evidence-appendix_>_&:is(h3)]:[scroll-margin-block-start:6rem]"
        >
            来源与保存引用
        </h3>
        <evidence-source-group
            v-for="group in groups"
            :key="group.key"
            :evidence="group.evidence"
        />
        <details v-if="report.claims.length" class="claim-provenance scova-interface">
            <summary class="source-disclosure-control min-h-11 py-2 px-2">结论依据</summary>
            <ol class="layout-grid gap-4 m-0 pl-5">
                <li
                    :id="`claim-support-${claim.id}`"
                    v-for="(claim, index) in report.claims"
                    :key="claim.id"
                    class="layout-grid gap-1.5"
                >
                    <a
                        v-if="claimVisible(index)"
                        class="reference-link source-inline-action justify-self-start"
                        :href="`#claim-${claim.id}`"
                        >结论 {{ index + 1 }}</a
                    >
                    <span v-else>材料 {{ index + 1 }}</span>
                    <model-answer-tag v-if="claim.kind === 'model_answer'" />
                    <p v-else class="m-0">
                        {{ claimLabels[claim.kind] }} · {{ claim.confidenceLabel }}
                    </p>
                    <div class="flex flex-wrap gap-3">
                        <a
                            v-for="evidenceId in claim.evidenceIds"
                            :id="`claim-${claim.id}-evidence-${evidenceId}`"
                            :key="evidenceId"
                            :href="`#evidence-${evidenceId}`"
                            class="reference-link source-inline-action"
                            >来源 {{ sourceNumber(evidenceId) }}</a
                        >
                    </div>
                </li>
            </ol>
        </details>
    </section>
</template>

<script setup lang="ts">
import type { Report } from '@scova/models';
import { computed } from 'vue';
import EvidenceSourceGroup from '@/component/reports/EvidenceSourceGroup.vue';
import { groupEvidence } from '@/utils/report/sources';
import ModelAnswerTag from '@/component/reports/ModelAnswerTag.vue';
import { claimLabels } from '@/utils/report/summary';
const props = defineProps<{ report: Report }>();
const groups = computed(() => groupEvidence(props.report.evidence));
const sourceNumber = (id: string) =>
    groups.value.findIndex((group) => group.evidence.some((entry) => entry.id === id)) + 1;
const claimVisible = (index: number) =>
    props.report.claims[index]?.kind === 'insufficient' ||
    !props.report.coverage.reportValue ||
    props.report.coverage.reportValue.selections.find((entry) => entry.claimIndex === index)
        ?.placement !== 'omitted';
</script>
