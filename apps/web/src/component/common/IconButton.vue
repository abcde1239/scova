<template>
    <button
        type="button"
        class="icon-button inline-flex items-center justify-center min-w-11 min-h-11 [border:0] rounded-1.5 bg-transparent text-inherit font-inherit cursor-pointer p-[0.5em] [&.icon-button:hover:enabled]:[background:color-mix(in_srgb,_currentColor_8%,_transparent)] focus-visible:([outline:0.125rem_solid_currentColor] [outline-offset:0.125rem]) disabled:cursor-not-allowed"
        :aria-label="label"
        :title="label"
        :disabled="disabled"
    >
        <app-icon :name="icon" />
    </button>
</template>

<script setup lang="ts">
import AppIcon from '@/component/common/AppIcon.vue';
import type { IconName } from '@/utils/icons';

defineProps<{ icon: IconName; label: string; disabled?: boolean }>();
</script>
