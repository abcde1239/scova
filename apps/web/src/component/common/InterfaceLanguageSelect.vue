<template>
    <app-select
        v-if="iconOnly"
        v-model="language"
        :label="t('shell.language')"
        :options="languageOptions"
        icon="language"
        compact
        icon-only
    />
    <select
        v-else
        class="min-h-11 max-w-full border-theme rounded-3 bg-surface text-default font-inherit px-2 keyboard-focus"
        :aria-label="t('shell.language')"
        :value="locale"
        @change="changeLanguage"
    >
        <option value="zh-CN" lang="zh-CN">简体中文</option>
        <option value="en" lang="en">English</option>
    </select>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { computed } from 'vue';
import AppSelect from '@/component/common/AppSelect.vue';
import { isInterfaceLocale, rememberInterfaceLocale } from '@/utils/i18n';

const { locale, t } = useI18n({ useScope: 'global' });
defineProps<{ iconOnly?: boolean }>();
const languageOptions = [
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en', label: 'English' },
];
const language = computed({ get: () => locale.value, set: setLanguage });
function setLanguage(value: string) {
    if (!isInterfaceLocale(value)) return;
    locale.value = value;
    rememberInterfaceLocale(value);
}
function changeLanguage(event: Event) {
    setLanguage((event.currentTarget as HTMLSelectElement).value);
}
</script>
