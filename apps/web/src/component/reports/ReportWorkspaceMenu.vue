<template>
    <n-popover
        v-model:show="open"
        trigger="click"
        display-directive="show"
        :placement="placement"
        :show-arrow="false"
        :to="false"
        :style="{ padding: '0.35rem' }"
    >
        <template #trigger>
            <button
                ref="trigger"
                type="button"
                class="workspace-menu-trigger"
                :aria-label="label"
                :aria-expanded="open"
                :title="label"
                :disabled="disabled"
                @keydown.esc="escape"
            >
                <app-icon v-if="icon" :name="icon" />
                <span v-if="text" class="workspace-menu-text">{{ text }}</span>
                <app-icon v-if="text" name="expand" />
            </button>
        </template>
        <div class="workspace-menu-content scova-interface" :inert="!open" @keydown.esc="escape">
            <slot :close="close" />
        </div>
    </n-popover>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { NPopover } from 'naive-ui';
import AppIcon from '@/component/common/AppIcon.vue';
import type { IconName } from '@/utils/icons';
const props = withDefaults(
    defineProps<{
        label: string;
        icon?: IconName;
        text?: string;
        disabled?: boolean;
        placement?: 'top-start' | 'top-end' | 'bottom-end';
    }>(),
    { placement: 'top-end' },
);
const trigger = ref<HTMLButtonElement>();
const open = ref(false);
function close() {
    open.value = false;
    trigger.value?.focus({ preventScroll: true });
}
function escape(event: KeyboardEvent) {
    if (!open.value || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
}
watch(
    () => props.disabled,
    (disabled) => {
        if (disabled) open.value = false;
    },
);
defineExpose({ focus: () => trigger.value?.focus({ preventScroll: true }) });
</script>

<style scoped>
.workspace-menu-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    min-inline-size: 2.25rem;
    min-block-size: 2.25rem;
    max-inline-size: 100%;
    padding: 0.25rem 0.45rem;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--scova-muted);
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
    transition:
        background-color 140ms ease,
        color 140ms ease,
        scale 140ms ease;
}
.workspace-menu-trigger:disabled {
    cursor: not-allowed;
    opacity: 0.55;
}
.workspace-menu-trigger:not(:disabled):is(:hover, [aria-expanded='true']) {
    background: var(--scova-selected);
    color: var(--scova-text);
}
.workspace-menu-trigger:not(:disabled):active {
    scale: 0.96;
}
.workspace-menu-trigger:focus-visible,
.workspace-menu-content :deep(.workspace-menu-item:focus-visible) {
    outline: 1px solid currentColor;
    outline-offset: -1px;
}
.workspace-menu-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.workspace-menu-content {
    display: grid;
    gap: 0.125rem;
    min-inline-size: min(10rem, 78vw);
    max-inline-size: min(20rem, 82vw);
    max-block-size: min(18rem, 46dvh);
    overflow: auto;
    overscroll-behavior: contain;
}
.workspace-menu-content :deep(.workspace-menu-item) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-block-size: 2.25rem;
    padding: 0.375rem 0.625rem;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--scova-text);
    font: inherit;
    text-align: start;
    text-decoration: none;
    overflow-wrap: anywhere;
    cursor: pointer;
}
.workspace-menu-content :deep(.workspace-menu-item:not(:disabled):hover) {
    background: var(--scova-selected);
}
.workspace-menu-content :deep(.workspace-menu-item:disabled) {
    color: var(--scova-muted);
    cursor: default;
}
@media (pointer: coarse) {
    .workspace-menu-trigger,
    .workspace-menu-content :deep(.workspace-menu-item) {
        min-block-size: 2.75rem;
    }
    .workspace-menu-trigger {
        min-inline-size: 2.75rem;
    }
}
@media (prefers-reduced-motion: reduce) {
    .workspace-menu-trigger {
        transition: none;
        scale: none;
    }
}
</style>
