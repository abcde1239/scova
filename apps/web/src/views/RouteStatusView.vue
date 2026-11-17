<template>
    <template v-if="route.name === 'appearance'">
        <appearance-selector />
        <reading-preferences />
    </template>
    <div v-else class="route-status grid [justify-items:start] gap-6 text-muted">
        <p v-if="route.name === 'not-found'">此页面不存在。</p>
        <p v-else>{{ route.meta.title }}功能尚未接入。</p>
        <navigation-button
            class="inline-flex items-center min-h-11 scova-link cursor-pointer keyboard-focus-wide"
            v-if="route.name === 'account'"
            to="/account/appearance"
        >
            外观设置
        </navigation-button>
        <navigation-button
            class="inline-flex items-center min-h-11 scova-link cursor-pointer keyboard-focus-wide"
            v-if="route.name === 'not-found'"
            to="/tasks"
            >返回任务</navigation-button
        >
    </div>
</template>

<script setup lang="ts">
import NavigationButton from '@/components/common/NavigationButton.vue';
import { useRoute } from 'vue-router';
import AppearanceSelector from '@/components/common/AppearanceSelector.vue';
import ReadingPreferences from '@/components/common/ReadingPreferences.vue';

const route = useRoute();
</script>
