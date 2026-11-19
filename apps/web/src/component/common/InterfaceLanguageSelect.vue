<template>
    <select
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
import { isInterfaceLocale, rememberInterfaceLocale } from '@/utils/i18n';

const { locale, t } = useI18n({ useScope: 'global' });
function changeLanguage(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!isInterfaceLocale(value)) return;
    locale.value = value;
    rememberInterfaceLocale(value);
}
</script>
