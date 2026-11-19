<template>
    <section
        lang="zh-CN"
        class="notification-preview w-[min(23rem,_calc(100vw_-_3rem))] max-h-[min(36rem,_calc(100dvh_-_7rem))] overflow-auto text-default text-start"
        aria-label="最近通知"
    >
        <h2 class="text-[1rem] leading-[1.5] m-0">最近通知</h2>
        <state-panel v-if="query.isPending.value" state="loading" message="正在读取通知" />
        <state-panel
            v-else-if="query.isError.value"
            state="error"
            :message="error.message"
            retryable
            @retry="query.refetch()"
        />
        <state-panel v-else-if="!items.length" state="empty" message="暂无通知" />
        <ul class="list-none mt-3 mb-0 mx-0 p-0" v-else>
            <li
                class="[li_+_&:is(li)]:[border-top:0.0625rem_solid_var(--scova-border)]"
                v-for="item in items.slice(0, 4)"
                :key="item.id"
            >
                <router-link
                    class="grid gap-1.5 text-inherit no-underline break-anywhere cursor-pointer rounded-1.5 py-3.5 px-1 keyboard-focus-inset hover:[background:var(--scova-selected)]"
                    :to="notificationTarget(item)"
                    @click="emit('navigate')"
                >
                    <span class="notice-heading flex items-center gap-3">
                        <strong>{{ notificationLabel(item) }}</strong>
                        <span v-if="!item.readAt" class="unread text-primary text-[0.8125rem]"
                            >未读</span
                        >
                    </span>
                    <span>{{ notificationMessage(item) }}</span>
                    <time class="text-muted text-[0.8125rem]" :datetime="item.createdAt">{{
                        localTaskTime(item.createdAt)
                    }}</time>
                </router-link>
            </li>
        </ul>
        <router-link
            class="all-notifications grid gap-1.5 text-inherit no-underline break-anywhere cursor-pointer rounded-1.5 py-3.5 px-1 keyboard-focus-inset hover:[background:var(--scova-selected)] [&&]:(flex items-center justify-between [border-top:0.0625rem_solid_var(--scova-border)] text-primary)"
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
} from '@/composable/useNotifications';
import { localTaskTime } from '@/composable/useTasks';
import StatePanel from '@/component/common/StatePanel.vue';
import AppIcon from '@/component/common/AppIcon.vue';
const emit = defineEmits<{ navigate: [] }>();
const { query, items, error } = useNotifications({ kind: 'all', read: 'all' });
</script>
