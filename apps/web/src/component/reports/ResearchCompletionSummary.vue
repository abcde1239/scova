<template>
    <div class="layout-grid gap-2 scova-interface" aria-label="回答与外部核验">
        <research-coverage-summary :metrics="coverage.metrics" />
        <p v-if="coverage.completion" class="m-0">
            {{ coverage.completion.answerReady ? '回答已完成' : '回答待补充' }} ·
            {{ coverage.completion.externalEvidenceComplete ? '外部证据完整' : '外部证据待补充'
            }}<template v-if="coverage.completion.stopReason">
                · 停止原因：{{ stopLabels[coverage.completion.stopReason] }}</template
            >
        </p>
        <p v-if="coverage.baseline?.modelOnlyFields" class="m-0">
            仅模型回答：{{ coverage.baseline.modelOnlyFields }} 个字段
        </p>
        <p
            v-if="
                coverage.completion?.stopReason === 'source_limited' &&
                coverage.sourceRestrictions?.length
            "
            class="text-muted m-0"
        >
            搜索中发现但被任务来源范围排除：{{
                coverage.sourceRestrictions.join('、')
            }}。可在任务来源设置中调整查阅范围。
        </p>
    </div>
</template>
<script setup lang="ts">
import type { Coverage } from '@scova/models';
import ResearchCoverageSummary from '@/component/reports/ResearchCoverageSummary.vue';
defineProps<{ coverage: Coverage }>();
const stopLabels = {
    verified: '外部核验完成',
    no_progress: '继续查阅未取得新证据',
    budget: '执行预算已用尽',
    deadline: '执行时间已用尽',
    provider_unavailable: '研究服务暂不可用',
    iteration_limit: '已达核验轮次上限',
    source_limited: '任务来源范围受限',
};
</script>
