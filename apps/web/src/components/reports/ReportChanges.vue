<template>
    <section
        class="report-changes report-grid pt-4 pb-4 [border-block:0.0625rem_solid_var(--scova-border)]"
        :style="reading.variables"
        aria-labelledby="report-changes-title"
    >
        <h3 id="report-changes-title" class="scova-content-title text-[1.25rem] m-0">变化与基线</h3>
        <dl class="comparison-context scova-interface grid gap-4 m-0">
            <div>
                <dt class="text-muted">当前报告模式</dt>
                <dd class="mt-1 mb-0 mx-0">
                    {{ report.mode === 'demo' ? '演示数据' : '任务执行' }}
                </dd>
            </div>
            <div>
                <dt class="text-muted">比较基线执行标识</dt>
                <dd class="mt-1 mb-0 mx-0">
                    {{ report.baselineRunId ?? '报告未提供关联的基线执行。' }}
                </dd>
            </div>
        </dl>
        <aside
            class="comparison-summary scova-interface grid gap-3 [border-left:0.1875rem_solid_var(--scova-primary)] bg-surface py-4 px-5"
            :class="{ 'scova-warning': summary.state === 'inconclusive' }"
            role="note"
        >
            <h4 class="text-[1.125rem] font-semibold m-0">{{ summary.title }}</h4>
            <p class="m-0">{{ summary.message }}</p>
        </aside>
        <p v-if="!groups.length" class="scova-interface m-0">本报告没有提供逐项变化记录。</p>
        <section
            v-for="group in groups"
            :key="group.kind"
            class="change-group layout-grid gap-5"
            :aria-labelledby="`change-group-${group.kind}`"
        >
            <h4
                :id="`change-group-${group.kind}`"
                class="scova-content-title text-[1.125rem] font-semibold m-0"
            >
                {{ group.title }} · {{ group.entries.length }} 项
            </h4>
            <article
                v-for="entry in group.entries"
                :key="entry.record.id"
                class="change-record layout-grid gap-5 [.change-record_+_&.change-record]:([border-top:0.0625rem_solid_var(--scova-border)] pt-6)"
                :aria-labelledby="`change-${entry.record.id}`"
            >
                <h5 :id="`change-${entry.record.id}`" class="scova-reading font-semibold m-0">
                    {{ entry.record.factKey }}
                </h5>
                <p class="scova-interface m-0">
                    重要性标记：{{ entry.record.important ? '重要' : '未标记为重要' }}
                </p>
                <p class="scova-reading m-0">{{ entry.record.reason }}</p>
                <p v-if="entry.missingOldEvidence" class="scova-warning m-0">
                    旧值缺少可核对引用，这项比较仍待核验。
                </p>
                <div
                    class="change-sides layout-grid grid-cols-[repeat(auto-fit,_minmax(min(100%,_18rem),_1fr))] gap-6 items-start"
                >
                    <section
                        class="change-side old-side layout-grid gap-5"
                        :aria-labelledby="`old-${entry.record.id}`"
                    >
                        <h6 :id="`old-${entry.record.id}`" class="scova-interface font-medium m-0">
                            旧值 · 基线
                        </h6>
                        <p class="change-value scova-reading whitespace-pre-wrap m-0">
                            {{ entry.record.oldValue ?? '未提供旧值' }}
                        </p>
                    </section>
                    <section
                        class="change-side new-side layout-grid gap-5"
                        :aria-labelledby="`new-${entry.record.id}`"
                    >
                        <h6 :id="`new-${entry.record.id}`" class="scova-interface font-medium m-0">
                            本次观测 · 新值
                        </h6>
                        <p class="change-value scova-reading whitespace-pre-wrap m-0">
                            {{ entry.record.newValue ?? '未提供新值' }}
                        </p>
                    </section>
                </div>
            </article>
        </section>
        <p class="scova-interface m-0">
            本次未观察到旧资料不等于资料已撤回；正文指纹变化本身不等于重要事实变化。
        </p>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import { changeSummary, mapReportChanges } from '@/utils/report-changes';
import { useReadingTypography } from '@/composables/useReadingTypography';
const { reading } = useReadingTypography();
const props = defineProps<{ report: Report }>();
const groups = computed(() => mapReportChanges(props.report));
const summary = computed(() => changeSummary(props.report));
</script>
