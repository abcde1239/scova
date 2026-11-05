<template>
    <nav v-if="items.length > 1" class="breadcrumbs" aria-label="面包屑导航">
        <ol>
            <li v-for="(item, index) in items" :key="item.label">
                <app-icon v-if="index" name="chevron" />
                <router-link v-if="item.to" :to="item.to">{{ item.label }}</router-link>
                <span v-else aria-current="page">{{ item.label }}</span>
            </li>
        </ol>
    </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';

const route = useRoute();
const sections: Record<string, { label: string; to: string }> = {
    tasks: { label: '任务', to: '/tasks' },
    inbox: { label: '收件箱', to: '/inbox' },
    library: { label: '资料库', to: '/library' },
    account: { label: '账号', to: '/account' },
    notifications: { label: '通知', to: '/notifications' },
};
const items = computed(() => {
    const parent = sections[String(route.meta.section)];
    const result: { label: string; to?: string }[] = [];
    if (parent && route.path !== parent.to) result.push(parent);
    if (route.name === 'task-edit' && typeof route.params.taskId === 'string')
        result.push({ label: '任务摘要', to: `/tasks/${route.params.taskId}` });
    result.push({ label: route.meta.title ?? '页面' });
    return result;
});
</script>

<style scoped>
.breadcrumbs ol,
.breadcrumbs li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    min-inline-size: 0;
}
.breadcrumbs ol {
    list-style: none;
    padding: 0;
    margin: 0 0 0.375rem;
}
.breadcrumbs {
    color: var(--scova-muted);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
}
.breadcrumbs a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    text-underline-offset: 0.2em;
}
.breadcrumbs a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.125rem;
}
</style>
