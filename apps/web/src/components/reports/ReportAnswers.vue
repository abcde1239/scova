<template>
    <section v-if="value" class="answers" aria-labelledby="answers-title">
        <h3 id="answers-title" class="scova-content-title">问题与回答</h3>
        <p class="scova-interface">回答按问题整理；展开来源可查看原文引用和适用条件。</p>
        <section
            v-for="question in groupedQuestions"
            :id="`question-${question.id}`"
            :key="question.id"
            class="answer"
            :aria-labelledby="`question-title-${question.id}`"
        >
            <h4 :id="`question-title-${question.id}`" class="scova-content-title">
                {{ question.text }}
            </h4>
            <p class="scova-interface">
                {{ question.priority === 'core' ? '核心问题' : '补充问题' }} ·
                {{ statusLabels[question.status] }}
            </p>
            <div
                v-for="(group, groupIndex) in question.groups"
                :key="group.key"
                class="answer-source"
            >
                <template v-for="index in group.indexes" :key="index">
                    <template v-if="report.claims[index]">
                        <template v-if="firstQuestion(index) === question.id">
                            <report-claim
                                :report="report"
                                :claim="report.claims[index]!"
                                :show-evidence="false"
                            />
                            <p
                                v-if="group.indexes.length > 1"
                                class="claim-sources scova-interface"
                            >
                                <a
                                    v-for="id in report.claims[index]!.evidenceIds"
                                    :key="id"
                                    :href="`#answer-${question.id}-${groupIndex}-evidence-${id}`"
                                    >引用
                                    {{
                                        group.evidence.findIndex((entry) => entry.id === id) + 1
                                    }}</a
                                >
                            </p>
                            <p
                                v-if="selection(index)?.assessment?.conditions"
                                class="scova-interface"
                            >
                                适用条件：{{ selection(index)?.assessment?.conditions }}
                            </p>
                            <details
                                v-if="selection(index)?.assessment"
                                class="assessment scova-interface"
                            >
                                <summary>回答说明</summary>
                                <p>评估说明：{{ selection(index)?.assessment?.reason }}</p>
                                <p v-if="selection(index)?.assessment?.gap">
                                    补充说明：{{ selection(index)?.assessment?.gap }}
                                </p>
                            </details>
                        </template>
                        <p v-else class="scova-reading">
                            <a :href="`#claim-${report.claims[index]!.id}`">{{
                                report.claims[index]!.text
                            }}</a>
                        </p>
                    </template>
                </template>
                <div v-if="group.evidence.length" class="source-evidence">
                    <p class="source-evidence-title">来源引用</p>
                    <div
                        v-for="evidence in group.evidence"
                        :id="`answer-${question.id}-${groupIndex}-evidence-${evidence.id}`"
                        :key="evidence.id"
                    >
                        <evidence-citation :evidence="evidence" />
                    </div>
                </div>
            </div>
            <details
                v-if="question.gap"
                class="assessment scova-interface"
                :open="question.status === 'unresolved' || question.status === 'disputed'"
            >
                <summary>本问题的补充说明</summary>
                <p>{{ question.gap }}</p>
            </details>
        </section>
        <details v-if="references.length" class="references">
            <summary class="scova-interface">参考与探索线索（{{ references.length }}条）</summary>
            <div v-for="entry in references" :key="entry.claimIndex" class="reference">
                <report-claim :report="report" :claim="report.claims[entry.claimIndex]!" />
                <p class="scova-interface">{{ entry.reason }}</p>
                <p v-if="entry.assessment?.conditions" class="scova-interface">
                    适用条件：{{ entry.assessment.conditions }}
                </p>
                <p v-if="entry.assessment?.gap" class="scova-warning scova-interface">
                    补充说明：{{ entry.assessment.gap }}
                </p>
            </div>
        </details>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Evidence, Report, ReportValue } from '@scova/models';
import ReportClaim from '@/components/reports/ReportClaim.vue';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
const props = defineProps<{ report: Report }>();
const value = computed(() => props.report.coverage.reportValue);
const questions = computed(() =>
    [...(value.value?.questions ?? [])].sort(
        (a, b) => Number(b.priority === 'core') - Number(a.priority === 'core'),
    ),
);
const groupedQuestions = computed(() => {
    const evidence = new Map(props.report.evidence.map((entry) => [entry.id, entry]));
    const firstQuestions = new Map<number, string>();
    return questions.value.map((question) => {
        const groups = new Map<string, { key: string; indexes: number[]; evidence: Evidence[] }>();
        for (const index of question.claimIndexes) {
            const claim = props.report.claims[index];
            if (!claim) continue;
            const first = !firstQuestions.has(index);
            if (first) firstQuestions.set(index, question.id);
            const citations = claim.evidenceIds.flatMap((id) => evidence.get(id) ?? []);
            // Equal source sets can share one citation group. Never combine an uncited
            // statement or a multi-source comparison with a single-source statement.
            const key =
                first && citations.length
                    ? JSON.stringify([...new Set(citations.map((entry) => entry.sourceId))].sort())
                    : `claim:${index}`;
            const group = groups.get(key) ?? { key, indexes: [], evidence: [] };
            group.indexes.push(index);
            if (first) group.evidence.push(...citations);
            groups.set(key, group);
        }
        return {
            ...question,
            groups: [...groups.values()].map((group) => ({
                ...group,
                evidence: [...new Map(group.evidence.map((entry) => [entry.id, entry])).values()],
            })),
        };
    });
});
const references = computed(
    () =>
        value.value?.selections.filter(
            (entry) => entry.placement === 'reference' && props.report.claims[entry.claimIndex],
        ) ?? [],
);
const statusLabels: Record<ReportValue['questions'][number]['status'], string> = {
    supported: '已回答',
    provisional: '主要结论',
    disputed: '不同来源',
    unresolved: '暂无直接回答',
};
const selection = (index: number) => value.value?.selections.find((s) => s.claimIndex === index);
const firstQuestion = (index: number) =>
    questions.value.find((q) => q.claimIndexes.includes(index))?.id;
</script>

<style scoped>
.answers,
.answer,
.answer-source,
.reference {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
h3,
h4,
p {
    margin: 0;
}
.answer,
.reference {
    padding-block-start: 1.25rem;
    border-block-start: 0.0625rem solid var(--scova-border);
}
.reference {
    margin-block-start: 1.25rem;
}
summary {
    cursor: pointer;
}
.assessment {
    color: var(--scova-muted);
}
.claim-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
}
.assessment p {
    margin-block-start: 0.5rem;
}
.source-evidence {
    display: grid;
    gap: 0.5rem;
    padding-block-start: 0.25rem;
}
.source-evidence-title {
    margin: 0;
    color: var(--scova-muted);
    font-size: 0.875rem;
}
</style>
