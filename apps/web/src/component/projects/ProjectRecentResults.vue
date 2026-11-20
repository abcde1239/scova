<template>
    <div class="layout-grid gap-6 md:grid-cols-2">
        <section class="layout-grid content-start gap-3" aria-labelledby="project-runs">
            <h3 id="project-runs" class="m-0">最近执行</h3>
            <p v-if="!runs.length" class="m-0 text-muted">暂无执行记录</p>
            <ul v-else class="list-none layout-grid gap-2 p-0 m-0">
                <li
                    v-for="run in runs"
                    :key="run.id"
                    class="border-theme rounded-2 p-3 bg-surface break-anywhere"
                >
                    <router-link
                        class="internal-link"
                        :to="{ name: 'run-detail', params: { runId: run.id } }"
                        >{{ run.title }}</router-link
                    >
                    <p class="m-0 mt-1 text-muted text-sm">
                        {{ notificationStatus[run.status] }} ·
                        <time :datetime="run.queuedAt">{{ localTaskTime(run.queuedAt) }}</time>
                    </p>
                </li>
            </ul>
        </section>
        <section class="layout-grid content-start gap-3" aria-labelledby="project-reports">
            <h3 id="project-reports" class="m-0">最近报告</h3>
            <p v-if="!reports.length" class="m-0 text-muted">暂无报告</p>
            <ul v-else class="list-none layout-grid gap-2 p-0 m-0">
                <li
                    v-for="report in reports"
                    :key="report.id"
                    class="border-theme rounded-2 p-3 bg-surface break-anywhere"
                >
                    <router-link
                        class="internal-link"
                        :to="{ name: 'report-detail', params: { reportId: report.id } }"
                        >{{ report.title }}</router-link
                    >
                    <p class="m-0 mt-1 text-muted text-sm">
                        <time :datetime="report.publishedAt">{{
                            localTaskTime(report.publishedAt)
                        }}</time>
                    </p>
                </li>
            </ul>
        </section>
    </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { ProjectDetailResponse } from '@scova/models';
import { notificationStatus } from '@/composable/useNotifications';
import { localTaskTime } from '@/composable/useTasks';

defineProps<{
    runs: ProjectDetailResponse['recentRuns'];
    reports: ProjectDetailResponse['recentReports'];
}>();
</script>
