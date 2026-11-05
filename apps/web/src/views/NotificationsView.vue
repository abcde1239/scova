<template>
    <section ref="container" class="notifications-view" aria-label="站内通知">
        <div class="notification-tools">
            <label
                >通知类别
                <select :value="filters.kind" @change="change('kind', $event)">
                    <option v-for="kind in notificationKinds" :key="kind.value" :value="kind.value">
                        {{ kind.label }}
                    </option>
                </select>
            </label>
            <label
                >通知已读状态
                <select :value="filters.read" @change="change('read', $event)">
                    <option value="all">全部状态</option>
                    <option value="unread">未读</option>
                    <option value="read">已读</option>
                </select>
            </label>
            <action-button
                :busy="query.isRefetching.value && !query.isFetchingNextPage.value"
                :disabled="!!pendingId || query.isFetchingNextPage.value"
                @click="refresh"
                ><app-icon name="retry" />刷新</action-button
            >
        </div>
        <p v-if="actionError" role="alert">{{ actionError }}</p>
        <p v-if="announcement" role="status" aria-live="polite">{{ announcement }}</p>
        <state-panel v-if="query.isPending.value" state="loading" message="正在读取通知" />
        <state-panel
            v-else-if="query.isError.value"
            state="error"
            :message="`${items.length ? '已保留上次读取的通知。' : ''}${error.message}`"
            retryable
            @retry="retry"
        />
        <state-panel v-else-if="!items.length" state="empty" message="暂无通知" />
        <div v-if="items.length" class="notification-list">
            <notification-entry
                v-for="item in items"
                :key="item.id"
                :item="item"
                :pending="pendingId === item.id"
                :disabled="!!pendingId && pendingId !== item.id"
                @read="updateRead(item, $event)"
            />
        </div>
        <div
            v-if="items.length && query.hasNextPage.value && !error.hidden"
            class="notification-pagination"
        >
            <action-button
                :busy="query.isFetchingNextPage.value"
                :disabled="
                    !!pendingId || (query.isRefetching.value && !query.isFetchingNextPage.value)
                "
                @click="more"
                >{{ query.isFetchNextPageError.value ? '重试加载更多' : '加载更多' }}</action-button
            >
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Notification } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import NotificationEntry from '@/components/notifications/NotificationEntry.vue';
import {
    notificationKinds,
    readNotificationFilters,
    useNotifications,
} from '@/composables/useNotifications';
const route = useRoute();
const router = useRouter();
const filters = computed(() => readNotificationFilters(route.query.kind, route.query.read));
const { query, items, error, pendingId, actionError, announcement, setRead } =
    useNotifications(filters);
const container = ref<HTMLElement>();
let filterRevision = 0;
async function change(key: 'kind' | 'read', event: Event) {
    const target = event.target as HTMLSelectElement;
    const value = target.value;
    const revision = ++filterRevision;
    const next = readNotificationFilters(
        key === 'kind' ? value : filters.value.kind,
        key === 'read' ? value : filters.value.read,
    );
    await router.replace({
        path: '/notifications',
        query: {
            ...(next.kind === 'all' ? {} : { kind: next.kind }),
            ...(next.read === 'all' ? {} : { read: next.read }),
        },
    });
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (
        revision === filterRevision &&
        route.path === '/notifications' &&
        target.isConnected &&
        document.activeElement === document.getElementById('main-content')
    )
        target.focus({ preventScroll: true });
}
function focusTarget(id?: string) {
    if (id) document.getElementById(`notification-target-${id}`)?.focus({ preventScroll: true });
    else container.value?.querySelector('select')?.focus({ preventScroll: true });
}
async function refresh() {
    const focused = container.value?.contains(document.activeElement);
    await query.refetch();
    await nextTick();
    if (focused && document.activeElement === document.body) focusTarget(items.value[0]?.id);
}
async function more() {
    const focused = container.value?.contains(document.activeElement);
    const before = new Set(items.value.map((item) => item.id));
    await query.fetchNextPage();
    await nextTick();
    if (focused && document.activeElement === document.body)
        focusTarget(items.value.find((item) => !before.has(item.id))?.id ?? items.value.at(-1)?.id);
}
async function retry() {
    if (query.isFetchNextPageError.value && !error.value.restart) await more();
    else await refresh();
}
async function updateRead(item: Notification, read: boolean) {
    const index = items.value.findIndex((entry) => entry.id === item.id);
    const focused = container.value?.contains(document.activeElement);
    if (await setRead(item, read)) {
        await nextTick();
        if (focused && !items.value.some((entry) => entry.id === item.id))
            focusTarget(items.value[index]?.id ?? items.value.at(-1)?.id);
    }
}
</script>

<style scoped>
.notifications-view {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
}
.notification-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 2rem;
    align-items: end;
}
label {
    display: grid;
    gap: 0.5rem;
    max-inline-size: 100%;
}
select {
    appearance: auto;
    font: inherit;
    line-height: 1.5;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    min-inline-size: 0;
    padding: 0.5rem 1rem;
    color: var(--scova-text);
    background: var(--scova-surface);
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.5rem;
    cursor: pointer;
}
select:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
p {
    margin: 0;
    overflow-wrap: anywhere;
}
.notification-list {
    min-inline-size: 0;
}
.notification-pagination {
    padding-block: 1rem;
}
</style>
