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
            </nav>
        </header>
        <div v-show="section === 'bookmarks'" class="bookmark-content">
            <p>保存报告中已有的来源；取消收藏不会删除来源、报告或引用证据。</p>
            <div class="library-toolbar scova-interface">
                <action-button :disabled="pending || query.isFetching.value" @click="reload"
                    ><app-icon name="retry" />重新读取本页</action-button
                >
                <action-button :disabled="pending || query.isFetching.value" @click="first"
                    ><app-icon name="retry" />从第一页重新读取</action-button
                >
            </div>
            <p v-if="query.isPending.value" role="status">正在读取收藏。</p>
            <p v-if="notice" role="status">{{ notice }}</p>
            <p v-if="query.isError.value" role="alert">
                {{ bookmarkReadError(query.error.value) }}
            </p>
            <p v-if="query.isError.value && items.length">
                以下保留上次读取值，请重新读取以确认当前状态。
            </p>
            <p v-if="query.isSuccess.value && !items.length">
                这一页没有收藏。可以从报告选择来源收藏。
            </p>
            <p v-if="paginationError" role="alert">{{ paginationError }}</p>
            <ul class="bookmark-list">
                <li v-for="item in items" :key="item.id" class="bookmark-entry">
                    <h2 class="scova-content-title">
                        {{ item.source.title ?? item.source.canonicalUrl }}
                    </h2>
                    <p v-if="item.source.title" class="scova-interface">
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
                    <a
                        v-if="sourceLink(item.source.canonicalUrl)"
                        :href="sourceLink(item.source.canonicalUrl)"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="scova-interface"
                        ><app-icon name="source" />打开原始来源（新窗口）</a
                    >
                    <router-link :to="historyLink(item.sourceId)" class="scova-interface"
                        >查看来源历史</router-link
                    >
                    <router-link
                        v-if="origin?.sourceId === item.sourceId.toLowerCase()"
                        :to="origin.path"
                        class="scova-interface"
                        >返回刚才的报告</router-link
                    >
                    <bookmark-action
                        :key="`${accountId}-${item.id}`"
                        :source-id="item.sourceId"
                        :bookmark="item"
                        @started="bookmarkFocus = true"
                        @settled="bookmarkSettled"
                    />
                    <action-button
                        @click="
                            showNotes({
                                kind: 'source',
                                id: item.sourceId,
                                label: item.source.title ?? item.source.canonicalUrl,
                            })
                        "
                        >为此来源记笔记</action-button
                    >
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
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
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
const notes = ref<InstanceType<typeof NotesPanel>>();
const noteTarget = ref<NoteTarget>();
const {
    query,
    items,
    previous,
    paginationError,
    pending,
    notice,
    canPage,
    next,
    back,
    first,
    reload,
} = useBookmarks(lifecycle);
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
.library-view,
.bookmark-content,
header,
.bookmark-entry {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.library-view {
    gap: 2rem;
}
h2,
p {
    margin: 0;
}
h2 {
    font-size: 1.25rem;
    font-weight: 600;
}
header nav {
    display: flex;
    border-block-end: 0.0625rem solid var(--scova-border);
}
header nav button {
    min-block-size: 2.75rem;
    padding: 0.75rem 1rem;
    font: inherit;
    background: transparent;
    color: var(--scova-text);
    border: 0;
    cursor: pointer;
}
header nav button[aria-current='page'] {
    border-block-end: 0.1875rem solid var(--scova-primary);
}
header nav button:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.bookmark-list {
    list-style: none;
    padding: 0;
    margin: 0;
    min-inline-size: 0;
}
.bookmark-entry {
    padding-block: 1.5rem;
    border-block-end: 0.0625rem solid var(--scova-border);
}
dl {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 2rem;
    margin: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0;
}
.pagination,
.library-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
}
a {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
a:focus-visible,
#library-content:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
