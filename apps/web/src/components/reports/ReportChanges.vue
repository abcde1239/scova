<template>
    <section
        class="report-changes"
        :style="reading.variables"
        aria-labelledby="report-changes-title"
    >
        <h3 id="report-changes-title" class="scova-content-title">变化与基线</h3>
        <dl class="comparison-context scova-interface">
            <div>
                <dt>当前报告模式</dt>
                <dd>{{ report.mode === 'demo' ? '演示数据' : '真实查阅' }}</dd>
            </div>
            <div>
                <dt>比较基线执行标识</dt>
                <dd>{{ report.baselineRunId ?? '报告未提供关联的基线执行。' }}</dd>
            </div>
        </dl>
        <aside
            class="comparison-summary scova-interface"
            :class="{ 'scova-warning': summary.state === 'inconclusive' }"
            role="note"
        >
            <h4>{{ summary.title }}</h4>
            <p>{{ summary.message }}</p>
        </aside>
        <p v-if="!groups.length" class="scova-interface">本报告没有提供逐项变化记录。</p>
        <section
            v-for="group in groups"
            :key="group.kind"
            class="change-group"
            :aria-labelledby="`change-group-${group.kind}`"
        >
            <h4 :id="`change-group-${group.kind}`" class="scova-content-title">
                {{ group.title }} · {{ group.entries.length }} 项
            </h4>
            <article
                v-for="entry in group.entries"
                :key="entry.record.id"
                class="change-record"
                :aria-labelledby="`change-${entry.record.id}`"
            >
                <h5 :id="`change-${entry.record.id}`" class="scova-reading">
                    {{ entry.record.factKey }}
                </h5>
                <p class="scova-interface">
                    重要性标记：{{ entry.record.important ? '重要' : '未标记为重要' }}
                </p>
                <p class="scova-reading">{{ entry.record.reason }}</p>
                <p v-if="entry.missingOldEvidence" class="scova-warning">
                    旧值缺少可核对引用，这项比较仍待核验。
                </p>
                <div class="change-sides">
                    <section
                        class="change-side old-side"
                        :aria-labelledby="`old-${entry.record.id}`"
                    >
                        <h6 :id="`old-${entry.record.id}`" class="scova-interface">旧值 · 基线</h6>
                        <p class="change-value scova-reading">
                            {{ entry.record.oldValue ?? '未提供旧值' }}
                        </p>
                        <evidence-citation
                            v-for="evidence in entry.oldEvidence"
                            :key="evidence.id"
                            :evidence="evidence"
                        />
                        <p v-if="!entry.oldEvidence.length" class="scova-interface">
                            未提供旧侧引用。
                        </p>
                    </section>
                    <section
                        class="change-side new-side"
                        :aria-labelledby="`new-${entry.record.id}`"
                    >
                        <h6 :id="`new-${entry.record.id}`" class="scova-interface">
                            本次观测 · 新值
                        </h6>
                        <p class="change-value scova-reading">
                            {{ entry.record.newValue ?? '未提供新值' }}
                        </p>
                        <evidence-citation
                            v-for="evidence in entry.newEvidence"
                            :key="evidence.id"
                            :evidence="evidence"
                        />
                        <p v-if="!entry.newEvidence.length" class="scova-interface">
                            未提供本次观测引用。
                        </p>
                    </section>
                </div>
            </article>
        </section>
        <p class="scova-interface">
            本次未观察到旧资料不等于资料已撤回；正文指纹变化本身不等于重要事实变化。
        </p>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
import { changeSummary, mapReportChanges } from '@/utils/report-changes';
import { useReadingTypography } from '@/composables/useReadingTypography';
const { reading } = useReadingTypography();
const props = defineProps<{ report: Report }>();
const groups = computed(() => mapReportChanges(props.report));
const summary = computed(() => changeSummary(props.report));
</script>

<style scoped>
.report-changes,
.change-group,
.change-record,
.change-side {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
}
.report-changes {
    padding-block: 1rem;
    border-block: 0.0625rem solid var(--scova-border);
    overflow-wrap: anywhere;
}
h3,
h4,
h5,
h6,
p {
    margin: 0;
}
h3 {
    font-size: 1.25rem;
}
h4 {
    font-size: 1.125rem;
    font-weight: 600;
}
h5 {
    font-weight: 600;
}
h6 {
    font-weight: 500;
}
.comparison-context {
    display: grid;
    gap: 1rem;
    margin: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0.25rem 0 0;
}
.comparison-summary {
    display: grid;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    border-inline-start: 0.1875rem solid var(--scova-primary);
    background: var(--scova-surface);
}
.change-record + .change-record {
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block-start: 1.5rem;
}
.change-sides {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
    gap: 1.5rem;
    min-inline-size: 0;
    align-items: start;
}
.change-value {
    white-space: pre-wrap;
}
</style>
