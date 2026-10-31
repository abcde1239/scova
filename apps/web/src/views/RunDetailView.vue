<template>
    <state-panel v-if="!execution.id.value" state="error" message="执行地址无效，请检查链接" />
    <execution-detail v-else-if="execution.run.value" :execution="execution" />
    <state-panel
        v-else
        :state="execution.query.isError.value ? 'error' : 'loading'"
        :message="failure"
        :retryable="execution.query.isError.value"
        @retry="retry"
    />
</template>

<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import StatePanel from '@/components/common/StatePanel.vue';
import ExecutionDetail from '@/components/run/ExecutionDetail.vue';
import { useExecution } from '@/composables/useExecution';
const route = useRoute();
const execution = useExecution(() => String(route.params.runId ?? ''));
async function retry() {
    const path = route.fullPath;
    await execution.query.refetch();
    await nextTick();
    if (route.fullPath === path && execution.run.value)
        document.getElementById('execution-status')?.focus();
}
const failure = computed(() => {
    const error = execution.query.error.value;
    if (!error) return '正在读取执行快照';
    if ('status' in error && error.status === 404) return '执行不存在或无权访问';
    if ('status' in error && error.status === 403) return '无权查看此执行';
    return '暂时无法读取执行，请检查连接后重试';
});
</script>
