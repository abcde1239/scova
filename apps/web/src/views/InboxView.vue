<template>
    <section ref="container" class="inbox-view" aria-label="报告收件箱">
        <div class="inbox-tools">
            <nav aria-label="收件箱筛选">
                <router-link
                    v-for="option in filters"
                    :key="option.value"
                    :to="inboxPath(option.value)"
                    :aria-current="filter === option.value ? 'page' : undefined"
                >
                    {{ option.label }}
                </router-link>
            </nav>
            <action-button
                :busy="query.isRefetching.value && !query.isFetchingNextPage.value"
                :disabled="!!pendingId || query.isFetchingNextPage.value"
                @click="refresh"
            >
                <app-icon name="retry" />刷新
            </action-button>
        </div>
        <p v-if="actionError" role="alert">{{ actionError }}</p>
        <p v-if="announcement" role="status" aria-live="polite">{{ announcement }}</p>
        <state-panel v-if="query.isPending.value" state="loading" message="正在读取收件箱" />
        <state-panel
            v-else-if="query.isError.value"
            state="error"
            :message="`${items.length ? '已保留上次读取的内容。' : ''}${error.message}`"
            retryable
            @retry="retry"
        />
        <state-panel
            v-else-if="!items.length"
            state="empty"
            :message="
                filter === 'unread'
                    ? '暂无未读报告'
                    : filter === 'read'
                      ? '暂无已读报告'
                      : '暂无报告'
            "
        />
        <div v-if="items.length" class="inbox-list">
            <inbox-entry
                v-for="item in items"
                :key="item.id"
                :item="item"
                :pending="pendingId === item.id"
                :disabled="!!pendingId && pendingId !== item.id"
                @read="setItemRead(item, $event)"
                @open="openReport(item, $event)"
            />
        </div>
        <div
            v-if="items.length && query.hasNextPage.value && !error.hidden"
            class="inbox-pagination"
        >
            <action-button
                :busy="query.isFetchingNextPage.value"
                :disabled="
                    !!pendingId || (query.isRefetching.value && !query.isFetchingNextPage.value)
                "
                @click="more"
            >
                {{ query.isFetchNextPageError.value ? '重试加载更多' : '加载更多' }}
            </action-button>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type { InboxItem } from '@/api/inbox';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import InboxEntry from '@/components/inbox/InboxEntry.vue';
import {
    inboxFilter,
    inboxPath,
    inboxReturn,
    useInbox,
    type InboxFilter,
} from '@/composables/useInbox';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
const route = useRoute();
const router = useRouter();
const lifecycle = useSessionLifecycle();
const filter = computed(() => inboxFilter(route.query.read));
const filters: { value: InboxFilter; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'unread', label: '未读' },
    { value: 'read', label: '已读' },
];
const { query, items, error, pendingId, actionError, announcement, setRead } = useInbox(
    filter,
    lifecycle,
);
const container = ref<HTMLElement>();
function focusEntry(id?: string) {
    const target = id ? document.getElementById(`inbox-report-${id}`) : undefined;
    if (target) target.focus({ preventScroll: true });
    else
        container.value
            ?.querySelector<HTMLElement>('nav a[aria-current="page"]')
            ?.focus({ preventScroll: true });
}
async function refresh() {
    const focused = container.value?.contains(document.activeElement);
    await query.refetch();
    await nextTick();
    if (focused && document.activeElement === document.body) focusEntry(items.value[0]?.id);
}
async function retry() {
    if (query.isFetchNextPageError.value) await more();
    else await refresh();
}
async function more() {
    const hadFocus = container.value?.contains(document.activeElement);
    const oldIds = new Set(items.value.map((item) => item.id));
    await query.fetchNextPage();
    await nextTick();
    if (hadFocus && document.activeElement === document.body)
        focusEntry(items.value.find((item) => !oldIds.has(item.id))?.id ?? items.value.at(-1)?.id);
}
async function setItemRead(item: InboxItem, read: boolean) {
    const index = items.value.findIndex((entry) => entry.id === item.id);
    const hadFocus = container.value?.contains(document.activeElement);
    if (await setRead(item, read)) {
        await nextTick();
        if (hadFocus && !items.value.some((entry) => entry.id === item.id))
            focusEntry(items.value[index]?.id ?? items.value.at(-1)?.id);
    }
}
function openReport(item: InboxItem, event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
    event.preventDefault();
    const position = {
        path: inboxPath(filter.value),
        scroll: window.scrollY,
        focusId: item.id,
        accountId: lifecycle.session.user?.id ?? '',
    };
    window.history.replaceState({ ...window.history.state, inboxRestore: position }, '');
    void router.push({
        name: 'report-detail',
        params: { reportId: item.reportId },
        state: {
            inboxReturn: position,
        },
    });
}
onMounted(async () => {
    const restore = inboxReturn(window.history.state?.inboxRestore, lifecycle.session.user?.id);
    if (!restore || restore.path !== inboxPath(filter.value)) return;
    await nextTick();
    // Apply after the workbench's route focus, for explicit return and browser Back alike.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (
        restore.accountId !== lifecycle.session.user?.id ||
        route.path !== '/inbox' ||
        restore.path !== inboxPath(filter.value)
    )
        return;
    focusEntry(restore.focusId);
    window.scrollTo({ top: restore.scroll });
});
</script>

<style scoped>
.inbox-view {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
}
.inbox-tools {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 1rem 2rem;
    align-items: center;
}
nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}
nav a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    padding: 0.5rem 1rem;
    color: var(--scova-muted);
    text-decoration: none;
    cursor: pointer;
    border-radius: 0.5rem;
}
nav a[aria-current='page'] {
    color: var(--scova-primary);
    background: var(--scova-surface);
    font-weight: 600;
}
nav a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
p {
    margin: 0;
    overflow-wrap: anywhere;
}
.inbox-list {
    min-inline-size: 0;
}
.inbox-pagination {
    padding-block: 1rem;
}
</style>
