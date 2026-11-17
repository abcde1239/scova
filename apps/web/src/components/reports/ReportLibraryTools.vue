<template>
    <tool-section v-if="notesSession === notesIdentity" label="笔记" icon="edit" class="notes-tool">
        <notes-panel
            v-if="notesSession === notesIdentity"
            :key="`notes-${notesIdentity}`"
            :targets="noteTargets"
            :initial-target="{ kind: 'report', id: reportId }"
            :available="!!report"
        />
    </tool-section>
    <tool-section v-if="report" label="收藏与来源" icon="bookmark" class="bookmarks-tool">
        <section
            v-if="report"
            class="report-bookmarks scova-interface"
            aria-labelledby="report-bookmark-title"
        >
            <h2 id="report-bookmark-title"><app-icon name="bookmark" />收藏报告来源</h2>
            <label for="bookmark-source">选择收藏来源</label>
            <select
                id="bookmark-source"
                class="report-select"
                v-model="selectedSource"
                :disabled="bookmarkBusy"
            >
                <option value="">请选择一份资料</option>
                <option v-for="source in sources" :key="source.id" :value="source.id">
                    {{ source.title }}
                </option>
            </select>
            <p v-if="chosenSource">{{ chosenSource.title }}</p>
            <nav v-if="chosenSource" class="report-source-history" aria-label="所选来源历史与快照">
                <navigation-button :to="sourceHistoryLink(chosenSource.id)" icon="library"
                    >查看来源历史</navigation-button
                >
                <navigation-button
                    v-for="evidence in chosenSnapshots"
                    :key="evidence.snapshotId"
                    :to="sourceHistoryLink(evidence.sourceId, evidence.snapshotId)"
                    >查看保存快照（{{ evidence.observedAt }}）</navigation-button
                >
            </nav>
            <bookmark-action
                v-if="chosenSource"
                :key="`${accountId}-${report.id}-${chosenSource.id}`"
                :source-id="chosenSource.id"
                :report-id="report.id"
            />
        </section>
    </tool-section>
</template>

<script setup lang="ts">
import ToolSection from '@/components/common/ToolSection.vue';
import NotesPanel from '@/components/library/NotesPanel.vue';
import BookmarkAction from '@/components/library/BookmarkAction.vue';
import NavigationButton from '@/components/common/NavigationButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { computed, ref, toRef, watch } from 'vue';
import type { Report } from '@scova/models';
import {
    bookmarkOrigin,
    bookmarksPending,
    reportBookmarkSources,
} from '@/composables/useBookmarks';
import { useSessionLifecycle } from '@/composables/useSessionQuery';

const props = defineProps<{ report?: Report; reportId: string }>();
const report = toRef(props, 'report');
const lifecycle = useSessionLifecycle();
const accountId = computed(() => lifecycle.session.user?.id);
const notesIdentity = computed(
    () => `${lifecycle.session.epoch}:${accountId.value}:${props.reportId}`,
);
const notesSession = ref('');
watch(
    () => report.value,
    (value) => {
        if (value && lifecycle.session.user) notesSession.value = notesIdentity.value;
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
</script>

<style scoped>
.report-bookmarks {
    @apply layout-stack break-anywhere [border-top:0.0625rem_solid_var(--scova-border)] pt-4 pb-4;
}

.report-source-history {
    @apply layout-grid gap-3;
}

.report-bookmarks h2 {
    @apply flex items-center gap-2 text-[1.25rem] m-0;
}
.tool-section :deep(.notes-panel),
.tool-section :deep(.report-bookmarks) {
    @apply w-full [border:0] bg-transparent p-0;
}
</style>
