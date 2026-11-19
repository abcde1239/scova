<template>
    <article
        class="report-history-entry layout-stack pt-8 pb-8 [border-bottom:0.0625rem_solid_var(--scova-border)] break-anywhere"
        :aria-labelledby="`history-title-${item.id}`"
    >
        <h2 :id="`history-title-${item.id}`" class="scova-content-title m-0">
            <router-link
                class="[h2_&:is(a)]:(inline-flex items-center min-h-11 max-w-full title-link) cursor-pointer keyboard-focus-wide"
                :id="`history-report-${item.id}`"
                :to="{ name: 'report-detail', params: { reportId: item.id } }"
                @click="emit('open', item.id, $event)"
                >{{ item.title }}</router-link
            >
        </h2>
        <p class="history-metadata flex flex-wrap gap-[0.5rem_1.25rem] text-muted m-0">
            <strong class="text-default font-medium">{{
                item.mode === 'demo' ? '演示报告' : '研究报告'
            }}</strong>
            <span>{{
                item.coverage.delivery
                    ? reportDeliveryLabels[item.coverage.delivery.status]
                    : item.coverage.completeness === 'partial'
                      ? '有范围说明'
                      : '计划范围内完成'
            }}</span>
            <time :datetime="item.publishedAt">{{ localTaskTime(item.publishedAt) }}</time>
        </p>
        <p
            v-if="item.coverage.completeness === 'partial'"
            class="partial [color:var(--scova-partial)] font-medium m-0"
        >
            结果已生成，未覆盖项目见报告详情。
        </p>
        <p class="history-summary max-w-[60ch] whitespace-pre-wrap m-0">{{ item.summary }}</p>
        <router-link
            class="navigation-link"
            :to="{ name: 'run-detail', params: { runId: item.runId } }"
            >查看执行<app-icon name="chevron"
        /></router-link>
    </article>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { reportDeliveryLabels } from '@scova/models';
import type { ReportHistoryItem } from '@/api/reports';
import AppIcon from '@/component/common/AppIcon.vue';
import { localTaskTime } from '@/composable/useTasks';
import '@/composable/reading-fonts.css';
defineProps<{ item: ReportHistoryItem }>();
const emit = defineEmits<{ open: [reportId: string, event: MouseEvent] }>();
</script>
