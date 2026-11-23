<template>
    <article
        class="notification-entry flex flex-wrap gap-[1.5rem_2rem] items-start pt-8 pb-8 [border-bottom:0.0625rem_solid_var(--scova-border)] min-w-0"
        :aria-labelledby="`notification-title-${item.id}`"
    >
        <div class="notification-content layout-stack [flex:1_1_30rem] break-anywhere">
            <h2
                class="text-[1.25rem] font-semibold leading-[1.6] m-0"
                :id="`notification-title-${item.id}`"
            >
                {{ notificationLabel(item) }}
            </h2>
            <p class="metadata flex flex-wrap gap-[0.5rem_1.25rem] text-muted m-0">
                <strong class="text-default font-medium">{{
                    item.readAt ? '已读' : '未读'
                }}</strong>
                <span v-if="item.kind === 'workflow'">工作流通知</span>
                <template v-else>
                    <span>{{ item.mode === 'demo' ? '演示执行' : '任务执行' }}</span>
                    <span>{{ notificationStatus[item.runStatus] }}</span>
                </template>
                <time :datetime="item.createdAt">{{ localTaskTime(item.createdAt) }}</time>
            </p>
            <p class="m-0">{{ notificationMessage(item) }}</p>
            <router-link
                class="navigation-link"
                :id="`notification-target-${item.id}`"
                :to="notificationTarget(item)"
            >
                <app-icon :name="item.kind !== 'workflow' && item.reportId ? 'report' : 'run'" />{{
                    item.kind === 'workflow'
                        ? '查看工作流运行'
                        : item.reportId
                          ? '阅读报告'
                          : '查看执行'
                }}<app-icon name="chevron" />
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
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import {
    notificationLabel,
    notificationMessage,
    notificationStatus,
    notificationTarget,
} from '@/composable/useNotifications';
import { localTaskTime } from '@/composable/useTasks';
defineProps<{ item: Notification; pending?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ read: [read: boolean] }>();
</script>
