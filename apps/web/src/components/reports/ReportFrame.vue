<template>
    <article
        class="report-frame"
        :class="`report-frame--${format}`"
        :style="reading.variables"
        aria-labelledby="report-title"
        @click="revealCitation"
    >
        <header class="report-header">
            <h2 id="report-title" class="scova-report-title" tabindex="-1">{{ report.title }}</h2>
            <div class="report-metadata flex flex-wrap items-center gap-x-4 gap-y-1 min-w-0">
                <p class="mode scova-interface">
                    {{
                        report.mode === 'demo'
                            ? '演示报告：来自演示数据，不代表真实查阅成果。'
                            : formatNames[format]
                    }}
                </p>
                <p v-if="delivery" class="scova-interface report-delivery">
                    <a
                        v-if="organized"
                        class="internal-link inline-flex items-center min-h-11"
                        href="#coverage-title"
                        @click="openCoverage"
                        >{{
                            hasAnswerGaps
                                ? '部分交付 · 查看详情'
                                : reportDeliveryLabels[delivery.status]
                        }}</a
                    >
                    <strong v-else>{{
                        hasAnswerGaps ? '部分内容待补充' : reportDeliveryLabels[delivery.status]
                    }}</strong>
                    <span v-if="delivery.questionCount && !organized">
                        · {{ delivery.answeredQuestions }}/{{
                            delivery.questionCount
                        }}
                        个问题已整理相关材料，逐项完整性见下方</span
                    >
                </p>
                <p class="published scova-interface">
                    <time :datetime="report.publishedAt">{{ published }}</time>
                </p>
            </div>
            <research-completion-summary :coverage="report.coverage" />
        </header>

        <report-changes v-if="showChanges" :report="report" />
        <report-date-screening :coverage="report.coverage" />
        <slot name="format-notice" />
        <section
            v-if="!replacesSummary"
            aria-labelledby="summary-title"
            class="report-summary scova-reading"
        >
            <h3 id="summary-title">{{ summaryTitle }}</h3>
            <model-answer-tag v-if="report.claims.some((claim) => claim.kind === 'model_answer')" />
            <p>{{ summary }}</p>
            <p
                v-if="answerGaps.length && !organized"
                class="answer-gap-overview scova-interface"
                role="note"
            >
                <span>需留意：</span>
                <template v-for="gap in answerGaps.slice(0, 3)" :key="gap.key">
                    <a
                        :href="gap.href"
                        :title="gap.text"
                        @click="gap.href === '#coverage-title' && openCoverage($event)"
                        >{{ gap.label }}</a
                    >
                </template>
                <a v-if="answerGaps.length > 3" href="#coverage-title" @click="openCoverage"
                    >查看全部 {{ answerGaps.length }} 项</a
                >
            </p>
        </section>
        <slot v-if="!document || structured" name="after-summary" />
        <collection-results v-if="collectionList" :report="report" />
        <report-document
            v-if="!collectionList && document && !structured"
            :report="report"
            :document="document"
            :format="format"
        >
            <template #navigation><slot name="after-summary" /></template>
        </report-document>
        <report-document
            v-if="!collectionList && structured && split.lead"
            :report="report"
            :document="split.lead"
            :format="format"
        />
        <report-answers
            v-if="!collectionList && report.coverage.reportValue"
            :report="report"
            :format="format"
            :document="document"
        />
        <report-document
            v-if="!collectionList && structured && split.tail"
            :report="report"
            :document="split.tail"
            :format="format"
        />
        <slot v-if="!collectionList" />
        <aside
            v-if="integrity.partial && !organized"
            class="report-warning scova-interface"
            role="note"
            aria-label="查阅范围说明"
        >
            <a class="scope-status" href="#coverage-title" @click="openCoverage"
                >查看来源覆盖说明</a
            >
        </aside>
        <section class="coverage scova-interface" aria-labelledby="coverage-title">
            <h3 id="coverage-title">查阅与核验详情</h3>
            <details ref="coverageDetails">
                <summary>
                    {{
                        answerGaps.length
                            ? `查看待补充内容（${answerGaps.length}）与查阅详情`
                            : '查看查询与来源覆盖说明'
                    }}
                </summary>
                <div class="coverage-body">
                    <p>
                        {{
                            integrity.partial
                                ? '本次结果覆盖已执行范围。'
                                : '已完成本次计划范围内的查阅。'
                        }}
                    </p>
                    <dl class="metadata scova-interface">
                        <div>
                            <dt>交付时间</dt>
                            <dd>
                                <time :datetime="report.publishedAt">{{ report.publishedAt }}</time>
                            </dd>
                        </div>
                        <div>
                            <dt>配置版本标识</dt>
                            <dd>{{ report.taskVersionId }}</dd>
                        </div>
                    </dl>
                    <template v-if="answerGaps.length">
                        <h4>待补充内容</h4>
                        <ul class="answer-gaps">
                            <li v-for="gap in answerGaps" :key="gap.key">
                                <a
                                    :href="
                                        gap.href === '#coverage-title' ? '#answers-title' : gap.href
                                    "
                                    >{{ gap.text }}</a
                                >
                            </li>
                        </ul>
                    </template>
                    <h4>已执行查询</h4>
                    <ul v-if="report.coverage.searchedQueries.length">
                        <li v-for="(query, index) in report.coverage.searchedQueries" :key="index">
                            {{ query }}
                        </li>
                    </ul>
                    <p v-else>未记录查询摘要。</p>
                    <h4>限制与缺口</h4>
                    <ul v-if="integrity.limitations.length">
                        <li v-for="(item, index) in integrity.limitations" :key="index">
                            {{ item }}
                        </li>
                    </ul>
                    <p v-else>未记录额外缺口。</p>
                    <template v-if="notes.length">
                        <h4>查阅说明</h4>
                        <ul>
                            <li v-for="(note, index) in notes" :key="index">
                                {{ note }}
                            </li>
                        </ul>
                    </template>
                    <p v-if="report.coverage.exhausted.length">
                        已耗尽预算：{{
                            report.coverage.exhausted.map((key) => budgetLabels[key]).join('、')
                        }}。
                    </p>
                </div>
            </details>
        </section>

        <report-sources v-if="showSources" :report="report" />
    </article>
</template>

<script setup lang="ts">
import ReportChanges from '@/components/reports/ReportChanges.vue';
import ReportDateScreening from '@/components/reports/ReportDateScreening.vue';
import CollectionResults from '@/components/reports/CollectionResults.vue';
import { computed, ref } from 'vue';
import { classifyReportDelivery, reportDeliveryLabels, type Report } from '@scova/models';
import { reportIntegrity } from '@/composables/useReport';
import { useReadingTypography } from '@/composables/useReadingTypography';
import ReportSources from '@/components/reports/ReportSources.vue';
import ModelAnswerTag from '@/components/reports/ModelAnswerTag.vue';
import ResearchCompletionSummary from '@/components/reports/ResearchCompletionSummary.vue';
import ReportAnswers from '@/components/reports/ReportAnswers.vue';
import ReportDocument from '@/components/reports/ReportDocument.vue';
import {
    reportSummary,
    savedArtifactDocument,
    splitStructuredDocument,
} from '@/utils/report-artifacts';
import { uniqueCoverageNotes } from '@/utils/report-coverage';
const props = withDefaults(
    defineProps<{
        report: Report;
        summaryTitle?: string;
        format?: Report['format'];
        showSources?: boolean;
        showChanges?: boolean;
    }>(),
    {
        summaryTitle: '报告概述',
        format: 'brief',
        showSources: true,
        showChanges: true,
    },
);
const { reading } = useReadingTypography();
const collectionList = computed(
    () => props.format === 'list' && !!props.report.coverage.dateScreening,
);
const formatNames = {
    brief: '简报',
    list: '主题清单',
    comparison: '对比表',
    research_report: '研究报告',
};
const integrity = computed(() => reportIntegrity(props.report));
const summary = computed(() => reportSummary(props.report));
const document = computed(() => savedArtifactDocument(props.report, props.format));
const structured = computed(() => props.format === 'list' || props.format === 'comparison');
// A structured artifact keeps its summary unless its own scope/core-difference section replaces it.
const replacesSummary = computed(() => (structured.value ? !!split.value.lead : !!document.value));
const split = computed(() =>
    splitStructuredDocument(structured.value ? document.value : undefined),
);
const artifact = computed(() =>
    props.report.coverage.artifacts?.find((entry) => entry.format === props.format),
);
const organized = computed(
    () =>
        !!(document.value || artifact.value?.content?.list || artifact.value?.content?.comparison),
);
const answerGaps = computed(() => {
    const requirements =
        artifact.value?.coverage?.requirements.filter(
            (entry) => entry.required && !['supported', 'model_answered'].includes(entry.status),
        ) ?? [];
    const requiredGaps = requirements.map((entry) => ({
        key: entry.id,
        label: `${entry.object} · ${entry.field}（待补充）`,
        text: `${entry.object} · ${entry.field}：${entry.gap || '资料仍不完整'}`,
        href: '#coverage-title',
    }));
    const insufficient = props.report.claims
        .filter((claim) => claim.kind === 'insufficient')
        .map((claim) => ({
            key: claim.id,
            label: compactLabel(claim.text),
            text: claim.text,
            href: `#claim-${claim.id}`,
        }));
    const unanswered =
        props.report.coverage.reportValue?.questions
            .filter(
                (question) => question.status === 'unresolved' || question.status === 'disputed',
            )
            .map((question) => ({
                key: question.id,
                label: `${compactLabel(question.text)}（${question.status === 'disputed' ? '存在分歧' : '待补充'}）`,
                text: `${question.text}：${question.gap || '暂无直接回答'}`,
                href: `#question-${question.id}`,
                disputed: question.status === 'disputed',
            })) ?? [];
    const ordered = [
        ...unanswered.filter((entry) => entry.disputed),
        ...requiredGaps,
        ...unanswered.filter((entry) => !entry.disputed),
        ...insufficient,
    ];
    const seen = new Set<string>();
    return ordered.filter((entry) => {
        const text = uniqueCoverageNotes([entry.text])[0]!;
        if (seen.has(text)) return false;
        seen.add(text);
        return true;
    });
});
function compactLabel(text: string): string {
    const characters = [...text];
    return characters.length > 80 ? `${characters.slice(0, 80).join('')}…` : text;
}
const hasAnswerGaps = computed(() => answerGaps.value.length > 0);
const notes = computed(() => {
    const limitations = new Set(uniqueCoverageNotes(integrity.value.limitations));
    return uniqueCoverageNotes(props.report.coverage.notes ?? []).filter(
        (note) => !limitations.has(note),
    );
});
const delivery = computed(
    () =>
        props.report.coverage.delivery ??
        (props.report.coverage.reportValue
            ? classifyReportDelivery(
                  props.report.coverage.reportValue,
                  props.report.claims,
                  props.report.coverage.artifacts,
              )
            : undefined),
);
const coverageDetails = ref<HTMLDetailsElement>();
const published = computed(() =>
    new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(props.report.publishedAt),
    ),
);
function openCoverage(event: MouseEvent) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!coverageDetails.value) return;
    coverageDetails.value.open = true;
    coverageDetails.value.querySelector('summary')?.focus();
    coverageDetails.value.scrollIntoView({ block: 'nearest' });
}
function revealCitation(event: MouseEvent) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const root = event.currentTarget;
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    const href = link?.getAttribute('href');
    if (href === '#coverage-title' && !event.defaultPrevented) {
        openCoverage(event);
        return;
    }
    if (
        !(root instanceof HTMLElement) ||
        !href ||
        !/^#(?:evidence-|claim-|question-|answers-title$)/.test(href)
    )
        return;
    const target = root.querySelector<HTMLElement>(`#${CSS.escape(href.slice(1))}`);
    if (!target) return;
    event.preventDefault();
    let parent = target.parentElement;
    while (parent && parent !== root) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
    }
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
}
const budgetLabels = {
    searches: '搜索次数',
    pages: '页面数',
    time: '时间',
    input_tokens: '输入用量',
    output_tokens: '输出用量',
};
</script>

<style scoped>
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.report-frame {
    @apply report-grid w-full max-w-full;
}
.report-frame--brief,
.report-frame--research_report {
    @apply max-w-[52rem] mx-auto;
}
.report-frame--comparison > .report-header,
.report-frame--comparison > .report-summary {
    @apply w-full max-w-[52rem];
}
.report-header,
.report-summary,
.coverage {
    @apply layout-grid gap-2.5;
}
.answer-gaps a {
    @apply internal-link;
}
.answer-gap-overview {
    @apply flex flex-wrap items-baseline gap-[0.25rem_0.75rem] text-muted text-[0.875rem];
}
.answer-gap-overview a {
    @apply inline-flex items-center min-h-11 max-w-full internal-link;
}
.scope-status {
    @apply inline-flex items-center min-h-11 justify-self-start internal-link;
}
h2,
h3,
h4,
p {
    @apply m-0;
}
h3 {
    @apply text-[1.25rem] font-semibold;
}
h4 {
    @apply text-[1rem] font-semibold;
}
.mode {
    @apply font-medium;
}
.published {
    @apply text-muted text-[0.875rem];
}
.report-summary {
    @apply gap-3;
}
.report-summary > p {
    @apply whitespace-pre-line;
}
.scope-status:focus-visible,
.answer-gap-overview a:focus-visible,
.answer-gaps a:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.1875rem];
}
.metadata {
    @apply grid grid-cols-[repeat(auto-fit,_minmax(min(100%,_16rem),_1fr))] gap-[0.5rem_1.25rem] m-0;
}
dt {
    @apply text-muted;
}
dd {
    @apply m-0;
}
ul {
    @apply pl-6 m-0;
}
.coverage {
    @apply pt-3 pb-3
        [border-block:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)];
}
summary {
    @apply min-h-11 cursor-pointer pt-2 pb-2;
}
summary:focus-visible,
#report-title:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
.coverage-body {
    @apply grid gap-4 pt-4;
}
</style>
