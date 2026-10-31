<template>
    <div ref="root" class="bookmark-action scova-interface">
        <div class="bookmark-buttons">
            <action-button :disabled="!canWrite" :busy="pending" @click="act">
                <app-icon :name="bookmark ? 'close' : 'bookmark'" />{{
                    bookmark ? '取消收藏' : '收藏来源'
                }}
            </action-button>
            <action-button :disabled="pending || query.isFetching.value" @click="verify">
                <app-icon name="retry" />核对收藏状态
            </action-button>
            <router-link v-if="reportId" :to="libraryLink"
                ><app-icon name="library" />查看收藏</router-link
            >
        </div>
        <p v-if="pending" role="status">正在处理收藏，请稍候。</p>
        <p v-if="query.isFetching.value" role="status">
            正在核对收藏列表，找到目标或读至末页后确认状态。
        </p>
        <p v-if="notice" role="status">{{ notice }}</p>
        <p v-if="query.isError.value" role="alert">{{ bookmarkReadError(query.error.value) }}</p>
        <p v-if="uncertain" class="scova-warning">结果尚待核对，请成功核对收藏状态后再操作。</p>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { Bookmark } from '@/api/library';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { bookmarkOrigin, bookmarkReadError, useBookmark } from '@/composables/useBookmarks';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
const props = defineProps<{ sourceId: string; bookmark?: Bookmark; reportId?: string }>();
const emit = defineEmits<{ started: []; settled: [] }>();
const root = ref<HTMLElement>();
const lifecycle = useSessionLifecycle();
const { query, bookmark, pending, uncertain, notice, canWrite, verify, write } = useBookmark(
    () => props.sourceId,
    () => props.bookmark,
    lifecycle,
);
const libraryLink = computed(() => ({
    path: '/library',
    ...(props.reportId
        ? { state: { bookmarkOrigin: bookmarkOrigin(lifecycle, props.reportId, props.sourceId) } }
        : {}),
}));
async function act() {
    const hadFocus = root.value?.contains(document.activeElement);
    if (hadFocus) emit('started');
    await write(!!bookmark.value);
    if (hadFocus) {
        await nextTick();
        emit('settled');
    }
}
</script>

<style scoped>
.bookmark-action {
    display: grid;
    gap: 0.75rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.bookmark-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
}
a {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
