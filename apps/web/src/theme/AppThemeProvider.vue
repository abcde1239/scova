<template>
    <n-config-provider :theme="theme" :theme-overrides="overrides">
        <div
            class="scova-theme"
            :style="variables"
            :class="{ 'scova-theme--dark': appearance.scheme === 'dark' }"
        >
            <slot />
        </div>
    </n-config-provider>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { darkTheme, NConfigProvider } from 'naive-ui';
import { useAppearanceStore } from '@/store/appearance';
import { themeOverrides, themeVariables } from '@/theme/tokens';
import '@/theme/theme.css';

const appearance = useAppearanceStore();
const theme = computed(() => (appearance.scheme === 'dark' ? darkTheme : null));
const overrides = computed(() => themeOverrides(appearance.accent, appearance.scheme));
const variables = computed(() => themeVariables(appearance.accent, appearance.scheme));
</script>
