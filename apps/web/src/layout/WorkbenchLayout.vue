<template>
    <div class="workbench min-h-[100dvh]">
        <a
            class="skip-link inline-flex items-center gap-[0.5em] min-h-11 text-default no-underline cursor-pointer fixed [top:0.5rem] [left:0.5rem] z-[10] bg-surface [transform:translateY(-200%)] py-2 px-4 keyboard-focus-wide [nav_&:is(a)]:(rounded-2 py-2 px-3.5) [nav_&:is(a):hover]:([background:var(--scova-selected)] text-primary) focus:[transform:translateY(0)]"
            href="#main-content"
            >{{ t('shell.skip') }}</a
        >
        <div
            class="workbench-header-bar [border-bottom:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_30%,_transparent)]"
        >
            <header
                class="workbench-header w-[min(100%,_88rem)] ml-auto mr-auto min-w-0 flex flex-wrap items-center gap-[0.5rem_1.5rem] min-h-[4.5rem] py-2 px-[clamp(1rem,_2.5vw,_2rem)] [@media(max-width:_53.999rem)]:(gap-[0.5rem_1rem] min-h-[3.75rem] pt-1.5 pb-1.5)"
            >
                <mobile-navigation :items="mobileItems" />
                <router-link
                    class="brand inline-flex items-center gap-[0.5em] min-h-11 text-inherit no-underline cursor-pointer keyboard-focus-wide [&&]:(text-[1.25rem] [font-weight:650] whitespace-nowrap) [nav_&:is(a)]:(rounded-2 py-2 px-3.5) [nav_&:is(a):hover]:([background:var(--scova-selected)] text-primary)"
                    to="/tasks"
                    :aria-label="t('shell.taskHome')"
                >
                    <img src="/favicon.ico?v=ebde566c" alt="" class="w-6 h-6 object-contain" />
                    <span lang="en">Scova</span>
                </router-link>
                <nav
                    class="primary-navigation flex flex-wrap gap-2 [@media(max-width:_53.999rem)]:hidden"
                    :aria-label="t('shell.primaryNav')"
                >
                    <router-link
                        class="inline-flex items-center gap-[0.5em] min-h-11 text-inherit no-underline cursor-pointer keyboard-focus-wide [nav_&:is(a)]:(rounded-2 py-2 px-3.5) [nav_&:is(a):hover]:([background:var(--scova-selected)] text-primary) [&.selected]:([background:var(--scova-selected)] text-primary font-semibold)"
                        v-for="item in primary"
                        :key="String(item.name)"
                        :to="item.path"
                        :class="{ selected: isSelected(item) }"
                        :aria-current="route.path === item.path ? 'page' : undefined"
                    >
                        <app-icon
                            class="[.page-heading_>_&]:(min-w-0 max-w-full break-anywhere)"
                            :name="navigationIcon(item.meta.section)"
                        />
                        {{ routeTitle(item, t) }}
                    </router-link>
                </nav>
                <nav
                    class="tool-navigation flex flex-wrap gap-2 ml-auto [@media(max-width:_53.999rem)]:hidden"
                    :aria-label="t('shell.toolsNav')"
                >
                    <template v-for="item in tools" :key="String(item.name)">
                        <notification-menu
                            v-if="item.meta.section === 'notifications'"
                            :selected="isSelected(item)"
                        />
                        <router-link
                            class="inline-flex items-center gap-[0.5em] min-h-11 text-inherit no-underline cursor-pointer keyboard-focus-wide [nav_&:is(a)]:(rounded-2 py-2 px-3.5) [nav_&:is(a):hover]:([background:var(--scova-selected)] text-primary) [&.selected]:([background:var(--scova-selected)] text-primary font-semibold)"
                            v-else
                            :to="item.path"
                            :class="{ selected: isSelected(item) }"
                            :aria-current="route.path === item.path ? 'page' : undefined"
                        >
                            <app-icon
                                class="[.page-heading_>_&]:(min-w-0 max-w-full break-anywhere)"
                                :name="navigationIcon(item.meta.section)"
                            />
                            {{ routeTitle(item, t) }}
                        </router-link>
                    </template>
                </nav>
                <interface-language-select class="[@media(max-width:_53.999rem)]:ml-auto" />
                <account-menu />
            </header>
        </div>
        <main
            id="main-content"
            class="workbench-main w-[min(100%,_88rem)] ml-auto mr-auto min-w-0 pt-8 [&:has(>_.breadcrumbs)]:pt-3 pb-8 px-[clamp(1rem,_2.5vw,_2rem)] [&.workbench]:min-h-[100dvh] focus:[outline:none] [&.workbench-main--form]:w-[min(100%,_calc(44rem_+_clamp(2rem,_5vw,_4rem)))]"
            :class="{ 'workbench-main--form': route.meta.contentWidth === 'form' }"
            tabindex="-1"
            aria-labelledby="page-title"
        >
            <page-breadcrumbs
                class="flex flex-wrap gap-2 [.page-heading_>_&]:(min-w-0 max-w-full break-anywhere)"
            />
            <div
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
            <div v-if="route.name !== 'not-found'" lang="zh-CN"><slot /></div>
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

const props = defineProps<{ title: string; navigation: RouteRecordNormalized[] }>();
defineSlots<{ default(): unknown; context(): unknown; tools(): unknown; reading(): unknown }>();
const route = useRoute();
const { t } = useI18n({ useScope: 'global' });

provide(breadcrumbContext, shallowRef<BreadcrumbContext>());
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
const mobileOrder = ['tasks', 'inbox', 'library', 'notifications'];
const mobileItems = computed(() => [
    ...[...primary.value, ...tools.value]
        .sort(
            (left, right) =>
                mobileOrder.indexOf(String(left.meta.section)) -
                mobileOrder.indexOf(String(right.meta.section)),
        )
        .map((item) => ({
            path: item.path,
            label: routeTitle(item, t),
            icon: navigationIcon(item.meta.section),
        })),
    { path: '/account/agent', label: t('pages.agent'), icon: 'settings' as const },
    { path: '/account/appearance', label: t('pages.appearance'), icon: 'appearance' as const },
]);
</script>
