<template>
    <div
        class="workbench min-h-[100dvh]"
        :class="{
            'workbench--thread': threadPage,
            'workbench--collapsed': sidebar.collapsed,
            'workbench--report': route.name === 'report-detail',
        }"
        :style="{ '--project-sidebar-width': `${workspace.width('sidebar')}px` }"
    >
        <a
            class="skip-link fixed top-2 left-2 z-10 inline-flex items-center min-h-11 text-default no-underline bg-surface -translate-y-[200%] py-2 px-4 keyboard-focus-wide focus:translate-y-0"
            href="#main-content"
            >{{ t('shell.skip') }}</a
        >
        <header class="workbench-header">
            <mobile-navigation :items="mobileItems">
                <template #projects><project-sidebar v-if="!workspace.desktop.value" /></template>
            </mobile-navigation>
            <div class="sidebar-heading">
                <button
                    class="sidebar-toggle"
                    type="button"
                    :aria-expanded="!sidebar.collapsed"
                    aria-controls="workbench-project-list"
                    :aria-label="sidebarToggleLabel"
                    :title="sidebarToggleLabel"
                    @click="sidebar.toggle"
                >
                    <app-icon name="chevron" />
                </button>
                <router-link class="brand" to="/" :aria-label="t('shell.workspaceHome')">
                    <img src="/favicon.ico?v=ebde566c" alt="" class="w-6 h-6 object-contain" />
                    <span lang="en">Scova</span>
                </router-link>
            </div>
            <nav
                id="workbench-project-sidebar"
                class="primary-navigation"
                :aria-label="t('shell.primaryNav')"
            >
                <div
                    id="workbench-project-list"
                    v-show="workspace.desktop.value && !sidebar.collapsed"
                >
                    <project-sidebar v-if="workspace.desktop.value" />
                    <span class="px-2 pt-2 text-sm font-semibold" lang="zh-CN">管理</span>
                </div>
                <router-link
                    v-if="sidebar.collapsed"
                    class="sidebar-link"
                    :to="{ name: 'projects' }"
                    :title="t('pages.projects')"
                    :class="{ selected: route.meta.section === 'projects' }"
                    :aria-current="route.name === 'projects' ? 'page' : undefined"
                >
                    <app-icon name="projects" />
                    <span class="sidebar-label">{{ t('pages.projects') }}</span>
                </router-link>
                <router-link
                    v-for="item in primary"
                    :key="String(item.name)"
                    class="sidebar-link"
                    :to="item.path"
                    :title="sidebar.collapsed ? routeTitle(item, t) : undefined"
                    :class="{ selected: isSelected(item) }"
                    :aria-current="route.path === item.path ? 'page' : undefined"
                >
                    <app-icon :name="navigationIcon(item.meta.section)" />
                    <span class="sidebar-label">{{ routeTitle(item, t) }}</span>
                </router-link>
                <router-link
                    class="sidebar-link"
                    :to="{ name: 'report-history' }"
                    :title="sidebar.collapsed ? t('pages.reportHistory') : undefined"
                >
                    <app-icon name="report" />
                    <span class="sidebar-label">{{ t('pages.reportHistory') }}</span>
                </router-link>
            </nav>
            <div id="workbench-sidebar-footer" class="sidebar-footer">
                <nav class="tool-navigation" :aria-label="t('shell.toolsNav')">
                    <template v-for="item in tools" :key="String(item.name)">
                        <notification-menu
                            v-if="item.meta.section === 'notifications'"
                            :selected="isSelected(item)"
                            placement="right-end"
                            compact
                        />
                        <router-link
                            v-else
                            class="sidebar-link"
                            :to="item.path"
                            :title="sidebar.collapsed ? routeTitle(item, t) : undefined"
                            :class="{ selected: isSelected(item) }"
                            :aria-current="route.path === item.path ? 'page' : undefined"
                        >
                            <app-icon :name="navigationIcon(item.meta.section)" />
                            <span class="sidebar-label">{{ routeTitle(item, t) }}</span>
                        </router-link>
                    </template>
                    <interface-language-select class="sidebar-language" icon-only />
                </nav>
                <interface-language-select class="mobile-language" />
                <account-menu :compact="sidebar.collapsed" />
            </div>
            <workspace-separator
                v-if="threadPage && workspace.desktop.value && !sidebar.collapsed"
                pane="sidebar"
                label="项目导航宽度"
                controls="workbench-project-sidebar"
            />
        </header>
        <main
            id="main-content"
            class="workbench-main"
            :class="{
                'workbench-main--form': route.meta.contentWidth === 'form',
                'workbench-main--thread': threadPage,
                'workbench-main--report': route.name === 'report-detail',
            }"
            tabindex="-1"
            aria-labelledby="page-title"
        >
            <page-breadcrumbs
                v-if="!threadPage && route.name !== 'report-detail'"
                class="flex flex-wrap gap-2 [.page-heading_>_&]:(min-w-0 max-w-full break-anywhere)"
            />
            <div
                v-if="!threadPage"
                class="page-heading flex flex-wrap items-center justify-between gap-4 mb-4 [&.page-heading.page-heading--report]:(min-h-0 m-0) [.page-heading_>_&]:(min-w-0 max-w-full break-anywhere)"
                :class="{ 'page-heading--report': route.name === 'report-detail' }"
            >
                <h1
                    class="[.page-heading--report_&:is(h1)]:(absolute w-[1px] h-[1px] overflow-hidden [clip-path:inset(50%)] whitespace-nowrap) [.page-heading_>_&]:(min-w-0 max-w-full break-anywhere) m-0"
                    id="page-title"
                >
                    {{ title }}
                </h1>
                <div
                    lang="zh-CN"
                    class="page-tools min-w-0 max-w-full break-anywhere [.page-heading_>_&]:(min-w-0 max-w-full break-anywhere)"
                >
                    <slot name="tools" />
                </div>
            </div>
            <div
                lang="zh-CN"
                class="page-context min-w-0 max-w-full break-anywhere [.page-heading_>_&]:(min-w-0 max-w-full break-anywhere) [&.page-context:not(:empty)]:(mt-4 mb-4)"
            >
                <slot name="context" />
            </div>
            <div
                v-if="route.name !== 'not-found'"
                lang="zh-CN"
                :class="{ 'workbench-thread-body': threadPage }"
            >
                <slot />
            </div>
            <slot v-else />
            <div
                lang="zh-CN"
                class="reading-tools min-w-0 max-w-full break-anywhere [.page-heading_>_&]:(min-w-0 max-w-full break-anywhere) [&.reading-tools:not(:empty)]:(mt-4 mb-4)"
            >
                <slot name="reading" />
            </div>
        </main>
    </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import InterfaceLanguageSelect from '@/component/common/InterfaceLanguageSelect.vue';
import { routeTitle } from '@/router';
import { computed, provide, shallowRef } from 'vue';
import { breadcrumbContext, type BreadcrumbContext } from '@/layout/breadcrumbs';
import { RouterLink, useRoute } from 'vue-router';
import type { RouteRecordNormalized } from 'vue-router';
import AppIcon from '@/component/common/AppIcon.vue';
import type { IconName } from '@/utils/icons';
import MobileNavigation from '@/layout/MobileNavigation.vue';
import PageBreadcrumbs from '@/layout/PageBreadcrumbs.vue';
import AccountMenu from '@/layout/AccountMenu.vue';
import NotificationMenu from '@/component/notifications/NotificationMenu.vue';
import ProjectSidebar from '@/layout/ProjectSidebar.vue';
import WorkspaceSeparator from '@/layout/WorkspaceSeparator.vue';
import {
    projectWorkspaceLayoutKey,
    useProjectWorkspaceLayout,
} from '@/composable/useProjectWorkspaceLayout';
import { useSidebarStore } from '@/store/sidebar';

const props = defineProps<{ title: string; navigation: RouteRecordNormalized[] }>();
defineSlots<{ default(): unknown; context(): unknown; tools(): unknown; reading(): unknown }>();
const route = useRoute();
const { t } = useI18n({ useScope: 'global' });
const sidebar = useSidebarStore();
const sidebarToggleLabel = computed(() =>
    t(sidebar.collapsed ? 'shell.expandSidebar' : 'shell.collapseSidebar'),
);

provide(breadcrumbContext, shallowRef<BreadcrumbContext>());
const workspace = useProjectWorkspaceLayout();
provide(projectWorkspaceLayoutKey, workspace);
const threadPage = computed(() => route.name === 'project-thread');
const sectionOrder = ['tasks', 'workflows', 'library', 'inbox'];
const primary = computed(() =>
    props.navigation
        .filter((item) => item.meta.navigation === 'primary' && item.meta.section !== 'projects')
        .sort(
            (left, right) =>
                sectionOrder.indexOf(String(left.meta.section)) -
                sectionOrder.indexOf(String(right.meta.section)),
        ),
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
        section === 'projects' ||
        section === 'workflows' ||
        section === 'inbox' ||
        section === 'library' ||
        section === 'notifications'
    )
        return section;
    return 'account';
}
const mobileItems = computed(() => [
    { path: '/tasks/new', label: t('pages.createTask'), icon: 'create' as const },
    ...[...primary.value, ...tools.value].map((item) => ({
        path: item.path,
        label: routeTitle(item, t),
        icon: navigationIcon(item.meta.section),
    })),
    { path: '/tasks/reports', label: t('pages.reportHistory'), icon: 'report' as const },
    { path: '/account/agent', label: t('pages.agent'), icon: 'settings' as const },
    { path: '/account/appearance', label: t('pages.appearance'), icon: 'appearance' as const },
]);
</script>

<style scoped>
.workbench-header {
    @apply flex flex-wrap items-center gap-x-2 min-h-[3.75rem] min-w-0 px-3 py-1.5
        [border-bottom:1px_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)];
}
.brand {
    @apply inline-flex items-center gap-2 min-h-11 text-[1.125rem] font-semibold text-default
        no-underline whitespace-nowrap rounded-2 keyboard-focus-wide;
}
.sidebar-heading {
    @apply contents;
}
.sidebar-toggle,
.primary-navigation,
.tool-navigation {
    @apply hidden;
}
.sidebar-footer {
    @apply contents;
}
.mobile-language {
    @apply ml-auto min-w-0;
}
.workbench-main {
    --workbench-gutter: clamp(1rem, 2vw, 2rem);

    @apply w-full min-w-0 max-w-[88rem] mx-auto pt-8 pb-8 [padding-inline:var(--workbench-gutter)]
        focus:[outline:none];
}
.workbench-main:has(> .breadcrumbs) {
    @apply pt-3;
}
.workbench-main--report {
    @apply max-w-none p-0;
    overflow-wrap: anywhere;
}
.workbench-main--form {
    @apply max-w-[calc(44rem_+_2_*_var(--workbench-gutter))];
}
.workbench--thread {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    block-size: 100dvh;
}
.workbench-main--thread {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    max-inline-size: none;
    min-block-size: 0;
    padding: 0;
}
.workbench-main--thread > :not(.workbench-thread-body) {
    display: none;
}
.workbench-thread-body {
    min-inline-size: 0;
    min-block-size: 0;
}
@media (min-width: 54rem) {
    .workbench {
        --workbench-sidebar-width: min(15.5rem, 30vw);

        @apply grid;
        grid-template-columns: var(--workbench-sidebar-width) minmax(0, 1fr);
    }
    .workbench--thread {
        --workbench-sidebar-width: var(--project-sidebar-width);

        grid-template-rows: minmax(0, 1fr);
    }
    .workbench--report {
        --workbench-sidebar-width: min(12.5rem, 25vw);
    }
    .workbench-header {
        @apply sticky top-0 z-[5] self-start grid grid-cols-[minmax(0,_1fr)]
            grid-rows-[auto_minmax(0,_1fr)_auto] items-start gap-3 h-[100dvh] min-h-0
            px-2.5 py-3 [border-bottom:0]
            [border-inline-end:1px_solid_color-mix(in_srgb,_var(--scova-border)_28%,_transparent)]
            [background:color-mix(in_srgb,_var(--scova-canvas)_70%,_var(--scova-selected))];
    }
    .sidebar-heading {
        @apply flex items-center gap-1;
    }
    .sidebar-toggle {
        @apply inline-grid place-items-center shrink-0 w-11 h-11 rounded-2 text-muted text-[1rem]
            bg-transparent border-0 cursor-pointer keyboard-focus-inset motion-safe:transition-colors;
    }
    .sidebar-toggle:hover {
        @apply [background:var(--scova-selected)] text-default;
    }
    .sidebar-toggle[aria-expanded='true'] :deep(svg) {
        @apply rotate-180;
    }
    .brand {
        @apply px-1;
    }
    .primary-navigation {
        /* Keep the popovers in the footer outside the scrolling region. */
        @apply self-stretch grid grid-cols-[minmax(0,_1fr)] content-start gap-0.5 min-h-0
            [overflow-y:auto] [overscroll-behavior:contain];
    }
    .sidebar-link {
        @apply flex items-center gap-2.5 min-h-11 min-w-0 rounded-2 text-[0.875rem] text-default
            no-underline break-anywhere px-2.5 py-2 keyboard-focus-inset;
    }
    .sidebar-link:hover {
        @apply [background:var(--scova-selected)] text-primary;
    }
    .sidebar-link.selected {
        @apply bg-surface font-semibold
            [box-shadow:inset_0.125rem_0_var(--scova-primary),inset_0_0_0_1px_color-mix(in_srgb,_var(--scova-border)_22%,_transparent)];
    }
    .sidebar-footer {
        @apply grid grid-cols-[minmax(0,_1fr)] gap-1 pt-2
            [border-top:1px_solid_color-mix(in_srgb,_var(--scova-border)_28%,_transparent)];
    }
    .tool-navigation {
        @apply flex flex-wrap items-center gap-1 min-w-0;
    }
    .tool-navigation :deep(.notification-trigger),
    .sidebar-language :deep(.select-trigger) {
        @apply justify-center w-11 h-11 min-h-11 p-0 text-[1rem];
    }
    .tool-navigation :deep(.notification-trigger:not(.selected):not(:hover)) {
        @apply text-muted;
    }
    .mobile-language {
        @apply hidden;
    }
    .workbench--collapsed {
        --workbench-sidebar-width: 4rem;
    }
    .workbench--collapsed .workbench-header {
        @apply px-2;
    }
    .workbench--collapsed .sidebar-heading {
        @apply justify-center;
    }
    .workbench--collapsed .brand {
        @apply hidden;
    }
    .workbench--collapsed .tool-navigation {
        @apply flex-col;
    }
    .workbench--collapsed .sidebar-link {
        @apply justify-center gap-0 px-0;
    }
    .workbench--collapsed .sidebar-label {
        @apply sr-only;
    }
}
</style>
