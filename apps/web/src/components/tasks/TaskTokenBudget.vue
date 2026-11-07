<template>
    <section class="token-budget" aria-label="Token 分配测算" aria-live="polite">
        <template v-if="allocation">
            <p>
                按最多 {{ allocation.pages }} 页、{{ allocation.batches.length }}
                批比较及各阶段一次修复测算：
            </p>
            <table>
                <caption>
                    输出 token 分配
                </caption>
                <thead>
                    <tr>
                        <th scope="col">阶段</th>
                        <th scope="col">首次</th>
                        <th scope="col">修复预留</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in rows" :key="row.label">
                        <th scope="row">{{ row.label }}</th>
                        <td>{{ number(row.limits.initial) }}</td>
                        <td>{{ number(row.limits.repair) }}</td>
                    </tr>
                </tbody>
            </table>
            <p>
                各批比较首次额度：{{
                    allocation.batches.map((batch) => number(batch.initial)).join('、')
                }}
                token。
            </p>
            <p class="token-output-total">
                分配合计 {{ number(allocation.allocated) }} / {{ number(output) }}；未分配
                {{ number(Math.max(0, allocation.remaining)) }} token。
            </p>
            <p v-if="allocation.overBudget" class="budget-warning" role="alert">
                输出总额不足以容纳阶段分配与修复预留，请增加累计输出 token
                上限。历史任务未改预算时可保留，执行仍受累计上限保护。
            </p>
            <p v-else-if="allocation.limited" class="budget-warning">
                当前输出预算较低，部分比较或报告步骤可能跳过，只交付不完整结果。建议增加输出额度或减少读取页数。
            </p>
            <p v-else-if="allocation.comparisonTight" class="budget-warning">
                比较额度偏紧，单批内容较多时容易截断。
                <template v-if="allocation.recommendedPages"
                    >建议将网页读取次数降至
                    {{ allocation.recommendedPages }} 页以内，或增加输出总额后重新测算。</template
                >
                <template v-else>建议增加输出总额后重新测算。</template>
                比较阶段有固定封顶，单纯增加总额不一定能扩大每批额度。这是基于本地测试的提示，不保证完整输出。
            </p>
            <p>
                输入累计上限 {{ number(input) }} token；单次输入上限：规划
                {{ number(allocation.input.planning) }}、每批比较
                {{ number(allocation.input.comparison) }}、报告
                {{ number(allocation.input.synthesis) }}。
            </p>
            <p>
                以上为额度预留，不是预计消耗。实际页数较少或无需修复时，报告可用额度会增加；每次请求还会按剩余额度收紧。输入按实际提示与正文预留，累计输入、输出分别守住总额。达到输出硬上限仍可能截断。
            </p>
        </template>
        <p v-else>请填写有效的正整数输入、输出额度和网页读取次数，以计算分配。</p>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { taskTokenAllocation } from '@scova/models';
const props = defineProps<{ input: number; output: number; pages: number }>();
const allocation = computed(() =>
    taskTokenAllocation({
        maxInputTokens: props.input,
        maxOutputTokens: props.output,
        maxPages: props.pages,
    }),
);
const rows = computed(() =>
    allocation.value
        ? [
              { label: '规划', limits: allocation.value.planning },
              { label: '来源比较', limits: allocation.value.comparison },
              { label: '报告生成', limits: allocation.value.synthesis },
          ]
        : [],
);
const number = (value: number) => value.toLocaleString('zh-CN');
</script>

<style scoped>
.token-budget {
    display: grid;
    gap: 1rem;
    margin-block-start: 1.5rem;
    min-inline-size: 0;
}
p {
    margin: 0;
    color: var(--scova-muted);
    overflow-wrap: anywhere;
}
table {
    inline-size: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
}
caption {
    text-align: start;
    font-weight: 600;
    margin-block-end: 0.5rem;
}
th,
td {
    padding: 0.5rem 0.25rem;
    text-align: end;
    overflow-wrap: anywhere;
    border-block-end: 0.0625rem solid var(--scova-border);
}
th:first-child {
    text-align: start;
}
.budget-warning {
    color: var(--scova-danger);
}
</style>
