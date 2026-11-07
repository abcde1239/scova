<template>
    <article class="report-history-entry" :aria-labelledby="`history-title-${item.id}`">
        <h2 :id="`history-title-${item.id}`" class="scova-content-title">
            <router-link
                :id="`history-report-${item.id}`"
                :to="{ name: 'report-detail', params: { reportId: item.id } }"
                @click="emit('open', item.id, $event)"
                >{{ item.title }}</router-link
            >
        </h2>
        <p class="history-metadata">
            <strong>{{ item.mode === 'demo' ? '演示报告' : '真实查阅' }}</strong>
            <span>{{
                item.coverage.completeness === 'partial' ? '有范围说明' : '计划范围内完成'
            }}</span>
            <time :datetime="item.publishedAt">{{ localTaskTime(item.publishedAt) }}</time>
        </p>
        <p v-if="item.coverage.completeness === 'partial'" class="partial">
            结果已生成，未覆盖项目见报告详情。
        </p>
        <p class="history-summary">{{ item.summary }}</p>
        <router-link class="run-link" :to="{ name: 'run-detail', params: { runId: item.runId } }"
            ><app-icon name="run" />查看对应执行</router-link
        >
    </article>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { ReportHistoryItem } from '@/api/reports';
import AppIcon from '@/components/common/AppIcon.vue';
import { localTaskTime } from '@/composables/useTasks';
import '@/styles/reading-fonts.css';
defineProps<{ item: ReportHistoryItem }>();
const emit = defineEmits<{ open: [reportId: string, event: MouseEvent] }>();
</script>

<style scoped>
.report-history-entry {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    padding-block: 2rem;
    border-block-end: 0.0625rem solid var(--scova-border);
    overflow-wrap: anywhere;
}
h2,
p {
    margin: 0;
}
h2 a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    color: var(--scova-text);
    text-decoration: none;
}
h2 a:hover {
    color: var(--scova-primary);
    text-decoration: underline;
}
a {
    cursor: pointer;
    text-underline-offset: 0.2em;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.history-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
    color: var(--scova-muted);
}
strong {
    color: var(--scova-text);
    font-weight: 500;
}
.partial {
    color: var(--scova-partial);
    font-weight: 500;
}
.history-summary {
    max-inline-size: 60ch;
    white-space: pre-wrap;
}
.run-link {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    justify-self: start;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    color: var(--scova-primary);
}
</style>
