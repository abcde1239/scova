<template>
    <div class="workbench">
        <a class="skip-link" href="#main-content">跳到主内容</a>
        <header class="workbench-header">
            <router-link class="brand" to="/tasks" aria-label="Scova，任务首页">
                <span lang="en">Scova</span>
            </router-link>
            <nav class="primary-navigation" aria-label="主导航">
                <router-link
                    v-for="item in primary"
                    :key="String(item.name)"
                    :to="item.path"
                    :class="{ selected: isSelected(item) }"
                    :aria-current="route.path === item.path ? 'page' : undefined"
                >
                    <app-icon :name="navigationIcon(item.meta.section)" />
                    {{ item.meta.title }}
                </router-link>
            </nav>
            <nav class="tool-navigation" aria-label="全局工具">
                <router-link
                    v-for="item in tools"
                    :key="String(item.name)"
                    :to="item.path"
                    :class="{ selected: isSelected(item) }"
                    :aria-current="route.path === item.path ? 'page' : undefined"
                >
                    <app-icon :name="navigationIcon(item.meta.section)" />
                    {{ item.meta.title }}
                </router-link>
            </nav>
            <account-menu />
            <mobile-navigation :items="mobileItems" />
        </header>
        <main id="main-content" class="workbench-main" tabindex="-1" aria-labelledby="page-title">
            <page-breadcrumbs />
            <div class="page-heading">
                <h1 id="page-title">{{ title }}</h1>
                <div class="page-tools"><slot name="tools" /></div>
            </div>
            <div class="page-context"><slot name="context" /></div>
            <slot />
            <div class="reading-tools"><slot name="reading" /></div>
        </main>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type { RouteRecordNormalized } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import type { IconName } from '@/components/common/icons';
import MobileNavigation from '@/layout/MobileNavigation.vue';
import PageBreadcrumbs from '@/layout/PageBreadcrumbs.vue';
import AccountMenu from '@/layout/AccountMenu.vue';

const props = defineProps<{ title: string; navigation: RouteRecordNormalized[] }>();
defineSlots<{ default(): unknown; context(): unknown; tools(): unknown; reading(): unknown }>();
const route = useRoute();
const primary = computed(() =>
    props.navigation.filter((item) => item.meta.navigation === 'primary'),
);
const tools = computed(() =>
    props.navigation.filter(
        (item) => item.meta.navigation === 'tool' && item.meta.section !== 'account',
    ),
);
const isSelected = (item: RouteRecordNormalized) => route.meta.section === item.meta.section;
function navigationIcon(section: unknown): IconName {
    if (
        section === 'tasks' ||
        section === 'inbox' ||
        section === 'library' ||
        section === 'notifications'
    )
        return section;
    return 'account';
}
const mobileItems = computed(() => [
    ...[...primary.value, ...tools.value].map((item) => ({
        path: item.path,
        label: String(item.meta.title),
        icon: navigationIcon(item.meta.section),
    })),
    { path: '/account', label: '账号', icon: 'account' as const },
    { path: '/account/appearance', label: '外观', icon: 'appearance' as const },
]);
</script>

<style scoped>
.workbench {
    min-block-size: 100dvh;
}

.workbench-header,
.workbench-main {
    width: min(100%, 88rem);
    margin-inline: auto;
    padding-inline: clamp(1rem, 2.5vw, 2rem);
    min-inline-size: 0;
}

.workbench-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1.5rem;
    min-block-size: 4.5rem;
    padding-block: 0.5rem;
    border-block-end: 0.0625rem solid color-mix(in srgb, var(--scova-border) 30%, transparent);
}

.brand {
    font-size: 1.25rem;
    font-weight: 650;
    white-space: nowrap;
}

nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}

.tool-navigation {
    margin-inline-start: auto;
}

a {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    min-block-size: 2.75rem;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
}

nav a {
    padding: 0.5rem 0.875rem;
    border-radius: 0.5rem;
}

nav a:hover,
.selected {
    background: var(--scova-selected);
    color: var(--scova-primary);
}

.selected {
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 0.35em;
}

a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}

.workbench-main:focus {
    outline: none;
}

.workbench-main {
    padding-block: 0.75rem 2rem;
}

.page-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-block-end: 1rem;
}

.page-heading > *,
.page-tools,
.page-context,
.reading-tools {
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-wrap: anywhere;
}

@media (max-width: 53.999rem) {
    .primary-navigation,
    .tool-navigation {
        display: none;
    }

    .workbench-header {
        gap: 0.5rem 1rem;
        min-block-size: 3.75rem;
        padding-block: 0.375rem;
    }
}

h1 {
    margin: 0;
}

.page-context:not(:empty),
.reading-tools:not(:empty) {
    margin-block: 1rem;
}

.skip-link {
    position: fixed;
    inset-block-start: 0.5rem;
    inset-inline-start: 0.5rem;
    z-index: 10;
    padding: 0.5rem 1rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    transform: translateY(-200%);
}

.skip-link:focus {
    transform: translateY(0);
}
</style>
