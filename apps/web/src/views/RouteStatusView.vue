<template>
    <template v-if="route.name === 'appearance'">
        <appearance-selector />
        <reading-preferences />
    </template>
    <div v-else class="route-status">
        <p v-if="route.name === 'not-found'">此页面不存在。</p>
        <p v-else>{{ route.meta.title }}功能尚未接入。</p>
        <router-link v-if="route.name === 'account'" to="/account/appearance">
            外观设置
        </router-link>
        <router-link v-if="route.name === 'not-found'" to="/tasks">返回任务</router-link>
    </div>
</template>

<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import AppearanceSelector from '@/components/common/AppearanceSelector.vue';
import ReadingPreferences from '@/components/common/ReadingPreferences.vue';

const route = useRoute();
</script>

<style scoped>
.route-status {
    display: grid;
    justify-items: start;
    gap: 1.5rem;
    color: var(--scova-muted);
}

a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    text-underline-offset: 0.2em;
    cursor: pointer;
}

a:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
