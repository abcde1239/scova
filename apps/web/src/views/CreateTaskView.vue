<template>
    <task-config-form :key="lifecycle.session.epoch" @saved="saved" />
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import type { TaskDetailResponse } from '@scova/models';
import TaskConfigForm from '@/components/tasks/TaskConfigForm.vue';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
const router = useRouter();
const lifecycle = useSessionLifecycle();
function saved(result: TaskDetailResponse) {
    void router.replace({ name: 'task-summary', params: { taskId: result.task.id } });
}
</script>
