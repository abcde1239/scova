<template>
    <nav
        v-if="items.length > 1"
        class="breadcrumbs text-muted text-[0.875rem] break-anywhere"
        aria-label="面包屑导航"
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
import { computed, inject } from 'vue';
import { breadcrumbContext } from '@/layout/breadcrumbs';
import { RouterLink, useRoute } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';

const route = useRoute();
const context = inject(breadcrumbContext, undefined);
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
    if (parent && route.path !== parent.to) {
        const status = route.meta.section === 'tasks' ? route.query.status : undefined;
        result.push(
            typeof status === 'string'
                ? { ...parent, to: `${parent.to}?status=${encodeURIComponent(status)}` }
                : parent,
        );
    }
    if (route.name === 'task-edit' && typeof route.params.taskId === 'string')
        result.push({ label: '任务摘要', to: `/tasks/${route.params.taskId}` });
    if (route.name === 'run-detail' && context?.value?.path === route.fullPath)
        result.push({ label: context.value.label, to: context.value.to });
    result.push({ label: route.meta.title ?? '页面' });
    return result;
});
</script>
