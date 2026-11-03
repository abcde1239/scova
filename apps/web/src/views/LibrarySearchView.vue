<template>
    <section class="library-search" :style="reading.variables" aria-labelledby="page-title">
        <nav class="search-actions scova-interface" aria-label="资料库分区">
            <navigation-button to="/library">收藏</navigation-button>
            <span aria-current="page">搜索已存资料</span>
        </nav>
        <p>只检索当前账号已保存的来源快照与纯文本笔记，不进行联网搜索。</p>
        <form class="search-form scova-interface" @submit.prevent="state.submit">
            <label for="library-search-q">搜索已保存资料</label>
            <input
                id="library-search-q"
                v-model="state.draft.value"
                type="search"
                autocomplete="off"
                :aria-invalid="!!state.inputIssue.value && !!state.draft.value"
                aria-describedby="library-search-scope library-search-input-error"
                @compositionstart="state.beginComposition"
                @compositionend="endComposition"
            />
            <div class="search-filters">
                <label
                    >资料类型<select v-model="state.kind.value">
                        <option value="all">全部</option>
                        <option value="source">来源快照</option>
                        <option value="note">纯文本笔记</option>
                    </select></label
                >
                <label
                    >来源收藏状态<select v-model="state.bookmarked.value">
                        <option value="all">全部</option>
                        <option value="true">已收藏来源</option>
                        <option value="false">未收藏来源或报告笔记</option>
                    </select></label
                >
            </div>
            <p id="library-search-scope">
                按最近成功观测或笔记更新时间排列；过期正文不参与检索，标题与笔记仍可能命中。摘录反映本次检索时的内容，当前正文状态以来源详情为准。
            </p>
            <p
                id="library-search-input-error"
                :role="
                    state.inputIssue.value && (state.draft.value || state.attempted.value)
                        ? 'alert'
                        : undefined
                "
            >
                {{ state.draft.value || state.attempted.value ? state.inputIssue.value : '' }}
            </p>
            <div class="search-actions">
                <action-button attr-type="submit" :disabled="state.composing.value"
                    >搜索已存资料</action-button
                >
                <action-button @click="state.cancel">取消检索</action-button>
                <action-button @click="clear">清空输入</action-button>
            </div>
        </form>
        <section
            ref="results"
            class="results-region"
            tabindex="-1"
            aria-labelledby="search-results-title"
            :aria-busy="state.query.isFetching.value"
        >
            <h2 id="search-results-title" class="scova-interface">检索结果</h2>
            <p v-if="state.notice.value" role="status">{{ state.notice.value }}</p>
            <p v-if="state.committed.value && state.query.isFetching.value" role="status">
                正在检索已存资料。
            </p>
            <p v-if="state.committed.value && state.query.isError.value" role="alert">
                {{ librarySearchError(state.query.error.value) }}
            </p>
            <p v-if="state.pageProblem.value" role="alert">{{ state.pageProblem.value }}</p>
            <p v-if="state.ready.value" role="status">
                {{
                    state.items.value.length
                        ? '已完成本页检索。'
                        : '当前关键词和筛选条件下，没有已存资料命中。'
                }}
            </p>
            <library-search-results :items="state.items.value" />
            <div v-if="state.committed.value" class="search-actions scova-interface">
                <action-button :disabled="state.query.isFetching.value" @click="turn('first')"
                    >从第一页重新读取</action-button
                >
                <action-button
                    v-if="state.previous.value.length"
                    :disabled="state.query.isFetching.value"
                    @click="turn('back')"
                    >上一页</action-button
                >
                <action-button v-if="state.canNext.value" @click="turn('next')"
                    >下一页</action-button
                >
            </div>
        </section>
    </section>
</template>

<script setup lang="ts">
import NavigationButton from '@/components/common/NavigationButton.vue';
import { nextTick, ref, watch } from 'vue';
import ActionButton from '@/components/common/ActionButton.vue';
import LibrarySearchResults from '@/components/library/LibrarySearchResults.vue';
import { librarySearchError, useLibrarySearch } from '@/composables/useLibrarySearch';
import { useReadingTypography } from '@/composables/useReadingTypography';
const state = useLibrarySearch();
const { reading } = useReadingTypography();
const results = ref<HTMLElement>();
let pageFocus = false;
function endComposition(event: CompositionEvent) {
    state.endComposition((event.target as HTMLInputElement).value);
}
async function clear() {
    state.clear();
    await nextTick();
    document.getElementById('library-search-q')?.focus();
}
async function restoreFocus() {
    await nextTick();
    if (results.value?.isConnected && document.activeElement === document.body)
        results.value.focus();
}
async function turn(direction: 'first' | 'next' | 'back') {
    pageFocus = !!results.value?.contains(document.activeElement);
    if (direction === 'first') await state.first();
    else if (direction === 'next') state.next();
    else state.back();
    await nextTick();
    if (pageFocus) await restoreFocus();
}
watch(
    () => state.query.isFetching.value,
    async (fetching) => {
        if (!fetching && pageFocus) {
            pageFocus = false;
            await restoreFocus();
        }
    },
);
</script>

<style scoped>
.library-search,
.search-form,
.results-region {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.library-search {
    gap: 2rem;
}
.search-form {
    max-inline-size: 46.25rem;
}
.search-filters,
.search-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
    min-inline-size: 0;
}
.search-filters label {
    display: grid;
    gap: 0.5rem;
    max-inline-size: 100%;
    min-inline-size: 0;
}
input,
select {
    font: inherit;
    color: var(--scova-text);
    background: var(--scova-surface);
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.5rem;
    min-block-size: 2.75rem;
    padding: 0.625rem 0.75rem;
    max-inline-size: 100%;
    min-inline-size: 0;
}
input {
    inline-size: 100%;
    cursor: text;
}
select {
    cursor: pointer;
}
h2,
p {
    margin: 0;
}
h2 {
    font-size: 1.25rem;
}
#library-search-input-error:empty {
    display: none;
}
a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
input:focus-visible,
select:focus-visible,
a:focus-visible,
.results-region:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
