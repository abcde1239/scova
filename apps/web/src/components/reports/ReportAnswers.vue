<template>
    <section
        v-if="value"
        class="answers"
        :class="`answers--${format}`"
        aria-labelledby="answers-title"
    >
        <h3 id="answers-title" class="scova-content-title">{{ presentations[format].title }}</h3>
        <p class="scova-interface">{{ presentations[format].description }}</p>
        <div
            class="answer-scroll"
            :tabindex="format === 'comparison' ? 0 : undefined"
            :role="format === 'comparison' ? 'region' : undefined"
            :aria-labelledby="format === 'comparison' ? 'answers-title' : undefined"
        >
            <component :is="format === 'comparison' ? 'table' : 'div'" class="answer-items">
                <caption v-if="format === 'comparison'">
                    问题、信息与来源对照
                </caption>
                <thead v-if="format === 'comparison'">
                    <tr>
                        <th scope="col">研究问题</th>
                        <th scope="col">已收集信息与来源</th>
                    </tr>
                </thead>
                <component :is="format === 'comparison' ? 'tbody' : 'div'" class="answer-rows">
                    <component
                        :is="format === 'comparison' ? 'tr' : 'section'"
                        v-for="(question, questionIndex) in groupedQuestions"
                        :id="`question-${question.id}`"
                        :key="question.id"
                        class="answer"
                        :aria-labelledby="`question-title-${question.id}`"
                    >
                        <component
                            :is="format === 'comparison' ? 'th' : 'header'"
                            :scope="format === 'comparison' ? 'row' : undefined"
                            class="answer-heading"
                        >
                            <span
                                v-if="format !== 'brief'"
                                class="answer-number scova-interface"
                                aria-hidden="true"
                                >{{ String(questionIndex + 1).padStart(2, '0') }}</span
                            >
                            <h4 :id="`question-title-${question.id}`" class="scova-content-title">
                                {{ question.text }}
                            </h4>
                            <p class="scova-interface">
                                {{ question.priority === 'core' ? '核心问题' : '补充问题' }} ·
                                {{ statusLabels[question.status] }}
                            </p>
                        </component>
                        <component :is="format === 'comparison' ? 'td' : 'div'" class="answer-body">
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
                                                        group.evidence.findIndex(
                                                            (entry) => entry.id === id,
                                                        ) + 1
                                                    }}</a
                                                >
                                            </p>
                                            <p
                                                v-if="selection(index)?.assessment?.conditions"
                                                class="scova-interface"
                                            >
                                                适用条件：{{
                                                    selection(index)?.assessment?.conditions
                                                }}
                                            </p>
                                            <details
                                                v-if="selection(index)?.assessment"
                                                class="assessment scova-interface"
                                            >
                                                <summary>回答说明</summary>
                                                <p>
                                                    评估说明：{{
                                                        selection(index)?.assessment?.reason
                                                    }}
                                                </p>
                                                <p v-if="selection(index)?.assessment?.gap">
                                                    补充说明：{{
                                                        selection(index)?.assessment?.gap
                                                    }}
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
                                :open="
                                    question.status === 'unresolved' ||
                                    question.status === 'disputed'
                                "
                            >
                                <summary>本问题的补充说明</summary>
                                <p>{{ question.gap }}</p>
                            </details>
                        </component>
                    </component>
                </component>
            </component>
        </div>
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
const props = withDefaults(defineProps<{ report: Report; format?: Report['format'] }>(), {
    format: 'brief',
});
const value = computed(() => props.report.coverage.reportValue);
const presentations = {
    brief: {
        title: '问题与回答',
        description: '回答按问题整理；展开来源可查看原文引用和适用条件。',
    },
    list: { title: '主题条目', description: '每张卡片整理一个问题，保留相关资料与适用条件。' },
    comparison: {
        title: '问题与信息对照',
        description: '逐行核对问题、内容与来源；表格可在自身区域左右滚动。',
    },
    research_report: { title: '研究章节', description: '按章节阅读发现与依据，通过引用核对原文。' },
};
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
.answer-heading,
.answer-body,
.answer-rows,
.reference {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.answer-number {
    color: var(--scova-primary);
    font-size: 1.25rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}
.answer-heading {
    gap: 0.5rem;
}
.answer-items,
.answer-scroll {
    min-inline-size: 0;
    max-inline-size: 100%;
}
.answer-scroll:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.answers--list .answer-rows {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    align-items: start;
    gap: 1rem;
}
.answers--list .answer {
    padding: 1rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--scova-selected) 28%, var(--scova-surface));
}
.answers--comparison .answer-scroll {
    overflow-x: auto;
    overscroll-behavior-inline: contain;
}
.answers--comparison .answer-items {
    inline-size: 100%;
    min-inline-size: 38rem;
    border-collapse: collapse;
    table-layout: fixed;
}
.answers--comparison .answer-rows {
    display: table-row-group;
}
.answers--comparison .answer {
    display: table-row;
}
.answers--comparison .answer-heading,
.answers--comparison .answer-body {
    display: table-cell;
    text-align: start;
    vertical-align: top;
    padding: 1rem;
    border: 0.0625rem solid var(--scova-border);
    font-weight: 400;
}
.answers--comparison .answer-heading {
    inline-size: 30%;
    background: var(--scova-selected);
}
.answers--comparison .answer-heading > * + * {
    margin-block-start: 0.75rem;
}
.answers--comparison thead th {
    text-align: start;
    padding: 0.875rem 1rem;
    border: 0.0625rem solid var(--scova-border);
    background: var(--scova-selected);
    font-family: var(--scova-font-interface);
}
.answers--comparison thead th:first-child {
    inline-size: 30%;
}
.answers--comparison caption {
    text-align: start;
    padding-block-end: 0.75rem;
    font-family: var(--scova-font-interface);
}
.answers--research_report .answer-heading {
    padding-block: 0.75rem;
    border-block-end: 0.0625rem solid var(--scova-border);
}
.answers--research_report .answer-heading h4 {
    font-size: 1.375rem;
    line-height: 1.6;
}
.answers--research_report .answer {
    gap: 1.5rem;
    padding-block-start: 2rem;
    border-block-start: 0;
}
@media (max-width: 40rem) {
    .answers--list .answer {
        padding-inline: 0;
        border-inline: 0;
        border-radius: 0;
        background: transparent;
    }
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
