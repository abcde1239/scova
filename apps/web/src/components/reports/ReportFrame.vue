<template>
    <article class="report-frame" :style="reading.variables" aria-labelledby="report-title">
        <header class="report-header">
            <h2 id="report-title" class="scova-report-title" tabindex="-1">{{ report.title }}</h2>
            <p class="mode scova-interface">
                {{
                    report.mode === 'demo'
                        ? '演示报告：来自演示数据，不代表真实查阅成果。'
                        : '真实查阅报告'
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
        </header>
        <aside
            v-if="integrity.partial"
            class="report-warning scova-warning"
            role="note"
            aria-label="部分交付警告"
        >
            <h3>部分交付，结论仍有缺口</h3>
            <p>本报告未完成全部查阅，不能据此认定没有重要变化。</p>
            <ul>
                <li v-for="(item, index) in integrity.limitations" :key="index">{{ item }}</li>
            </ul>
        </aside>
        <section class="coverage scova-interface" aria-labelledby="coverage-title">
            <h3 id="coverage-title">查阅范围与限制</h3>
            <p>
                {{
                    integrity.partial
                        ? '本次覆盖不完整。'
                        : '本次计划范围内查阅完成，不代表穷尽互联网资料。'
                }}
            </p>
            <details>
                <summary>查看查询摘要与覆盖缺口</summary>
                <div class="coverage-body">
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
                    <p v-if="report.coverage.exhausted.length">
                        已耗尽预算：{{
                            report.coverage.exhausted.map((key) => budgetLabels[key]).join('、')
                        }}。
                    </p>
                </div>
            </details>
        </section>
        <slot name="format-notice" />
        <section aria-labelledby="summary-title" class="scova-reading">
            <h3 id="summary-title">{{ summaryTitle }}</h3>
            <p>{{ report.summary }}</p>
        </section>
        <slot />
        <report-sources :report="report" />
    </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import { reportIntegrity } from '@/composables/useReport';
import { useReadingTypography } from '@/composables/useReadingTypography';
import ReportSources from '@/components/reports/ReportSources.vue';
const props = withDefaults(defineProps<{ report: Report; summaryTitle?: string }>(), {
    summaryTitle: '报告概述',
});
const { reading } = useReadingTypography();
const integrity = computed(() => reportIntegrity(props.report));
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
    gap: 2.5rem;
    inline-size: min(100%, 45rem);
    max-inline-size: 100%;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.report-header,
.coverage {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
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
.metadata {
    display: grid;
    gap: 1rem;
    margin: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0;
}
.report-warning {
    display: grid;
    gap: 1rem;
    padding: 1.25rem;
    border-inline-start: 0.25rem solid var(--scova-partial);
    background: var(--scova-surface);
}
ul {
    margin: 0;
    padding-inline-start: 1.5rem;
}
.coverage {
    padding-block: 1.5rem;
    border-block: 0.0625rem solid var(--scova-border);
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
