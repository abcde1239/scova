<template>
    <div class="structured-value scova-reading">
        <p v-if="value.status !== 'supported'" class="scova-warning scova-interface">
            {{ value.status === 'unknown' ? '未知' : '部分资料，待核实'
            }}{{ value.gap ? `：${value.gap}` : '' }}
        </p>
        <p v-if="value.text && value.status !== 'unknown'">{{ value.text }}</p>
        <p
            v-for="notice in notices"
            :key="notice"
            class="structured-notice scova-warning scova-interface"
        >
            {{ notice }}
        </p>
        <p
            v-for="condition in conditions"
            :key="condition"
            class="structured-condition scova-interface"
        >
            适用条件：{{ condition }}
        </p>
        <p v-for="gap in gaps" :key="gap" class="structured-gap scova-warning scova-interface">
            补充说明：{{ gap }}
        </p>
        <nav v-if="indexes.length" class="structured-links scova-interface" aria-label="本项依据">
            <a v-for="index in indexes" :key="index" :href="`#claim-${report.claims[index]!.id}`"
                >依据 {{ index + 1 }}</a
            >
        </nav>
    </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
type Content = NonNullable<NonNullable<Report['coverage']['artifacts']>[number]['content']>;
type Value = Pick<
    NonNullable<Content['list']>['entries'][number]['fields'][number],
    'text' | 'claimIndexes' | 'status' | 'gap'
>;
const props = defineProps<{ report: Report; value: Value }>();
const indexes = computed(() =>
    [...new Set(props.value.claimIndexes)].filter((index) => props.report.claims[index]),
);
const selections = computed(() =>
    (props.report.coverage.reportValue?.selections ?? []).filter((entry) =>
        indexes.value.includes(entry.claimIndex),
    ),
);
const uniqueText = (values: (string | undefined)[]) => [
    ...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value)),
];
const conditions = computed(() =>
    uniqueText(selections.value.map((entry) => entry.assessment?.conditions)),
);
const gaps = computed(() =>
    uniqueText(selections.value.map((entry) => entry.assessment?.gap)).filter(
        (gap) => gap !== props.value.gap.trim(),
    ),
);
const notices = computed(() =>
    uniqueText(
        indexes.value.map((index) => {
            const selection = selections.value.find((entry) => entry.claimIndex === index);
            if (props.report.claims[index]?.kind === 'insufficient')
                return '关联内容待核实，尚不能作为已确认结论';
            if (selection?.placement === 'reference')
                return `关联内容为参考材料，未作为当前结论${selection.reason ? `：${selection.reason}` : ''}`;
            return undefined;
        }),
    ),
);
</script>
<style scoped>
.structured-value {
    display: grid;
    gap: 0.5rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
p {
    margin: 0;
    white-space: pre-wrap;
}
.structured-links {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
}
a {
    display: inline-flex;
    min-block-size: 2.75rem;
    align-items: center;
    color: var(--scova-primary);
    text-underline-offset: 0.2em;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
