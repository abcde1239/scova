<template>
    <div ref="detail" class="report-detail">
        <nav class="report-tools scova-glass scova-glass--report" aria-label="报告阅读工具">
            <router-link to="/account/appearance"
                ><app-icon name="appearance" />阅读外观</router-link
            >
        </nav>
        <report-brief v-if="report" :key="`${accountId}-${report.id}`" :report="report" />
        <section
            v-if="report"
            class="report-bookmarks scova-interface"
            aria-labelledby="report-bookmark-title"
        >
            <h2 id="report-bookmark-title">收藏报告来源</h2>
            <label for="bookmark-source">选择收藏来源</label>
            <select id="bookmark-source" v-model="selectedSource" :disabled="bookmarkBusy">
                <option value="">请选择一份资料</option>
                <option v-for="source in sources" :key="source.id" :value="source.id">
                    {{ source.title }}
                </option>
            </select>
            <p v-if="chosenSource">{{ chosenSource.title }}</p>
            <nav v-if="chosenSource" class="report-source-history" aria-label="所选来源历史与快照">
                <router-link :to="sourceHistoryLink(chosenSource.id)">查看来源历史</router-link>
                <router-link
                    v-for="evidence in chosenSnapshots"
                    :key="evidence.snapshotId"
                    :to="sourceHistoryLink(evidence.sourceId, evidence.snapshotId)"
                    >查看保存快照（{{ evidence.observedAt }}）</router-link
                >
            </nav>
            <bookmark-action
                v-if="chosenSource"
                :key="`${accountId}-${report.id}-${chosenSource.id}`"
                :source-id="chosenSource.id"
                :report-id="report.id"
            />
        </section>
        <state-panel
            v-else
            :state="valid && query.isPending.value ? 'loading' : 'error'"
            :message="valid && query.isPending.value ? '正在读取报告与引用' : error.message"
            :retryable="error.retryable && valid && query.isError.value"
            @retry="retry"
        />
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import ReportBrief from '@/components/reports/ReportBrief.vue';
import BookmarkAction from '@/components/library/BookmarkAction.vue';
import {
    bookmarkOrigin,
    bookmarksPending,
    reportBookmarkSources,
} from '@/composables/useBookmarks';
import StatePanel from '@/components/common/StatePanel.vue';
import { useReport } from '@/composables/useReport';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
const route = useRoute();
const lifecycle = useSessionLifecycle();
const accountId = computed(() => lifecycle.session.user?.id);
const { query, report, valid, error } = useReport(() => route.params.reportId, lifecycle);
const selectedSource = ref('');
const bookmarkBusy = computed(() => bookmarksPending(lifecycle));
const sources = computed(() => (report.value ? reportBookmarkSources(report.value) : []));
const chosenSource = computed(() =>
    sources.value.find((source) => source.id === selectedSource.value),
);
const chosenSnapshots = computed(() => [
    ...new Map(
        (report.value?.evidence ?? [])
            .filter((entry) => entry.sourceId.toLowerCase() === chosenSource.value?.id)
            .map((entry) => [entry.snapshotId.toLowerCase(), entry]),
    ).values(),
]);
function sourceHistoryLink(sourceId: string, snapshotId?: string) {
    return {
        path: `/library/sources/${sourceId}/snapshots${snapshotId ? `/${snapshotId}` : ''}`,
        ...(report.value
            ? { state: { bookmarkOrigin: bookmarkOrigin(lifecycle, report.value.id, sourceId) } }
            : {}),
    };
}
watch(
    () => `${accountId.value}-${report.value?.id}`,
    () => {
        selectedSource.value = '';
    },
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
.report-bookmarks {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
    border-block-start: 0.0625rem solid var(--scova-border);
    padding-block: 2rem;
}
.report-source-history {
    display: grid;
    gap: 0.75rem;
    min-inline-size: 0;
}
.report-bookmarks h2 {
    margin: 0;
    font-size: 1.25rem;
}
select {
    inline-size: 100%;
    min-inline-size: 0;
    max-inline-size: 100%;
    min-block-size: 2.75rem;
    padding: 0.625rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.5rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    font: inherit;
    cursor: pointer;
}
select:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
select:disabled {
    cursor: not-allowed;
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
