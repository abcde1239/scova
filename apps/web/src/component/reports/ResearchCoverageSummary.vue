<template>
    <dl
        v-if="metrics"
        class="scova-interface flex flex-wrap gap-x-6 gap-y-2 m-0"
        aria-label="研究覆盖统计"
    >
        <div class="flex flex-wrap gap-2">
            <dt>回答完成</dt>
            <dd class="m-0 tabular-nums">
                {{ metrics.answeredQuestions }}/{{ metrics.questionCount }}
            </dd>
        </div>
        <div class="flex flex-wrap gap-2">
            <dt>外部证据支持</dt>
            <dd class="m-0 tabular-nums">
                {{ metrics.externallySupportedQuestions }}/{{ metrics.questionCount }}
            </dd>
        </div>
        <div class="flex flex-wrap gap-2">
            <dt>仍未解决</dt>
            <dd class="m-0 tabular-nums">{{ metrics.unresolvedQuestionIds.length }}</dd>
        </div>
    </dl>
</template>
<script setup lang="ts">
import type { ResearchMetrics } from '@scova/models';
defineProps<{ metrics?: ResearchMetrics }>();
</script>
