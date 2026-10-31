<template>
    <n-button
        :attr-type="attrType"
        :disabled="disabled"
        v-bind="accessibility"
        :class="{ 'scova-action--disabled': disabled, 'scova-action--busy': busy && !disabled }"
        class="scova-action-button"
        @click="activate"
    >
        <slot />
    </n-button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton } from 'naive-ui';
const props = withDefaults(
    defineProps<{ disabled?: boolean; busy?: boolean; attrType?: 'button' | 'submit' | 'reset' }>(),
    {
        disabled: false,
        busy: false,
        attrType: 'button',
    },
);
const emit = defineEmits<{ click: [event: MouseEvent] }>();
const accessibility = computed(() => ({
    'aria-disabled': props.disabled || props.busy ? 'true' : undefined,
    'aria-busy': props.busy ? 'true' : undefined,
}));
function activate(event: MouseEvent) {
    if (props.disabled || props.busy) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    emit('click', event);
}
</script>

<style scoped>
.scova-action-button {
    min-inline-size: 2.75rem;
    min-block-size: 2.75rem;
    block-size: auto;
    max-inline-size: 100%;
    padding: 0.625rem 1rem;
    font-size: 1rem;
    line-height: 1.5;
    white-space: normal;
    cursor: pointer;
}
.scova-action-button.scova-action--busy {
    cursor: progress;
}
.scova-action-button.scova-action--disabled {
    cursor: not-allowed;
}
.scova-action-button :deep(*) {
    cursor: inherit;
}
.scova-action-button :deep(.n-button__content) {
    white-space: normal;
    overflow-wrap: anywhere;
    gap: 0.5em;
}
.scova-action-button:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
</style>
