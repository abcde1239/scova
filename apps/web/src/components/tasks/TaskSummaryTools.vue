<template>
    <navigation-button
        v-if="taskId"
        class="keyboard-focus-wide [&&]:(inline-flex items-center min-h-11 scova-link cursor-pointer)"
        icon="edit"
        :to="{ name: 'task-edit', params: { taskId } }"
        >编辑任务配置</navigation-button
    >
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import NavigationButton from '@/components/common/NavigationButton.vue';
const route = useRoute();
const taskId = computed(() => (typeof route.params.taskId === 'string' ? route.params.taskId : ''));
</script>
