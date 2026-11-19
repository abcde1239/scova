<template>
    <app-theme-provider :locale="locale === 'en' ? 'en' : 'zh-CN'">
        <notification-session />
        <status-layout v-if="booting">
            <state-panel state="loading" :message="t('status.restoring')" centered />
        </status-layout>
        <status-layout v-else-if="route.meta.layout === 'status'">
            <router-view />
        </status-layout>
        <auth-layout
            v-else-if="route.meta.layout === 'auth'"
            :title="title"
            :register="route.name === 'register'"
        >
            <session-boundary><router-view /></session-boundary>
        </auth-layout>
        <workbench-layout v-else :title="title" :navigation="navigation">
            <template #context><router-view v-if="visible" name="context" /></template>
            <template #tools>
                <router-view v-if="visible" name="tools" />
            </template>
            <template #reading><router-view v-if="visible" name="reading" /></template>
            <session-boundary><router-view /></session-boundary>
        </workbench-layout>
    </app-theme-provider>
</template>

<script setup lang="ts">
import { computed, nextTick, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterView, useRoute, useRouter } from 'vue-router';
import AppThemeProvider from '@/component/theme/AppThemeProvider.vue';
import NotificationSession from '@/component/common/NotificationSession.vue';
import AuthLayout from '@/layout/AuthLayout.vue';
import WorkbenchLayout from '@/layout/WorkbenchLayout.vue';
import StatusLayout from '@/layout/StatusLayout.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { pageTitle, routeTitle } from '@/router';
import SessionBoundary from '@/component/auth/SessionBoundary.vue';
import { isPublicPage, useSession } from '@/composable/useSession';

const route = useRoute();
const router = useRouter();
const session = useSession();
const booting = computed(
    () =>
        !route.matched.length ||
        (route.name !== 'service-unavailable' && session.phase.value !== 'ready'),
);
const visible = computed(
    () => session.phase.value === 'ready' && (isPublicPage(route) || !!session.user.value),
);
const { locale, t } = useI18n({ useScope: 'global' });
const title = computed(() => routeTitle(route, t));
const navigation = router.getRoutes().filter((item) => item.meta.navigation);

watchEffect(() => {
    document.documentElement.lang = locale.value;
    document.title = pageTitle(route, t);
});

watch(
    () => route.fullPath,
    async (path) => {
        await nextTick();
        if (path === route.fullPath) document.getElementById('main-content')?.focus();
    },
    { immediate: true, flush: 'post' },
);
</script>
