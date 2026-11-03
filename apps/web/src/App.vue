<template>
    <app-theme-provider>
        <workbench-layout :title="title" :navigation="navigation">
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
import { computed, nextTick, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import AppThemeProvider from '@/theme/AppThemeProvider.vue';
import WorkbenchLayout from '@/layout/WorkbenchLayout.vue';
import { pageTitle } from '@/router';
import SessionBoundary from '@/components/auth/SessionBoundary.vue';
import { isPublicPage, useSession } from '@/composables/useSession';

const route = useRoute();
const router = useRouter();
const session = useSession();
const visible = computed(
    () => session.phase.value === 'ready' && (isPublicPage(route) || !!session.user.value),
);
const title = computed(() => route.meta.title ?? 'Scova');
const navigation = router.getRoutes().filter((item) => item.meta.navigation);

watch(
    () => route.fullPath,
    async (path) => {
        document.title = pageTitle(route);
        await nextTick();
        if (path === route.fullPath) document.getElementById('main-content')?.focus();
    },
    { immediate: true, flush: 'post' },
);
</script>
