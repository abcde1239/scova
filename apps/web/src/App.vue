<template>
    <app-theme-provider>
        <workbench-layout :title="title" :navigation="navigation">
            <template #context><router-view name="context" /></template>
            <template #tools><router-view name="tools" /></template>
            <template #reading><router-view name="reading" /></template>
            <router-view />
        </workbench-layout>
    </app-theme-provider>
</template>

<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import AppThemeProvider from '@/theme/AppThemeProvider.vue';
import WorkbenchLayout from '@/layout/WorkbenchLayout.vue';
import { pageTitle } from '@/router';

const route = useRoute();
const router = useRouter();
const title = computed(() => route.meta.title ?? '知巡 Scova');
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
