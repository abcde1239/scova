<template>
    <div class="format-banner scova-interface" :class="`format-banner--${format}`">
        <div>
            <p class="format-name">{{ formats[format].name }}</p>
            <p>{{ formats[format].description }}</p>
        </div>
        <p class="format-counts">
            {{ report.coverage.reportValue?.questions.length ?? report.claims.length }}
            {{ report.coverage.reportValue ? '个问题' : '个信息项' }} · {{ sourceCount }} 个来源
        </p>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Report } from '@scova/models';
const props = defineProps<{ report: Report; format: Report['format'] }>();
const sourceCount = computed(
    () => new Set(props.report.evidence.map((entry) => entry.sourceId.toLowerCase())).size,
);
const formats = {
    brief: { name: '简报', description: '集中阅读主要发现。' },
    list: { name: '主题清单', description: '按主题逐项浏览，展开卡片中的来源核对信息。' },
    comparison: { name: '信息对照表', description: '逐行对照问题、收集内容与来源依据。' },
    research_report: { name: '研究报告', description: '通过目录阅读各章节，沿引用追溯研究材料。' },
};
</script>

<style scoped>
.format-banner {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem 1.5rem;
    padding: 1rem;
    border-inline-start: 0.25rem solid var(--scova-primary);
    background: var(--scova-selected);
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
p {
    margin: 0;
    line-height: 1.6;
}
.format-name {
    font-weight: 650;
    font-size: 1.125rem;
    margin-block-end: 0.25rem;
}
.format-counts {
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.format-banner--list {
    border-radius: 0.75rem;
    border-inline-start: 0;
}
.format-banner--comparison {
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.25rem;
}
.format-banner--research_report {
    background: transparent;
    padding-inline: 0;
    border-inline: 0;
    border-block: 0.1875rem double var(--scova-border);
}
</style>
