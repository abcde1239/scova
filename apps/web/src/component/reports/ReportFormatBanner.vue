<template>
    <div class="format-banner scova-interface" :class="`format-banner--${format}`">
        <div v-if="formats[format].description">
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
import { groupEvidence } from '@/utils/report/sources';
const props = defineProps<{ report: Report; format: Report['format'] }>();
const sourceCount = computed(() => groupEvidence(props.report.evidence).length);
const formats = {
    brief: { name: '简报', description: '' },
    list: { name: '主题清单', description: '' },
    comparison: { name: '对比表', description: '' },
    research_report: { name: '研究报告', description: '' },
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
.format-banner--research_report,
.format-banner--brief,
.format-banner--list,
.format-banner--comparison {
    @apply bg-transparent p-0 [border:0];
}
</style>
