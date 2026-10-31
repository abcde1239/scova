<template>
    <button
        type="button"
        class="icon-button"
        :aria-label="label"
        :title="label"
        :disabled="disabled"
    >
        <app-icon :name="icon" />
    </button>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue';
import type { IconName } from '@/components/common/icons';

defineProps<{ icon: IconName; label: string; disabled?: boolean }>();
</script>

<style scoped>
.icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-inline-size: 2.75rem;
    min-block-size: 2.75rem;
    padding: 0.5em;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
}

.icon-button:hover:enabled {
    background: color-mix(in srgb, currentColor 8%, transparent);
}

.icon-button:focus-visible {
    outline: 0.125rem solid currentColor;
    outline-offset: 0.125rem;
}

.icon-button:disabled {
    cursor: not-allowed;
}
</style>
