<template>
    <n-config-provider
        :theme="theme"
        :theme-overrides="overrides"
        :locale="locale === 'en' ? enUS : locale === 'zh-CN' ? zhCN : undefined"
    >
        <div
            class="scova-theme"
            :style="variables"
            :class="{ 'scova-theme--dark': appearance.scheme === 'dark' }"
        >
            <n-notification-provider
                placement="top-right"
                :max="3"
                keep-alive-on-hover
                container-class="scova-notifications"
            >
                <slot />
            </n-notification-provider>
        </div>
    </n-config-provider>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { InterfaceLocale } from '@/utils/i18n';
import { darkTheme, enUS, zhCN, NConfigProvider, NNotificationProvider } from 'naive-ui';
import { useAppearanceStore } from '@/store/appearance';
import { useReadingStore } from '@/store/reading';
import { themeOverrides, themeVariables } from '@/utils/theme/tokens';

const appearance = useAppearanceStore();
const reading = useReadingStore();
defineProps<{ locale?: InterfaceLocale }>();
const theme = computed(() => (appearance.scheme === 'dark' ? darkTheme : null));
const overrides = computed(() => themeOverrides(appearance.accent, appearance.scheme));
const variables = computed(() => ({
    ...themeVariables(appearance.accent, appearance.scheme),
    ...reading.variables,
}));
</script>
