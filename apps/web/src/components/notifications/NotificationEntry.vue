<template>
    <article class="notification-entry" :aria-labelledby="`notification-title-${item.id}`">
        <div class="notification-content">
            <h2 :id="`notification-title-${item.id}`">{{ notificationLabel(item) }}</h2>
            <p class="metadata">
                <strong>{{ item.readAt ? '已读' : '未读' }}</strong>
                <span>{{ item.mode === 'demo' ? '演示执行' : '真实查阅' }}</span>
                <span>{{ notificationStatus[item.runStatus] }}</span>
                <time :datetime="item.createdAt">{{ localTaskTime(item.createdAt) }}</time>
            </p>
            <p>{{ notificationMessage(item) }}</p>
            <router-link :id="`notification-target-${item.id}`" :to="notificationTarget(item)">
                <app-icon :name="item.reportId ? 'report' : 'run'" />{{
                    item.reportId ? '阅读报告' : '查看执行'
                }}
            </router-link>
        </div>
        <action-button :busy="pending" :disabled="disabled" @click="emit('read', !item.readAt)">
            <app-icon :name="item.readAt ? 'notifications' : 'confirm'" />
            {{ pending ? '正在更新' : item.readAt ? '恢复未读' : '标记已读' }}
        </action-button>
    </article>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { Notification } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import {
    notificationLabel,
    notificationMessage,
    notificationStatus,
    notificationTarget,
} from '@/composables/useNotifications';
import { localTaskTime } from '@/composables/useTasks';
defineProps<{ item: Notification; pending?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ read: [read: boolean] }>();
</script>

<style scoped>
.notification-entry {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem 2rem;
    align-items: start;
    padding-block: 2rem;
    border-block-end: 0.0625rem solid var(--scova-border);
    min-inline-size: 0;
}
.notification-content {
    display: grid;
    gap: 1rem;
    flex: 1 1 30rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
h2,
p {
    margin: 0;
}
h2 {
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.6;
}
.metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
    color: var(--scova-muted);
}
strong {
    color: var(--scova-text);
    font-weight: 500;
}
a {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    justify-self: start;
    min-block-size: 2.75rem;
    max-inline-size: 100%;
    color: var(--scova-primary);
    text-underline-offset: 0.2em;
    cursor: pointer;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
