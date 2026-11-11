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
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.format-banner {
    @apply flex flex-wrap justify-between items-center gap-[0.75rem_1.5rem]
        [border-left:0.25rem_solid_var(--scova-primary)] [background:var(--scova-selected)] min-w-0
        break-anywhere p-4;
}
p {
    @apply leading-[1.6] m-0;
}
.format-name {
    @apply [font-weight:650] text-[1.125rem] mb-1;
}
.format-counts {
    @apply text-muted text-[0.875rem];
}
.format-banner--list {
    @apply rounded-3 [border-left:0];
}
.format-banner--comparison {
    @apply border-theme rounded-1;
}
.format-banner--research_report {
    @apply bg-transparent pl-0 pr-0 [border-inline:0]
        [border-block:0.1875rem_double_var(--scova-border)];
}
</style>
