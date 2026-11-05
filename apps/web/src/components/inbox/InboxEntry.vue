<template>
    <article class="inbox-entry" :aria-labelledby="`inbox-title-${item.id}`">
        <div class="entry-content">
            <h2 :id="`inbox-title-${item.id}`" class="scova-content-title">
                <router-link
                    :id="`inbox-report-${item.id}`"
                    :to="{ name: 'report-detail', params: { reportId: item.reportId } }"
                    @click="emit('open', $event)"
                >
                    {{ item.report.title }}
                </router-link>
            </h2>
            <p class="entry-metadata">
                <strong>{{ item.readAt ? '已读' : '未读' }}</strong>
                <span>{{ item.report.mode === 'demo' ? '演示报告' : '真实查阅' }}</span>
                <time :datetime="item.report.publishedAt">{{ published }}</time>
            </p>
            <p v-if="item.report.coverage.completeness === 'partial'" class="partial">
                部分交付，结论仍有缺口；不能据此认定没有重要变化。
            </p>
            <p
                :id="summaryId"
                class="entry-summary"
                :class="{ collapsed: longSummary && !expanded }"
            >
                {{ item.report.summary }}
            </p>
            <button
                v-if="longSummary"
                class="summary-toggle"
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

<style scoped>
.inbox-entry {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    gap: 0.75rem 1.5rem;
    padding-block: 1.25rem;
    border-block-end: 0.0625rem solid color-mix(in srgb, var(--scova-border) 35%, transparent);
    min-inline-size: 0;
}
.entry-content {
    display: grid;
    gap: 0.5rem;
    flex: 1 1 30rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
h2,
p {
    margin: 0;
}
a {
    color: var(--scova-text);
    cursor: pointer;
    text-decoration: none;
}
a:hover {
    color: var(--scova-primary);
    text-decoration: underline;
    text-underline-offset: 0.2em;
}
a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.entry-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem 0.875rem;
    color: var(--scova-muted);
}
.entry-metadata strong {
    color: var(--scova-text);
    font-weight: 500;
}
.partial {
    color: var(--scova-partial);
    font-weight: 500;
}
.entry-summary {
    max-inline-size: 72ch;
    white-space: pre-wrap;
}
.entry-summary.collapsed {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.summary-toggle {
    justify-self: start;
    min-block-size: 2.75rem;
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    color: var(--scova-primary);
    cursor: pointer;
}
.summary-toggle:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
</style>
