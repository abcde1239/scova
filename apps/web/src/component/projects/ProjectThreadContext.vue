<template>
    <section class="grid gap-4 min-w-0 break-anywhere" aria-label="项目概览">
        <div>
            <h2 class="text-base m-0">项目概览</h2>
            <p class="text-muted text-sm mt-1 mb-0">{{ detail?.project.name }}</p>
        </div>
        <project-recent-results
            v-if="detail"
            :runs="detail.recentRuns.slice(0, 3)"
            :reports="detail.recentReports.slice(0, 3)"
            stacked
        />
        <router-link class="internal-link" :to="{ name: 'project-legacy', params: { projectId } }"
            >打开项目管理</router-link
        >
        <router-link
            class="internal-link"
            :to="{ name: 'project-task-create', params: { projectId } }"
            >手动新建项目任务</router-link
        >
    </section>
</template>

<script setup lang="ts">
import type { ProjectDetailResponse } from '@scova/models';
import ProjectRecentResults from '@/component/projects/ProjectRecentResults.vue';

defineProps<{ projectId: string; detail?: ProjectDetailResponse }>();
</script>
