<template>
    <article class="layout-grid min-w-0 rounded-3 border-theme bg-surface break-anywhere">
        <div class="layout-grid gap-3 p-3">
            <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0">
                    <h4 class="m-0 text-base">{{ draft.config.title }}</h4>
                    <p class="m-0 text-sm text-muted">研究草案 · 第 {{ draft.revision }} 版</p>
                </div>
                <span class="draft-tag">{{ draft.taskId ? '已提交' : '待确认' }}</span>
            </div>
            <p class="m-0 whitespace-pre-wrap">{{ draft.config.goal }}</p>
            <ul v-if="draft.config.focusPoints.length" class="m-0 pl-5">
                <li v-for="(point, index) in draft.config.focusPoints" :key="index">{{ point }}</li>
            </ul>
            <ul class="flex flex-wrap gap-2 m-0 p-0 list-none" aria-label="研究配置摘要">
                <li class="draft-tag">范围 {{ range }}</li>
                <li v-if="draft.config.sourcePreferences.officialOnly" class="draft-tag">
                    仅官方来源
                </li>
                <li class="draft-tag">成果 {{ formats }}</li>
                <li class="draft-tag">预算 {{ draft.config.budget.maxPages }} 页</li>
            </ul>
        </div>
        <div class="draft-actions flex flex-wrap items-center gap-2 p-3">
            <template v-if="draft.taskId">
                <router-link
                    class="internal-link"
                    :to="{ name: 'task-summary', params: { taskId: draft.taskId } }"
                    >查看任务</router-link
                >
                <router-link
                    v-if="draft.runId"
                    class="internal-link"
                    :to="{ name: 'run-detail', params: { runId: draft.runId } }"
                    >查看执行</router-link
                >
            </template>
            <template v-else>
                <router-link
                    class="internal-link keyboard-focus min-h-11 inline-flex items-center"
                    :to="{ name: 'project-draft-edit', params: { projectId, draftId: draft.id } }"
                    >在表单中编辑</router-link
                >
                <action-button :disabled="busy" @click="$emit('adjust')">继续调整</action-button>
                <action-button :disabled="busy" @click="$emit('confirm', false)"
                    >保存任务</action-button
                >
                <action-button type="primary" :disabled="busy" @click="$emit('confirm', true)"
                    >保存并立即运行</action-button
                >
            </template>
        </div>
    </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectResearchDraft, TaskConfig } from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';

const props = defineProps<{ draft: ProjectResearchDraft; projectId: string; busy: boolean }>();
defineEmits<{ adjust: []; confirm: [start: boolean] }>();
const formatLabels: Record<TaskConfig['outputFormat'], string> = {
    brief: '简报',
    list: '主题清单',
    comparison: '对比表',
    research_report: '研究报告',
};
const formats = computed(() => {
    const config = props.draft.config;
    return (config.outputFormats ?? [config.outputFormat])
        .map((value) => formatLabels[value])
        .join('、');
});
const range = computed(() => {
    const time = props.draft.config.timeRange;
    if (time.kind === 'rolling') return `近 ${time.days} 天`;
    if (time.kind === 'fixed') return '固定日期';
    return '不限日期';
});
</script>

<style scoped>
.draft-tag {
    @apply text-sm rounded-2 px-2 py-0.5 [background:var(--scova-selected)];
}
.draft-actions {
    @apply [border-top:1px_solid_var(--scova-border)];
}
</style>
