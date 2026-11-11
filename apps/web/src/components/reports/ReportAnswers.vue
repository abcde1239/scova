<template>
    <section
        v-if="value"
        class="answers report-grid max-w-full [&.answer]:(grid gap-5 min-w-0 max-w-full break-anywhere pt-5 [border-top:0.0625rem_solid_var(--scova-border)] [scroll-margin-block-start:6rem])"
        :class="`answers--${format}`"
        aria-labelledby="answers-title"
    >
        <h3 id="answers-title" class="scova-content-title m-0">{{ presentation.title }}</h3>
        <p class="scova-interface m-0 [.assessment_&:is(p)]:mt-2">{{ presentation.description }}</p>
        <report-structured-content
            v-if="structured"
            :report="report"
            :content="structured"
            :format="format"
        />
        <p
            v-else-if="format === 'list' || format === 'comparison'"
            class="legacy-notice scova-interface text-muted m-0 [.assessment_&:is(p)]:mt-2"
        >
            这份报告未保存对象与字段结构，以下保留原有问题与回答。
        </p>
        <component :is="structured ? 'details' : 'div'" class="answer-support">
            <summary
                v-if="structured"
                class="scova-interface min-h-11 pt-2 pb-2 cursor-pointer keyboard-focus-wide"
            >
                查看完整依据与问题覆盖
            </summary>
            <div class="answer-rows report-grid max-w-full">
                <section
                    v-for="(question, questionIndex) in groupedQuestions"
                    :id="`question-${question.id}`"
                    :key="question.id"
                    class="answer report-grid max-w-full pt-5 [border-top:0.0625rem_solid_var(--scova-border)] [scroll-margin-block-start:6rem]"
                    :aria-labelledby="`question-title-${question.id}`"
                >
                    <header
                        class="answer-heading layout-grid gap-2 max-w-full break-anywhere [.answers--research\_report_&.answer-heading]:(pt-3 pb-3 [border-bottom:0.0625rem_solid_var(--scova-border)])"
                    >
                        <span
                            v-if="format !== 'brief'"
                            class="answer-number scova-interface text-primary text-[1.25rem] font-semibold [font-variant-numeric:tabular-nums]"
                            aria-hidden="true"
                            >{{ String(questionIndex + 1).padStart(2, '0') }}</span
                        >
                        <h4
                            :id="`question-title-${question.id}`"
                            class="scova-content-title m-0 [.answers--research\_report_.answer-heading_&:is(h4)]:(text-[1.375rem] leading-[1.6])"
                        >
                            {{ question.text }}
                        </h4>
                        <p class="scova-interface m-0 [.assessment_&:is(p)]:mt-2">
                            {{ question.priority === 'core' ? '核心问题' : '补充问题' }} ·
                            {{ statusLabels[question.status] }}
                        </p>
                    </header>
                    <div class="answer-body report-grid max-w-full">
                        <div
                            v-for="group in question.groups"
                            :key="group.key"
                            class="answer-source report-grid max-w-full"
                        >
                            <template v-for="index in group.indexes" :key="index">
                                <template v-if="report.claims[index]">
                                    <template v-if="firstQuestion(index) === question.id">
                                        <report-claim
                                            :report="report"
                                            :claim="report.claims[index]!"
                                        />
                                        <p
                                            v-if="selection(index)?.assessment?.conditions"
                                            class="scova-interface m-0 [.assessment_&:is(p)]:mt-2"
                                        >
                                            适用条件：{{ selection(index)?.assessment?.conditions }}
                                        </p>
                                        <details
                                            v-if="selection(index)?.assessment"
                                            class="assessment scova-interface text-muted"
                                        >
                                            <summary
                                                class="min-h-11 pt-2 pb-2 cursor-pointer keyboard-focus-wide"
                                            >
                                                回答说明
                                            </summary>
                                            <p class="m-0 [.assessment_&:is(p)]:mt-2">
                                                评估说明：{{ selection(index)?.assessment?.reason }}
                                            </p>
                                            <p
                                                class="m-0 [.assessment_&:is(p)]:mt-2"
                                                v-if="selection(index)?.assessment?.gap"
                                            >
                                                补充说明：{{ selection(index)?.assessment?.gap }}
                                            </p>
                                        </details>
                                    </template>
                                    <p
                                        v-else
                                        class="shared-answer scova-interface m-0 [.assessment_&:is(p)]:mt-2"
                                    >
                                        <a
                                            class="inline-flex min-h-11 items-center text-primary underline-offset-[0.2em] keyboard-focus-wide"
                                            :href="`#claim-${report.claims[index]!.id}`"
                                            >查看前文相关结论</a
                                        >
                                    </p>
                                </template>
                            </template>
                        </div>
                        <p
                            v-if="question.gap"
                            class="question-gap scova-interface text-muted m-0 [.assessment_&:is(p)]:mt-2"
                            :class="{
                                'scova-warning':
                                    question.status === 'unresolved' ||
                                    question.status === 'disputed',
                            }"
                        >
                            补充说明：{{ question.gap }}
                        </p>
                    </div>
                </section>
            </div>
        </component>
        <details
            v-if="pending.length"
            id="report-pending"
            class="pending min-w-0 pt-2 pb-2 [border-top:0.0625rem_solid_var(--scova-border)]"
        >
            <summary
                id="pending-title"
                class="scova-interface min-h-11 pt-2 pb-2 cursor-pointer keyboard-focus-wide"
            >
                查看待核实材料（{{ pending.length }}）
            </summary>
            <div class="pending-body report-grid max-w-full pt-3 pb-3">
                <p class="scova-interface m-0 [.assessment_&:is(p)]:mt-2">
                    以下材料尚无足够依据，不计入已确认回答。
                </p>
                <report-claim
                    v-for="claim in pending"
                    :key="claim.id"
                    :report="report"
                    :claim="claim"
                />
            </div>
        </details>
        <details v-if="references.length" class="references">
            <summary class="scova-interface min-h-11 pt-2 pb-2 cursor-pointer keyboard-focus-wide">
                参考与探索线索（{{ references.length }}条）
            </summary>
            <div
                v-for="entry in references"
                :key="entry.claimIndex"
                class="reference report-grid max-w-full pt-5 [border-top:0.0625rem_solid_var(--scova-border)] mt-5"
            >
                <report-claim :report="report" :claim="report.claims[entry.claimIndex]!" />
                <p class="scova-interface m-0 [.assessment_&:is(p)]:mt-2">{{ entry.reason }}</p>
                <p
                    v-if="entry.assessment?.conditions"
                    class="scova-interface m-0 [.assessment_&:is(p)]:mt-2"
                >
                    适用条件：{{ entry.assessment.conditions }}
                </p>
                <p
                    v-if="entry.assessment?.gap"
                    class="scova-warning scova-interface m-0 [.assessment_&:is(p)]:mt-2"
                >
                    补充说明：{{ entry.assessment.gap }}
                </p>
            </div>
        </details>
    </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { Report, ReportValue } from '@scova/models';
import ReportClaim from '@/components/reports/ReportClaim.vue';
import ReportStructuredContent from '@/components/reports/ReportStructuredContent.vue';
const props = withDefaults(defineProps<{ report: Report; format?: Report['format'] }>(), {
    format: 'brief',
});
const value = computed(() => props.report.coverage.reportValue);
const structured = computed(
    () => props.report.coverage.artifacts?.find((entry) => entry.format === props.format)?.content,
);
const pending = computed(() =>
    props.report.claims.filter((claim) => claim.kind === 'insufficient'),
);
const presentation = computed(
    () =>
        ({
            brief: {
                title: '问题与回答',
                description: '先阅读结论与条件，通过来源链接核对集中保存的原文。',
            },
            list: { title: '主题清单', description: '按对象查看所需字段，缺失项目保留并标明。' },
            comparison: {
                title: '对象对比',
                description: '按共同维度核对各对象，未知信息不作为优劣判断。',
            },
            research_report: {
                title: '研究章节',
                description: '按章节阅读发现与依据，共用结论通过链接定位。',
            },
        })[props.format],
);
const questions = computed(() =>
    [...(value.value?.questions ?? [])].sort(
        (a, b) => Number(b.priority === 'core') - Number(a.priority === 'core'),
    ),
);
const groupedQuestions = computed(() =>
    questions.value.map((question) => ({
        ...question,
        groups: question.claimIndexes
            .filter(
                (index) =>
                    props.report.claims[index] &&
                    props.report.claims[index]!.kind !== 'insufficient',
            )
            .map((index) => ({ key: `claim:${index}`, indexes: [index] })),
    })),
);
const references = computed(
    () =>
        value.value?.selections.filter(
            (entry) =>
                entry.placement === 'reference' &&
                props.report.claims[entry.claimIndex] &&
                props.report.claims[entry.claimIndex]!.kind !== 'insufficient',
        ) ?? [],
);
const statusLabels: Record<ReportValue['questions'][number]['status'], string> = {
    supported: '已回答',
    provisional: '有材料，仍需核对条件',
    disputed: '不同来源',
    unresolved: '暂无直接回答',
};
const selection = (index: number) =>
    value.value?.selections.find((entry) => entry.claimIndex === index);
const firstQuestion = (index: number) =>
    questions.value.find((question) => question.claimIndexes.includes(index))?.id;
</script>
