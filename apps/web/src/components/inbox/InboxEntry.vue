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
            <p class="entry-summary">{{ item.report.summary }}</p>
        </div>
        <action-button :busy="pending" :disabled="disabled" @click="emit('read', !item.readAt)">
            <app-icon :name="item.readAt ? 'inbox' : 'confirm'" />
            {{ pending ? '正在更新' : item.readAt ? '恢复未读' : '标记已读' }}
        </action-button>
    </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { InboxItem } from '@/api/inbox';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import '@/styles/reading-fonts.css';
const props = defineProps<{ item: InboxItem; pending?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ read: [read: boolean]; open: [event: MouseEvent] }>();
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
    gap: 1.5rem 2rem;
    padding-block: 2rem;
    border-block-end: 0.0625rem solid var(--scova-border);
    min-inline-size: 0;
}
.entry-content {
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
    gap: 0.5rem 1.25rem;
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
    max-inline-size: 55ch;
    white-space: pre-wrap;
}
</style>
