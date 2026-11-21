<template>
    <header class="workspace-heading scova-interface">
        <div>
            <p class="workspace-eyebrow">
                <router-link :to="inboxDestination">收件箱</router-link
                ><span aria-hidden="true"> / </span>{{ report?.title ?? '报告' }}
            </p>
            <p v-if="report" class="workspace-description">
                <time :datetime="report.publishedAt">{{
                    new Date(report.publishedAt).toLocaleDateString('zh-CN')
                }}</time>
                ·
                <router-link :to="`/tasks/${report.taskId}/edit`">修改定期研究设置</router-link>
            </p>
        </div>
        <nav class="report-tools" aria-label="报告阅读工具">
            <navigation-button v-if="returnTo" :to="inboxDestination">
                <app-icon name="back" />返回收件箱
            </navigation-button>
            <navigation-button to="/account/appearance" icon="appearance" label="阅读外观"
                >外观</navigation-button
            >
            <navigation-button v-if="report" :to="`/runs/${report.runId}`" icon="tasks"
                >执行详情</navigation-button
            >
            <template v-if="report">
                <report-export-button
                    v-for="format in exportFormats"
                    :key="`${report.id}:${format}`"
                    :report-id="report.id"
                    :format="format"
                />
            </template>
            <button
                v-if="report"
                type="button"
                class="open-current-artifact report-open-button"
                @click="emit('openArtifact')"
            >
                成果
            </button>
        </nav>
    </header>
</template>
<script setup lang="ts">
import type { Report } from '@scova/models';
import { computed } from 'vue';
import type { inboxReturn } from '@/composable/useInbox';
import NavigationButton from '@/component/common/NavigationButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import ReportExportButton from '@/component/reports/ReportExportButton.vue';
const exportFormats = ['markdown', 'json'] as const;
const props = defineProps<{ report?: Report; returnTo?: ReturnType<typeof inboxReturn> }>();
const inboxDestination = computed(() =>
    props.returnTo
        ? { path: props.returnTo.path, state: { inboxRestore: { ...props.returnTo } } }
        : '/inbox',
);
const emit = defineEmits<{ openArtifact: [] }>();
</script>
<style scoped>
.workspace-heading {
    @apply flex flex-wrap items-center gap-[0.75rem_1rem] min-w-0 justify-between;
}
.workspace-heading > div {
    @apply min-w-0 break-anywhere;
}
.workspace-eyebrow {
    @apply font-semibold m-0 text-[1.0625rem] [text-wrap:balance];
}
.workspace-description {
    @apply text-muted text-[0.875rem] leading-[1.6] m-0 mt-1.5;
}
.report-tools {
    @apply flex flex-wrap items-start gap-2 justify-self-start min-w-0 max-w-full p-0;
}
a {
    @apply inline-flex items-center gap-2 min-h-11 internal-link cursor-pointer break-anywhere;
}
a:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
@media (width < 72rem) {
    .report-tools :deep(.navigation-button) {
        @apply hidden;
    }
    .workspace-description {
        @apply text-xs;
    }
}
@media (max-width: 39.999rem) {
    .report-tools :deep(.navigation-button) {
        @apply pl-2.5 pr-2.5;
    }
}
</style>
