<template>
    <article
        class="inbox-entry flex flex-wrap items-start gap-[0.75rem_1.5rem] pt-5 pb-5 [border-bottom:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_35%,_transparent)] min-w-0"
        :aria-labelledby="`inbox-title-${item.id}`"
    >
        <div class="entry-content layout-grid gap-2 [flex:1_1_30rem] break-anywhere">
            <h2 :id="`inbox-title-${item.id}`" class="scova-content-title m-0">
                <router-link
                    class="text-default cursor-pointer no-underline keyboard-focus-wide hover:(text-primary underline underline-offset-[0.2em])"
                    :id="`inbox-report-${item.id}`"
                    :to="{ name: 'report-detail', params: { reportId: item.reportId } }"
                    @click="emit('open', $event)"
                >
                    {{ item.report.title }}
                </router-link>
            </h2>
            <p class="entry-metadata flex flex-wrap gap-[0.375rem_0.875rem] text-muted m-0">
                <strong class="[.entry-metadata_&:is(strong)]:(text-default font-medium)">{{
                    item.readAt ? '已读' : '未读'
                }}</strong>
                <span>{{ item.report.mode === 'demo' ? '演示报告' : '真实查阅' }}</span>
                <time :datetime="item.report.publishedAt">{{ published }}</time>
            </p>
            <p
                v-if="item.report.coverage.completeness === 'partial'"
                class="partial [color:var(--scova-partial)] font-medium m-0"
            >
                结果已生成，未覆盖项目见报告详情。
            </p>
            <p
                :id="summaryId"
                class="entry-summary max-w-[72ch] whitespace-pre-wrap m-0 [&.entry-summary.collapsed]:([display:-webkit-box] [-webkit-line-clamp:3] [-webkit-box-orient:vertical] overflow-hidden)"
                :class="{ collapsed: longSummary && !expanded }"
            >
                {{ item.report.summary }}
            </p>
            <button
                v-if="longSummary"
                class="summary-toggle justify-self-start min-h-11 [border:0] bg-transparent font-inherit text-primary cursor-pointer p-0 keyboard-focus"
                type="button"
                :aria-expanded="expanded"
                :aria-controls="summaryId"
                @click="expanded = !expanded"
            >
                {{ expanded ? '收起摘要' : '展开摘要' }}
            </button>
        </div>
        <action-button
            quaternary
            :busy="pending"
            :disabled="disabled"
            @click="emit('read', !item.readAt)"
        >
            <app-icon :name="item.readAt ? 'inbox' : 'confirm'" />
            {{ pending ? '正在更新' : item.readAt ? '恢复未读' : '标记已读' }}
        </action-button>
    </article>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { InboxItem } from '@/api/inbox';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import '@/styles/reading-fonts.css';
const props = defineProps<{ item: InboxItem; pending?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ read: [read: boolean]; open: [event: MouseEvent] }>();
const summaryId = `inbox-summary-${useId()}`;
const expanded = ref(false);
const longSummary = computed(
    () => props.item.report.summary.length > 100 || props.item.report.summary.includes('\n'),
);
watch([() => props.item.id, () => props.item.report.summary], () => {
    expanded.value = false;
});
const published = computed(() =>
    new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(props.item.report.publishedAt)),
);
</script>
