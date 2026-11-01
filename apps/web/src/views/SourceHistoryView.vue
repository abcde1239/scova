<template>
    <section
        ref="root"
        class="source-history"
        :style="reading.variables"
        aria-labelledby="page-title"
        tabindex="-1"
    >
        <nav class="history-actions scova-interface" aria-label="来源历史导航">
            <router-link to="/library">返回资料库</router-link>
            <router-link v-if="origin" :to="origin.path">返回刚才的报告</router-link>
        </nav>
        <p>
            每行是一份保存快照及其最近一次成功观测，并非逐次观测流水；观测成功不代表整次研究已交付报告。
        </p>
        <p v-if="!state.valid.value" role="alert">来源或快照地址无效。</p>
        <template v-else>
            <div class="history-actions scova-interface">
                <action-button :disabled="state.query.isFetching.value" @click="reload"
                    >重新读取本页</action-button
                >
                <action-button :disabled="state.query.isFetching.value" @click="first"
                    >从第一页重新读取</action-button
                >
            </div>
            <p v-if="state.query.isPending.value" role="status">正在读取来源历史</p>
            <p v-if="state.query.isError.value" role="alert">
                {{ sourceHistoryError(state.query.error.value) }}
            </p>
            <p v-if="state.pageProblem.value || state.paginationError.value" role="alert">
                {{ state.pageProblem.value || state.paginationError.value }}
            </p>
            <p
                v-if="
                    state.query.isSuccess.value &&
                    !state.items.value.length &&
                    !state.pageProblem.value
                "
            >
                这一页没有保存快照。
            </p>
            <ul class="snapshot-list">
                <li v-for="item in state.items.value" :key="item.id" class="snapshot-entry">
                    <router-link
                        :to="snapshotLink(item.id)"
                        :aria-current="
                            item.id.toLowerCase() === state.snapshotId.value ? 'page' : undefined
                        "
                        class="scova-content-title"
                        @click="selectionFocus = true"
                        >{{ item.title }}</router-link
                    >
                    <dl class="scova-interface snapshot-metadata">
                        <div>
                            <dt>最近成功观测</dt>
                            <dd>
                                <time :datetime="item.observedAt">{{ item.observedAt }}</time>
                            </dd>
                        </div>
                        <div>
                            <dt>观测模式</dt>
                            <dd>{{ item.mode === 'demo' ? '演示' : '真实' }}</dd>
                        </div>
                        <div>
                            <dt>上次读取正文状态</dt>
                            <dd>{{ item.bodyStatus === 'available' ? '可用' : '已过期或清理' }}</dd>
                        </div>
                    </dl>
                    <router-link :to="`/runs/${item.runId}`" class="scova-interface"
                        >查看该次执行</router-link
                    >
                </li>
            </ul>
            <nav class="history-actions scova-interface" aria-label="来源快照分页">
                <action-button
                    v-if="state.previous.value.length"
                    :disabled="state.query.isFetching.value"
                    @click="turn(false)"
                    >上一页</action-button
                >
                <action-button
                    v-if="state.query.data.value?.data.nextCursor"
                    :disabled="
                        state.query.isFetching.value ||
                        state.query.isError.value ||
                        !!state.pageProblem.value ||
                        !!state.paginationError.value
                    "
                    @click="turn(true)"
                    >下一页</action-button
                >
            </nav>
            <section v-if="state.snapshotId.value" class="selected-snapshot" aria-label="所选快照">
                <div class="history-actions scova-interface">
                    <action-button
                        :disabled="state.detail.isFetching.value || state.blocked.value"
                        @click="state.detail.refetch()"
                        >重新读取所选快照</action-button
                    >
                </div>
                <p v-if="state.blocked.value" role="alert">
                    来源当前不可读取，请先重新读取来源历史。
                </p>
                <p v-else-if="state.detail.isPending.value" role="status">正在读取保存快照</p>
                <p v-else-if="!state.snapshot.value" role="alert">
                    {{ sourceHistoryError(state.detail.error.value) }}
                </p>
                <snapshot-detail v-else :detail="state.snapshot.value" :body="state.body.value" />
            </section>
            <p v-else>选择一份快照查看保留正文与保存片段。</p>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import ActionButton from '@/components/common/ActionButton.vue';
import SnapshotDetail from '@/components/library/SnapshotDetail.vue';
import { useSourceHistory, sourceHistoryError } from '@/composables/useSourceHistory';
import { bookmarkOrigin, readBookmarkOrigin } from '@/composables/useBookmarks';
import { useReadingTypography } from '@/composables/useReadingTypography';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
const route = useRoute();
const lifecycle = useSessionLifecycle();
const { reading } = useReadingTypography();
const state = useSourceHistory(
    () => route.params.sourceId,
    () => route.params.snapshotId,
    lifecycle,
);
const root = ref<HTMLElement>();
const selectionFocus = ref(false);
const origin = computed(() => {
    void route.fullPath;
    const value = readBookmarkOrigin(lifecycle, window.history.state?.bookmarkOrigin);
    return value?.sourceId === state.sourceId.value ? value : undefined;
});
function snapshotLink(id: string) {
    return {
        path: `/library/sources/${state.sourceId.value}/snapshots/${id}`,
        ...(origin.value
            ? {
                  state: {
                      bookmarkOrigin: bookmarkOrigin(
                          lifecycle,
                          origin.value.path.slice('/reports/'.length),
                          state.sourceId.value!,
                      ),
                  },
              }
            : {}),
    };
}
async function focusRoot() {
    await nextTick();
    root.value?.focus();
}
async function reload() {
    await state.query.refetch({ cancelRefetch: false });
    await focusRoot();
}
async function first() {
    await state.first();
    await focusRoot();
}
async function turn(forward: boolean) {
    if (forward) state.next();
    else state.back();
    await focusRoot();
}
watch(
    () => [state.detail.isFetching.value, state.snapshot.value],
    async () => {
        if (selectionFocus.value && !state.detail.isFetching.value) {
            await nextTick();
            root.value?.querySelector<HTMLElement>('#snapshot-title')?.focus();
            selectionFocus.value = false;
        }
    },
);
</script>

<style scoped>
.source-history,
.snapshot-entry,
.selected-snapshot {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.source-history {
    gap: 2rem;
}
.snapshot-list {
    list-style: none;
    padding: 0;
    margin: 0;
}
.snapshot-entry {
    padding-block: 1.5rem;
    border-block-end: 0.0625rem solid var(--scova-border);
}
.history-actions,
.snapshot-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 2rem;
}
p,
dl {
    margin: 0;
}
dt {
    color: var(--scova-muted);
}
dd {
    margin: 0;
}
a {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
a.scova-content-title {
    font-size: 1.25rem;
}
a:focus-visible,
.source-history:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.selected-snapshot {
    padding-block-start: 2rem;
    border-block-start: 0.0625rem solid var(--scova-border);
}
</style>
