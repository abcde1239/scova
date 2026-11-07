<template>
    <section class="notification-preview" aria-label="最近通知">
        <h2>最近通知</h2>
        <state-panel v-if="query.isPending.value" state="loading" message="正在读取通知" />
        <state-panel
            v-else-if="query.isError.value"
            state="error"
            :message="error.message"
            retryable
            @retry="query.refetch()"
        />
        <state-panel v-else-if="!items.length" state="empty" message="暂无通知" />
        <ul v-else>
            <li v-for="item in items.slice(0, 4)" :key="item.id">
                <router-link :to="notificationTarget(item)" @click="emit('navigate')">
                    <span class="notice-heading">
                        <strong>{{ notificationLabel(item) }}</strong>
                        <span v-if="!item.readAt" class="unread">未读</span>
                    </span>
                    <span>{{ notificationMessage(item) }}</span>
                    <time :datetime="item.createdAt">{{ localTaskTime(item.createdAt) }}</time>
                </router-link>
            </li>
        </ul>
        <router-link
            class="all-notifications"
            :to="{ name: 'notifications' }"
            @click="emit('navigate')"
        >
            查看全部通知 <app-icon name="chevron" />
        </router-link>
    </section>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import {
    useNotifications,
    notificationLabel,
    notificationMessage,
    notificationTarget,
} from '@/composables/useNotifications';
import { localTaskTime } from '@/composables/useTasks';
import StatePanel from '@/components/common/StatePanel.vue';
import AppIcon from '@/components/common/AppIcon.vue';
const emit = defineEmits<{ navigate: [] }>();
const { query, items, error } = useNotifications({ kind: 'all', read: 'all' });
</script>

<style scoped>
.notification-preview {
    inline-size: min(23rem, calc(100vw - 3rem));
    max-block-size: min(36rem, calc(100dvh - 7rem));
    overflow: auto;
    color: var(--scova-text);
    text-align: start;
}
h2 {
    margin: 0;
    font-size: 1rem;
    line-height: 1.5;
}
ul {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
}
li + li {
    border-block-start: 0.0625rem solid var(--scova-border);
}
a {
    display: grid;
    gap: 0.375rem;
    padding: 0.875rem 0.25rem;
    color: inherit;
    text-decoration: none;
    overflow-wrap: anywhere;
    cursor: pointer;
    border-radius: 0.375rem;
}
a:hover {
    background: var(--scova-selected);
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: -0.125rem;
}
.notice-heading {
    display: flex;
    align-items: center;
    gap: 0.75rem;
}
time {
    color: var(--scova-muted);
    font-size: 0.8125rem;
}
.unread {
    color: var(--scova-primary);
    font-size: 0.8125rem;
}
.all-notifications {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-block-start: 0.0625rem solid var(--scova-border);
    color: var(--scova-primary);
}
</style>
