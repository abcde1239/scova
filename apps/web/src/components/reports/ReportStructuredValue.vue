<template>
    <span
        v-if="compact"
        class="structured-value structured-value--compact break-anywhere"
        :class="{ 'text-muted': value.status === 'unknown' }"
    >
        <model-answer-tag v-if="isModelAnswer" class="mr-1.5" />
        <span
            v-if="!isModelAnswer && value.status !== 'supported'"
            class="value-tag scova-interface inline-flex items-center rounded-1 px-1.5 mr-1.5 text-[0.75rem] leading-[1.6] [border:0.0625rem_dashed_currentColor]"
            :class="value.status === 'unknown' ? 'text-muted' : 'theme-partial'"
            >{{ value.status === 'unknown' ? '未知' : '部分' }}</span
        ><template v-if="value.text && value.status !== 'unknown'">
            <span
                v-for="(paragraph, index) in paragraphs"
                :key="index"
                class="structured-paragraph whitespace-pre-wrap"
                :class="{ 'block mt-3': index > 0 }"
                >{{ paragraph }}</span
            > </template
        ><sup
            v-for="number in notes"
            :key="number"
            class="value-note scova-interface text-primary ml-0.5 text-[0.6875rem]"
            ><a :href="`#${noteId}-${number}`" :aria-label="`注 ${number}`">{{ number }}</a></sup
        >
    </span>
    <div v-else class="structured-value scova-reading layout-grid gap-2 break-anywhere">
        <model-answer-tag v-if="isModelAnswer" />
        <p
            v-if="!isModelAnswer && value.status !== 'supported'"
            class="scova-warning scova-interface whitespace-pre-wrap m-0"
        >
            {{ value.status === 'unknown' ? '未知' : '部分资料，待核实'
            }}{{ value.gap ? `：${value.gap}` : '' }}
        </p>
        <template v-if="value.text && value.status !== 'unknown'">
            <p
                v-for="(paragraph, index) in paragraphs"
                :key="index"
                class="whitespace-pre-wrap m-0"
            >
                {{ paragraph }}
            </p>
        </template>
        <p
            v-for="notice in details.notices"
            :key="notice"
            class="structured-notice scova-warning scova-interface whitespace-pre-wrap m-0"
        >
            {{ notice }}
        </p>
        <p
            v-for="condition in details.conditions"
            :key="condition"
            class="structured-condition scova-interface whitespace-pre-wrap m-0"
        >
            {{ condition }}
        </p>
        <p
            v-for="gap in details.gaps"
            :key="gap"
            class="structured-gap scova-warning scova-interface whitespace-pre-wrap m-0"
        >
            补充说明：{{ gap }}
        </p>
    </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
import { structuredValueNotes, type StructuredValue } from '@/utils/report-artifacts';
import ModelAnswerTag from '@/components/reports/ModelAnswerTag.vue';
const props = withDefaults(
    defineProps<{
        report: Report;
        value: StructuredValue;
        /** Table cell mode: details move to numbered footnotes under the table. */
        compact?: boolean;
        notes?: number[];
        noteId?: string;
    }>(),
    { compact: false, notes: () => [], noteId: 'structured-note' },
);
const details = computed(() => structuredValueNotes(props.report, props.value));
const paragraphs = computed(() => props.value.text.split(/\r?\n[\t ]*\r?\n/));
const isModelAnswer = computed(() =>
    props.value.claimIndexes.some((index) => props.report.claims[index]?.kind === 'model_answer'),
);
</script>
