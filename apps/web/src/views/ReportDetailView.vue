<template>
    <div ref="detail" class="report-detail">
        <nav class="report-tools scova-glass scova-glass--report" aria-label="报告阅读工具">
            <router-link to="/account/appearance"
                ><app-icon name="appearance" />阅读外观</router-link
            >
        </nav>
        <report-brief v-if="report" :key="`${accountId}-${report.id}`" :report="report" />
        <notes-panel
            v-if="notesSession === notesIdentity"
            :key="`notes-${notesIdentity}`"
            :targets="noteTargets"
            :initial-target="{ kind: 'report', id: String(route.params.reportId) }"
            :available="!!report"
        />
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
import NotesPanel from '@/components/library/NotesPanel.vue';
import { bookmarksPending, reportBookmarkSources } from '@/composables/useBookmarks';
import StatePanel from '@/components/common/StatePanel.vue';
import { useReport } from '@/composables/useReport';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
const route = useRoute();
const lifecycle = useSessionLifecycle();
const accountId = computed(() => lifecycle.session.user?.id);
const { query, report, valid, error } = useReport(() => route.params.reportId, lifecycle);
const notesIdentity = computed(
    () => `${lifecycle.session.epoch}:${accountId.value}:${route.params.reportId}`,
);
const notesSession = ref('');
watch(
    () => report.value,
    (value) => {
        if (value && lifecycle.session.user && valid.value)
            notesSession.value = notesIdentity.value;
    },
    { immediate: true, flush: 'sync' },
);
const selectedSource = ref('');
const bookmarkBusy = computed(() => bookmarksPending(lifecycle));
const sources = computed(() => (report.value ? reportBookmarkSources(report.value) : []));
const noteTargets = computed(() =>
    report.value
        ? [
              {
                  kind: 'report' as const,
                  id: report.value.id,
                  label: `本报告：${report.value.title}`,
              },
              ...sources.value.map((source) => ({
                  kind: 'source' as const,
                  id: source.id,
                  label: source.title,
              })),
          ]
        : [],
);
const chosenSource = computed(() =>
    sources.value.find((source) => source.id === selectedSource.value),
);
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
