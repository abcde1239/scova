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
            <p class="mode scova-interface">
                {{
                    report.mode === 'demo'
                        ? '演示报告：来自演示数据，不代表真实查阅成果。'
                        : '真实查阅报告'
                }}
            </p>
            <p v-if="delivery" class="scova-interface report-delivery">
                <strong>{{
                    hasAnswerGaps ? '部分内容待补充' : reportDeliveryLabels[delivery.status]
                }}</strong>
                <span v-if="delivery.questionCount">
                    · {{ delivery.answeredQuestions }}/{{
                        delivery.questionCount
                    }}
                    个问题已整理相关材料，逐项完整性见下方</span
                >
            </p>
            <p class="published scova-interface">
                <time :datetime="report.publishedAt">{{ published }}</time>
            </p>
        </header>

        <slot name="format-notice" />
        <section aria-labelledby="summary-title" class="report-summary scova-reading">
            <h3 id="summary-title">{{ summaryTitle }}</h3>
            <p>{{ summary }}</p>
            <p v-if="answerGaps.length" class="answer-gap-overview scova-interface" role="note">
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
        <slot name="after-summary" />
        <report-answers v-if="report.coverage.reportValue" :report="report" :format="format" />
        <slot />
        <aside
            v-if="integrity.partial"
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
                                : '本次计划范围内查阅完成，不代表穷尽互联网资料。'
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

        <report-sources :report="report" />
    </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { classifyReportDelivery, reportDeliveryLabels, type Report } from '@scova/models';
import { reportIntegrity } from '@/composables/useReport';
import { useReadingTypography } from '@/composables/useReadingTypography';
import ReportSources from '@/components/reports/ReportSources.vue';
import ReportAnswers from '@/components/reports/ReportAnswers.vue';
import { reportSummary } from '@/utils/report-artifacts';
import { uniqueCoverageNotes } from '@/utils/report-coverage';
const props = withDefaults(
    defineProps<{ report: Report; summaryTitle?: string; format?: Report['format'] }>(),
    {
        summaryTitle: '报告概述',
        format: 'brief',
    },
);
const { reading } = useReadingTypography();
const integrity = computed(() => reportIntegrity(props.report));
const summary = computed(() => reportSummary(props.report));
const artifact = computed(() =>
    props.report.coverage.artifacts?.find((entry) => entry.format === props.format),
);
const answerGaps = computed(() => {
    const requirements =
        artifact.value?.coverage?.requirements.filter(
            (entry) => entry.required && entry.status !== 'supported',
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
.report-frame {
    display: grid;
    gap: 1.25rem;
    inline-size: 100%;
    max-inline-size: 100%;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.report-header,
.report-summary,
.coverage {
    display: grid;
    gap: 0.625rem;
    min-inline-size: 0;
}
.answer-gaps a {
    color: inherit;
    text-underline-offset: 0.2em;
}
.answer-gap-overview {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.75rem;
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.answer-gap-overview a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    color: inherit;
    text-underline-offset: 0.2em;
}
.scope-status {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    justify-self: start;
    color: var(--scova-muted);
    text-underline-offset: 0.2em;
}
h2,
h3,
h4,
p {
    margin: 0;
}
h3 {
    font-size: 1.25rem;
    font-weight: 600;
}
h4 {
    font-size: 1rem;
    font-weight: 600;
}
.mode {
    font-weight: 500;
}
.published {
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.report-summary {
    gap: 0.75rem;
}
.report-summary > p {
    white-space: pre-line;
}
.scope-status:focus-visible,
.answer-gap-overview a:focus-visible,
.answer-gaps a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
.metadata {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
    gap: 0.5rem 1.25rem;
    margin: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0;
}
ul {
    margin: 0;
    padding-inline-start: 1.5rem;
}
.coverage {
    padding-block: 0.75rem;
    border-block: 0.0625rem solid color-mix(in srgb, var(--scova-border) 30%, transparent);
}
summary {
    min-block-size: 2.75rem;
    cursor: pointer;
    padding-block: 0.5rem;
}
summary:focus-visible,
#report-title:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.coverage-body {
    display: grid;
    gap: 1rem;
    padding-block-start: 1rem;
}
</style>
