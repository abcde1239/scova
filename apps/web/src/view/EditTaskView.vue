<template>
    <task-config-form
        v-if="loaded"
        :key="`${lifecycle.session.epoch}-${taskId}`"
        :initial-response="loaded"
    />
    <state-panel
        v-else
        :state="query.isPending.value || query.isFetching.value ? 'loading' : 'error'"
        :message="
            query.isPending.value || query.isFetching.value
                ? '正在读取任务配置与修订依据'
                : '任务无法编辑，请检查权限、版本或稍后重试'
        "
        :retryable="query.isError.value"
        @retry="query.refetch()"
    />
</template>

<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type { TaskDetailResponse } from '@scova/models';
import type { ApiResponse } from '@/api/client';
import TaskConfigForm from '@/component/tasks/TaskConfigForm.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { taskEditOptions } from '@/composable/useCreateTask';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
const route = useRoute();
const lifecycle = useSessionLifecycle();
const taskId = computed(() => (typeof route.params.taskId === 'string' ? route.params.taskId : ''));
const loaded = shallowRef<ApiResponse<TaskDetailResponse>>();
watch(
    () => `${lifecycle.session.epoch}-${taskId.value}`,
    () => {
        loaded.value = undefined;
    },
    { flush: 'sync' },
);
const query = useQuery(
    computed(() => taskEditOptions(lifecycle, taskId.value)),
    lifecycle.queryClient,
);
watch(
    [query.data, query.isFetchedAfterMount],
    ([value, fetched]) => {
        if (
            fetched &&
            query.isSuccess.value &&
            value &&
            !loaded.value &&
            value.data.task.id === taskId.value
        )
            loaded.value = value;
    },
    { immediate: true },
);
</script>
