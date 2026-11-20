<template>
    <nav
        v-if="items.length > 1"
        class="breadcrumbs text-muted text-[0.875rem] break-anywhere"
        :aria-label="t('shell.breadcrumbs')"
    >
        <ol
            class="[.breadcrumbs_&:is(ol)]:(flex flex-wrap items-center gap-1.5 min-w-0 list-none mt-0 mb-1.5 mx-0 p-0)"
        >
            <li
                class="[.breadcrumbs_&:is(li)]:(flex flex-wrap items-center gap-1.5 min-w-0)"
                v-for="(item, index) in items"
                :key="item.label"
            >
                <app-icon v-if="index" name="chevron" />
                <router-link
                    class="[.breadcrumbs_&:is(a)]:(inline-flex items-center min-h-11 internal-link) [.breadcrumbs_&:is(a):focus-visible]:([outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.125rem])"
                    :to="item.to ?? route.fullPath"
                    :aria-current="index === items.length - 1 ? 'page' : undefined"
                    :class="{ 'font-semibold text-default': index === items.length - 1 }"
                    >{{ item.label }}</router-link
                >
            </li>
        </ol>
    </nav>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { routeTitle } from '@/router';
import { computed, inject } from 'vue';
import { breadcrumbContext } from '@/layout/breadcrumbs';
import { RouterLink, useRoute } from 'vue-router';
import AppIcon from '@/component/common/AppIcon.vue';

const route = useRoute();
const { t } = useI18n({ useScope: 'global' });

const context = inject(breadcrumbContext, undefined);
const sections: Record<string, { key: string; to: string }> = {
    tasks: { key: 'pages.tasks', to: '/tasks' },
    projects: { key: 'pages.projects', to: '/projects' },
    workflows: { key: 'pages.workflows', to: '/workflows' },
    inbox: { key: 'pages.inbox', to: '/inbox' },
    library: { key: 'pages.library', to: '/library' },
    account: { key: 'pages.account', to: '/account' },
    notifications: { key: 'pages.notifications', to: '/notifications' },
};
const items = computed(() => {
    const parent = sections[String(route.meta.section)];
    const result: { label: string; to?: string }[] = [];
    if (parent && route.path !== parent.to) {
        const link = { label: t(parent.key), to: parent.to };
        const status = route.meta.section === 'tasks' ? route.query.status : undefined;
        result.push(
            typeof status === 'string'
                ? { ...link, to: `${parent.to}?status=${encodeURIComponent(status)}` }
                : link,
        );
    }
    if (route.name === 'task-edit' && typeof route.params.taskId === 'string')
        result.push({ label: t('pages.taskSummary'), to: `/tasks/${route.params.taskId}` });
    if (route.name === 'run-detail' && context?.value?.path === route.fullPath)
        result.push({ label: context.value.label, to: context.value.to });
    result.push({ label: routeTitle(route, t) });
    return result;
});
</script>
