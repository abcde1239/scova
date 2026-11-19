<template>
    <article
        class="change-record layout-grid gap-2 pt-3 [border-top:0.0625rem_solid_var(--scova-border)]"
        :aria-labelledby="`change-${entry.record.id}`"
        v-bind="{ 'data-change-id': entry.record.id }"
    >
        <div class="flex flex-wrap items-center gap-2">
            <h4 :id="`change-${entry.record.id}`" class="scova-reading font-semibold m-0">
                {{ entry.record.factKey }}
            </h4>
            <span
                v-if="entry.missingOldEvidence || entry.record.kind === 'uncertain'"
                class="scova-partial"
                >待核验</span
            >
            <span v-else-if="entry.record.important" class="text-danger">重要</span>
            <span v-else-if="entry.record.kind === 'new'">新增</span>
        </div>
        <p class="change-value scova-reading whitespace-pre-wrap m-0">
            <template v-if="entry.record.oldValue !== null"
                ><span class="old-value">{{ entry.record.oldValue }}</span>
                <span aria-label="变为">→</span> </template
            ><span class="new-value">{{ entry.record.newValue ?? '未提供新值' }}</span>
        </p>
        <p class="m-0 text-muted">{{ entry.record.reason }}</p>
        <div class="flex flex-wrap items-center gap-x-3">
            <a
                v-for="evidence in entry.newEvidence"
                :key="evidence.id"
                :id="`comparison-${entry.record.id}-new-${evidence.id}`"
                class="reference-link source-inline-action"
                :href="`#evidence-${evidence.id}`"
                >来源 {{ sourceNumber(evidence.id) }}</a
            >
            <span v-if="entry.oldEvidence.length">对比</span>
            <a
                v-for="evidence in entry.oldEvidence"
                :key="evidence.id"
                :id="`comparison-${entry.record.id}-old-${evidence.id}`"
                class="reference-link source-inline-action"
                :href="`#evidence-${evidence.id}`"
                >来源 {{ sourceNumber(evidence.id) }}（上次）</a
            >
        </div>
    </article>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import { groupEvidence } from '@/utils/report/sources';
import type { mapReportChanges } from '@/utils/report/changes';
const props = defineProps<{
    report: Report;
    entry: ReturnType<typeof mapReportChanges>[number]['entries'][number];
}>();
const groups = computed(() => groupEvidence(props.report.evidence));
const sourceNumber = (id: string) =>
    groups.value.findIndex((group) => group.evidence.some((item) => item.id === id)) + 1;
</script>
