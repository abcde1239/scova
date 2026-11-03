<template>
    <router-link v-slot="{ href, navigate }" :to="to" custom>
        <n-button
            tag="a"
            v-bind="{ ...$attrs, href, 'aria-label': label }"
            class="navigation-button"
            quaternary
            type="primary"
            @click="navigate"
        >
            <app-icon v-if="icon" :name="icon" />
            <slot />
        </n-button>
    </router-link>
</template>

<script setup lang="ts">
import { NButton } from 'naive-ui';
import { RouterLink } from 'vue-router';
import type { RouteLocationRaw } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import type { IconName } from '@/components/common/icons';

defineOptions({ inheritAttrs: false });
defineProps<{ to: RouteLocationRaw; icon?: IconName; label?: string }>();
</script>

<style scoped>
.navigation-button {
    min-block-size: 2.75rem;
    height: auto;
    max-inline-size: 100%;
    padding: 0.5rem 0.875rem;
    font-size: 1rem;
    text-decoration: none;
}
.navigation-button :deep(.n-button__content) {
    gap: 0.5em;
    white-space: normal;
    overflow-wrap: anywhere;
    min-inline-size: 0;
}
</style>
