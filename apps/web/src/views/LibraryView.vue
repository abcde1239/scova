<template>
    <section
        id="library-content"
        ref="root"
        class="library-view"
        :style="reading.variables"
        aria-labelledby="page-title"
        tabindex="-1"
    >
        <header>
            <nav aria-label="资料库分区" class="library-tabs scova-interface">
                <button
                    :aria-current="section === 'bookmarks' ? 'page' : undefined"
                    @click="showBookmarks"
                >
                    收藏
                </button>
                <button
                    :aria-current="section === 'notes' ? 'page' : undefined"
                    @click="showNotes()"
                >
                    笔记
                </button>
                <navigation-button to="/library/search" icon="search"
                    >搜索已存资料</navigation-button
                >
            </nav>
        </header>
        <div v-show="section === 'bookmarks'" class="bookmark-content">
            <p v-if="items.length">保存报告中已有的来源；取消收藏不会删除来源、报告或引用证据。</p>
            <div
                v-if="!query.isSuccess.value || items.length || previous.length"
                class="library-toolbar scova-interface"
            >
                <action-button :disabled="pending || query.isFetching.value" @click="reload"
                    ><app-icon name="retry" />重新读取本页</action-button
                >
                <action-button :disabled="pending || query.isFetching.value" @click="first"
                    ><app-icon name="retry" />从第一页重新读取</action-button
                >
            </div>
            <p v-if="query.isPending.value" role="status">正在读取收藏。</p>
            <p v-if="query.isError.value" role="alert">
                {{ bookmarkReadError(query.error.value) }}
            </p>
            <p v-if="query.isError.value && items.length">
                以下保留上次读取值，请重新读取以确认当前状态。
            </p>
            <state-panel
                v-if="query.isSuccess.value && !items.length"
                state="empty"
                icon="bookmark"
                message="暂无收藏"
            />
            <p v-if="paginationError" role="alert">{{ paginationError }}</p>
            <ul class="bookmark-list">
                <li v-for="item in items" :key="item.id" class="bookmark-entry">
                    <h2 class="scova-content-title">
                        {{ item.source.title ?? item.source.canonicalUrl }}
                    </h2>
                    <p class="source-summary scova-interface">
                        {{ sourceDomain(item.source.canonicalUrl) }} · 收藏于
                        <time :datetime="item.createdAt">{{ shortDate(item.createdAt) }}</time>
                    </p>
                    <div class="source-actions scova-interface">
                        <details class="source-details">
                            <summary>来源详情</summary>
                            <p v-if="item.source.title">
                                {{ item.source.canonicalUrl }}
                            </p>
                            <dl class="scova-interface">
                                <div>
                                    <dt>收藏时间</dt>
                                    <dd>
                                        <time :datetime="item.createdAt">{{ item.createdAt }}</time>
                                    </dd>
                                </div>
                                <div>
                                    <dt>最近查阅</dt>
                                    <dd>
                                        <time
                                            v-if="item.source.lastObservedAt"
                                            :datetime="item.source.lastObservedAt"
                                            >{{ item.source.lastObservedAt }}</time
                                        ><span v-else>未记录</span>
                                    </dd>
                                </div>
                            </dl>
                        </details>
                        <a
                            v-if="sourceLink(item.source.canonicalUrl)"
                            :href="sourceLink(item.source.canonicalUrl)"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="scova-interface external-link"
                        >
                            打开原始来源（新窗口）<app-icon name="source" />
                        </a>
                        <navigation-button :to="historyLink(item.sourceId)" class="scova-interface"
                            >查看来源历史</navigation-button
                        >
                        <navigation-button
                            v-if="origin?.sourceId === item.sourceId.toLowerCase()"
                            :to="origin.path"
                            class="scova-interface"
                            >返回刚才的报告</navigation-button
                        >
                        <action-button
                            quaternary
                            @click="
                                showNotes({
                                    kind: 'source',
                                    id: item.sourceId,
                                    label: item.source.title ?? item.source.canonicalUrl,
                                })
                            "
                            >为此来源记笔记</action-button
                        >
                    </div>
                    <bookmark-action
                        :key="`${accountId}-${item.id}`"
                        :source-id="item.sourceId"
                        :bookmark="item"
                        @started="bookmarkFocus = true"
                        @settled="bookmarkSettled"
                    />
                </li>
            </ul>
            <nav class="pagination scova-interface" aria-label="收藏分页">
                <action-button v-if="previous.length" :disabled="!canPage" @click="turn('back')"
                    >上一页</action-button
                >
                <action-button
                    v-if="query.data.value?.data.nextCursor"
                    :disabled="!canPage || !!paginationError"
                    @click="turn('next')"
                    >下一页</action-button
                >
            </nav>
        </div>
        <notes-panel
            v-show="section === 'notes'"
            ref="notes"
            :targets="noteTargets"
            :initial-target="noteTarget"
            :active="section === 'notes'"
            allow-all
        />
    </section>
</template>

<script setup lang="ts">
import NavigationButton from '@/components/common/NavigationButton.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import BookmarkAction from '@/components/library/BookmarkAction.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import {
    bookmarkOrigin,
    bookmarkReadError,
    readBookmarkOrigin,
    useBookmarks,
} from '@/composables/useBookmarks';
import { useReadingTypography } from '@/composables/useReadingTypography';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { sourceLink } from '@/composables/useReport';
import NotesPanel from '@/components/library/NotesPanel.vue';
import type { NoteTarget } from '@/api/notes';
import { noteTargetKey } from '@/utils/notes';
const lifecycle = useSessionLifecycle();
const root = ref<HTMLElement>();
const route = useRoute();
const accountId = computed(() => lifecycle.session.user?.id);
const { reading } = useReadingTypography();
const section = ref<'bookmarks' | 'notes'>('bookmarks');
function sourceDomain(url: string) {
    try {
        return new URL(url).hostname;
    } catch {
        return '来源地址待核对';
    }
}
function shortDate(value: string) {
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value));
}
const notes = ref<InstanceType<typeof NotesPanel>>();
const noteTarget = ref<NoteTarget>();
const { query, items, previous, paginationError, pending, canPage, next, back, first, reload } =
    useBookmarks(lifecycle);
const noteTargets = computed(() => [
    ...new Map(
        [
            ...items.value.map((item) => ({
                kind: 'source' as const,
                id: item.sourceId,
                label: item.source.title ?? item.source.canonicalUrl,
            })),
            ...(noteTarget.value ? [noteTarget.value] : []),
        ].map((item) => [noteTargetKey(item), item]),
    ).values(),
]);
function showBookmarks() {
    if (section.value === 'notes' && !notes.value?.leave()) return;
    section.value = 'bookmarks';
}
function showNotes(target?: NoteTarget) {
    if (target && !notes.value?.selectTarget(target)) return;
    if (target) noteTarget.value = target;
    section.value = 'notes';
}
watch(
    () => lifecycle.session.epoch,
    () => {
        noteTarget.value = undefined;
        section.value = 'bookmarks';
    },
);
const origin = computed(() => {
    void route.fullPath;
    return readBookmarkOrigin(lifecycle, window.history.state?.bookmarkOrigin);
});
function historyLink(sourceId: string) {
    const current = origin.value;
    return {
        path: `/library/sources/${sourceId}/snapshots`,
        ...(current?.sourceId === sourceId.toLowerCase()
            ? {
                  state: {
                      bookmarkOrigin: bookmarkOrigin(
                          lifecycle,
                          current.path.slice('/reports/'.length),
                          sourceId,
                      ),
                  },
              }
            : {}),
    };
}
let pageFocus = false;
let bookmarkFocus = false;
async function restoreFocus() {
    await nextTick();
    if (root.value?.isConnected && document.activeElement === document.body) root.value.focus();
}
async function turn(direction: 'back' | 'next') {
    pageFocus = !!root.value?.contains(document.activeElement);
    if (direction === 'next') next();
    else back();
    await nextTick();
    if (!query.isFetching.value && pageFocus) {
        pageFocus = false;
        await restoreFocus();
    }
}
async function bookmarkSettled() {
    bookmarkFocus = false;
    await restoreFocus();
}
watch(
    () => [query.isFetching.value, pending.value],
    async ([fetching, busy]) => {
        if (!fetching && !busy && (pageFocus || bookmarkFocus)) {
            pageFocus = false;
            bookmarkFocus = false;
            await restoreFocus();
        }
    },
);
</script>

<style scoped>
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.library-view,
.bookmark-content,
header,
.bookmark-entry {
    @apply report-grid;
}
.library-view {
    @apply gap-8;
}
.library-view :deep(.state-panel--empty) {
    @apply box-border w-full min-h-[clamp(14rem,_30dvh,_20rem)] [align-content:center];
}
h2,
p {
    @apply m-0;
}
h2 {
    @apply text-[1.25rem] font-semibold;
}
header nav {
    @apply flex flex-wrap items-center gap-4 [border-bottom:0.0625rem_solid_var(--scova-border)];
}
header nav button {
    @apply font-inherit min-h-11 pt-3 pr-4 pb-3 pl-4 bg-transparent text-default [border:0] cursor-pointer;
}
header nav button[aria-current='page'] {
    @apply [border-bottom:0.1875rem_solid_var(--scova-primary)];
}
header nav button:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
.bookmark-list {
    @apply list-none min-w-0 m-0 p-0;
}
.bookmark-entry {
    @apply gap-2 pt-5 pb-5
        [border-bottom:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_55%,_transparent)];
}
.source-summary {
    @apply text-muted text-[0.875rem];
}
.source-actions {
    @apply flex flex-wrap items-start gap-[0.25rem_1rem];
}
.source-details {
    @apply min-w-0 max-w-full;
}
.source-details[open] {
    @apply [flex-basis:100%];
}
summary {
    @apply [display:list-item] pt-2.5 pb-2.5 min-h-11 box-border cursor-pointer text-muted;
}
summary:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
.source-details dl {
    @apply mt-3 mb-3;
}
dl {
    @apply flex flex-wrap gap-[1rem_2rem] m-0;
}
dt {
    @apply text-muted;
}
dd {
    @apply m-0;
}
.pagination,
.library-toolbar {
    @apply flex flex-wrap gap-4;
}
a {
    @apply inline-flex items-center justify-self-start gap-2 min-h-11 max-w-full
        cursor-pointer;
}
a:focus-visible,
#library-content:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
</style>
