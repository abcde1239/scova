<template>
    <div ref="detail" class="report-detail">
        <nav class="report-tools scova-glass scova-glass--report" aria-label="报告阅读工具">
            <router-link to="/account/appearance"
                ><app-icon name="appearance" />阅读外观</router-link
            >
        </nav>
        <report-brief v-if="report" :key="`${accountId}-${report.id}`" :report="report" />
        <state-panel
            v-else
            :state="valid && query.isPending.value ? 'loading' : 'error'"
            :message="valid && query.isPending.value ? '正在读取报告与引用' : error.message"
            :retryable="error.retryable && valid && query.isError.value"
            @retry="retry"
        />
        <report-questions
            v-if="questionIdentity"
            :key="questionIdentity"
            :report-id="String(route.params.reportId)"
            :report="report"
        />
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import ReportBrief from '@/components/reports/ReportBrief.vue';
import ReportQuestions from '@/components/reports/ReportQuestions.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import { useReport } from '@/composables/useReport';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
const route = useRoute();
const lifecycle = useSessionLifecycle();
const accountId = computed(() => lifecycle.session.user?.id);
const { query, report, valid, error } = useReport(() => route.params.reportId, lifecycle);
// Keep only the editor identity, never a second Report cache, across same-owner read failures.
const questionIdentity = ref('');
const routeIdentity = computed(
    () => `${lifecycle.session.epoch}:${accountId.value ?? ''}:${route.params.reportId}`,
);
watch(
    routeIdentity,
    () => {
        questionIdentity.value = '';
    },
    { flush: 'sync' },
);
watch(
    report,
    (value) => {
        if (value) questionIdentity.value = routeIdentity.value;
    },
    { immediate: true, flush: 'sync' },
);
const detail = ref<HTMLElement>();
async function retry() {
    const restoreFocus = detail.value?.contains(document.activeElement);
    await query.refetch();
    if (restoreFocus && report.value) {
        await nextTick();
        detail.value?.querySelector<HTMLElement>('#report-title')?.focus();
    }
}
</script>

<style scoped>
.report-detail {
    display: grid;
    gap: 2rem;
    min-inline-size: 0;
}
.report-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    padding: 0.5rem 1rem;
    justify-self: start;
    max-inline-size: 100%;
}
a {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
    overflow-wrap: anywhere;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
