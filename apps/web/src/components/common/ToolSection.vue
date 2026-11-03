<template>
    <details class="tool-section">
        <summary>
            <span><app-icon :name="icon" />{{ label }}</span>
            <app-icon class="disclosure" name="expand" />
        </summary>
        <div class="tool-section-body"><slot /></div>
    </details>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue';
import type { IconName } from '@/components/common/icons';
defineProps<{ label: string; icon: IconName }>();
</script>

<style scoped>
.tool-section {
    min-inline-size: 0;
    border-block-start: 0.0625rem solid color-mix(in srgb, var(--scova-border) 30%, transparent);
}
summary,
summary span {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-inline-size: 0;
}
summary {
    min-block-size: 2.75rem;
    justify-content: space-between;
    padding-block: 0.5rem;
    cursor: pointer;
    list-style: none;
    font-weight: 500;
}
summary::-webkit-details-marker {
    display: none;
}
summary:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.125rem;
}
.disclosure {
    flex-shrink: 0;
}
.tool-section[open] > summary .disclosure {
    transform: rotate(180deg);
}
.tool-section-body {
    min-inline-size: 0;
    padding-block: 0.5rem 1rem;
}
</style>
