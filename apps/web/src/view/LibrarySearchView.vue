<template>
    <section
        class="library-search layout-grid gap-8 break-anywhere"
        :style="reading.variables"
        aria-labelledby="page-title"
    >
        <nav
            class="search-actions scova-interface flex flex-wrap items-center gap-4 min-w-0"
            aria-label="资料库分区"
        >
            <navigation-button to="/library">收藏</navigation-button>
            <span aria-current="page">搜索已存资料</span>
        </nav>
        <p class="m-0">只检索当前账号已保存的来源快照与纯文本笔记，不进行联网搜索。</p>
        <form
            class="search-form scova-interface report-grid max-w-[46.25rem]"
            @submit.prevent="state.submit"
        >
            <label for="library-search-q">搜索已保存资料</label>
            <input
                class="font-inherit text-default bg-surface border-theme rounded-2 min-h-11 max-w-full min-w-0 w-full [cursor:text] py-2.5 px-3 keyboard-focus-wide"
                id="library-search-q"
                v-model="state.draft.value"
                type="search"
                autocomplete="off"
                :aria-invalid="!!state.inputIssue.value && !!state.draft.value"
                aria-describedby="library-search-scope library-search-input-error"
                @compositionstart="state.beginComposition"
                @compositionend="endComposition"
            />
            <div class="search-filters flex flex-wrap items-center gap-4 min-w-0">
                <label class="[.search-filters_&:is(label)]:(grid gap-2 max-w-full min-w-0)"
                    >资料类型<select
                        class="font-inherit text-default bg-surface border-theme rounded-2 min-h-11 max-w-full min-w-0 cursor-pointer py-2.5 px-3 keyboard-focus-wide"
                        v-model="state.kind.value"
                    >
                        <option value="all">全部</option>
                        <option value="source">来源快照</option>
                        <option value="note">纯文本笔记</option>
                    </select></label
                >
                <label class="[.search-filters_&:is(label)]:(grid gap-2 max-w-full min-w-0)"
                    >来源收藏状态<select
                        class="font-inherit text-default bg-surface border-theme rounded-2 min-h-11 max-w-full min-w-0 cursor-pointer py-2.5 px-3 keyboard-focus-wide"
                        v-model="state.bookmarked.value"
                    >
                        <option value="all">全部</option>
                        <option value="true">已收藏来源</option>
                        <option value="false">未收藏来源或报告笔记</option>
                    </select></label
                >
            </div>
            <p class="m-0" id="library-search-scope">
                按最近成功观测或笔记更新时间排列；过期正文不参与检索，标题与笔记仍可能命中。摘录反映本次检索时的内容，当前正文状态以来源详情为准。
            </p>
            <p
                class="m-0 [&:empty]:hidden"
                id="library-search-input-error"
                :role="
                    state.inputIssue.value && (state.draft.value || state.attempted.value)
                        ? 'alert'
                        : undefined
                "
            >
                {{ state.draft.value || state.attempted.value ? state.inputIssue.value : '' }}
            </p>
            <div class="search-actions flex flex-wrap items-center gap-4 min-w-0">
                <action-button attr-type="submit" :disabled="state.composing.value"
                    >搜索已存资料</action-button
                >
                <action-button @click="state.cancel">取消检索</action-button>
                <action-button @click="clear">清空输入</action-button>
            </div>
        </form>
        <section
            ref="results"
            class="results-region report-grid keyboard-focus-wide"
            tabindex="-1"
            aria-labelledby="search-results-title"
            :aria-busy="state.query.isFetching.value"
        >
            <h2 id="search-results-title" class="scova-interface text-[1.25rem] m-0">检索结果</h2>
            <p
                class="m-0"
                v-if="state.committed.value && state.query.isFetching.value"
                role="status"
            >
                正在检索已存资料。
            </p>
            <p class="m-0" v-if="state.committed.value && state.query.isError.value" role="alert">
                {{ librarySearchError(state.query.error.value) }}
            </p>
            <p class="m-0" v-if="state.pageProblem.value" role="alert">
                {{ state.pageProblem.value }}
            </p>
            <p class="m-0" v-if="state.ready.value" role="status">
                {{
                    state.items.value.length
                        ? '已完成本页检索。'
                        : '当前关键词和筛选条件下，没有已存资料命中。'
                }}
            </p>
            <library-search-results :items="state.items.value" />
            <div
                v-if="state.committed.value"
                class="search-actions scova-interface flex flex-wrap items-center gap-4 min-w-0"
            >
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
import NavigationButton from '@/component/common/NavigationButton.vue';
import { nextTick, ref, watch } from 'vue';
import ActionButton from '@/component/common/ActionButton.vue';
import LibrarySearchResults from '@/component/library/LibrarySearchResults.vue';
import { librarySearchError, useLibrarySearch } from '@/composable/useLibrarySearch';
import { useReadingTypography } from '@/composable/useReadingTypography';
import { useActionNotification } from '@/composable/useActionNotification';
const state = useLibrarySearch();
useActionNotification().watch(state.notice);
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
