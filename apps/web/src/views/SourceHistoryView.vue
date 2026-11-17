<template>
    <section
        ref="root"
        class="source-history layout-grid gap-8 break-anywhere keyboard-focus-wide"
        :style="reading.variables"
        aria-labelledby="page-title"
        tabindex="-1"
    >
        <nav
            class="history-actions scova-interface flex flex-wrap gap-[1rem_2rem]"
            aria-label="来源历史导航"
        >
            <router-link
                class="inline-flex items-center justify-self-start min-h-11 max-w-full scova-link cursor-pointer keyboard-focus-wide"
                to="/library"
                >返回资料库</router-link
            >
            <router-link
                class="inline-flex items-center justify-self-start min-h-11 max-w-full scova-link cursor-pointer keyboard-focus-wide"
                v-if="origin"
                :to="origin.path"
                >返回刚才的报告</router-link
            >
        </nav>
        <p class="m-0">
            每行是一份保存快照及其最近一次成功观测，并非逐次观测流水；观测成功不代表整次研究已交付报告。
        </p>
        <p class="m-0" v-if="!state.valid.value" role="alert">来源或快照地址无效。</p>
        <template v-else>
            <div class="history-actions scova-interface flex flex-wrap gap-[1rem_2rem]">
                <action-button :disabled="state.query.isFetching.value" @click="reload"
                    >重新读取本页</action-button
                >
                <action-button :disabled="state.query.isFetching.value" @click="first"
                    >从第一页重新读取</action-button
                >
            </div>
            <p class="m-0" v-if="state.query.isPending.value" role="status">正在读取来源历史</p>
            <p class="m-0" v-if="state.query.isError.value" role="alert">
                {{ sourceHistoryError(state.query.error.value) }}
            </p>
            <p
                class="m-0"
                v-if="state.pageProblem.value || state.paginationError.value"
                role="alert"
            >
                {{ state.pageProblem.value || state.paginationError.value }}
            </p>
            <p
                class="m-0"
                v-if="
                    state.query.isSuccess.value &&
                    !state.items.value.length &&
                    !state.pageProblem.value
                "
            >
                这一页没有保存快照。
            </p>
            <ul class="snapshot-list list-none m-0 p-0">
                <li
                    v-for="item in state.items.value"
                    :key="item.id"
                    class="snapshot-entry layout-grid gap-6 break-anywhere pt-6 pb-6 [border-bottom:0.0625rem_solid_var(--scova-border)]"
                >
                    <router-link
                        :to="snapshotLink(item.id)"
                        :aria-current="
                            item.id.toLowerCase() === state.snapshotId.value ? 'page' : undefined
                        "
                        class="scova-content-title inline-flex items-center justify-self-start min-h-11 max-w-full scova-link cursor-pointer keyboard-focus-wide [&&]:text-[1.25rem]"
                        @click="selectionFocus = true"
                        >{{ item.title }}</router-link
                    >
                    <dl
                        class="scova-interface snapshot-metadata flex flex-wrap gap-[1rem_2rem] m-0"
                    >
                        <div>
                            <dt class="text-muted">最近成功观测</dt>
                            <dd class="m-0">
                                <time :datetime="item.observedAt">{{ item.observedAt }}</time>
                            </dd>
                        </div>
                        <div>
                            <dt class="text-muted">观测模式</dt>
                            <dd class="m-0">{{ item.mode === 'demo' ? '演示' : '真实' }}</dd>
                        </div>
                        <div>
                            <dt class="text-muted">上次读取正文状态</dt>
                            <dd class="m-0">
                                {{ item.bodyStatus === 'available' ? '可用' : '已过期或清理' }}
                            </dd>
                        </div>
                    </dl>
                    <router-link
                        :to="`/runs/${item.runId}`"
                        class="scova-interface inline-flex items-center justify-self-start min-h-11 max-w-full scova-link cursor-pointer keyboard-focus-wide"
                        >查看该次执行</router-link
                    >
                </li>
            </ul>
            <nav
                class="history-actions scova-interface flex flex-wrap gap-[1rem_2rem]"
                aria-label="来源快照分页"
            >
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
            <section
                v-if="state.snapshotId.value"
                class="selected-snapshot layout-grid gap-6 break-anywhere pt-8 [border-top:0.0625rem_solid_var(--scova-border)]"
                aria-label="所选快照"
            >
                <div class="history-actions scova-interface flex flex-wrap gap-[1rem_2rem]">
                    <action-button
                        :disabled="state.detail.isFetching.value || state.blocked.value"
                        @click="state.detail.refetch()"
                        >重新读取所选快照</action-button
                    >
                </div>
                <p class="m-0" v-if="state.blocked.value" role="alert">
                    来源当前不可读取，请先重新读取来源历史。
                </p>
                <p class="m-0" v-else-if="state.detail.isPending.value" role="status">
                    正在读取保存快照
                </p>
                <p class="m-0" v-else-if="!state.snapshot.value" role="alert">
                    {{ sourceHistoryError(state.detail.error.value) }}
                </p>
                <snapshot-detail v-else :detail="state.snapshot.value" :body="state.body.value" />
            </section>
            <p class="m-0" v-else>选择一份快照查看保留正文与保存片段。</p>
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
