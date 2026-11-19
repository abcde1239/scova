<template>
    <navigation-button v-if="taskId" icon="edit" :to="{ name: 'task-edit', params: { taskId } }"
        >编辑任务配置</navigation-button
    >
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import NavigationButton from '@/component/common/NavigationButton.vue';
const route = useRoute();
const taskId = computed(() => (typeof route.params.taskId === 'string' ? route.params.taskId : ''));
</script>
