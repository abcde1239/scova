<template>
    <n-button
        :attr-type="attrType"
        :disabled="disabled"
        :quaternary="quaternary"
        :text="text"
        :type="type"
        v-bind="accessibility"
        :class="{
            'scova-action--disabled': disabled,
            'scova-action--busy': busy && !disabled,
            'scova-action--text': text,
        }"
        class="scova-action-button"
        @click="activate"
    >
        <span v-if="busy" class="action-spinner" aria-hidden="true" />
        <slot />
    </n-button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton } from 'naive-ui';
const props = withDefaults(
    defineProps<{
        disabled?: boolean;
        busy?: boolean;
        quaternary?: boolean;
        text?: boolean;
        type?: 'default' | 'primary';
        attrType?: 'button' | 'submit' | 'reset';
    }>(),
    {
        disabled: false,
        busy: false,
        quaternary: false,
        text: false,
        type: 'default',
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
/* Scoped UnoCSS keeps the long control/state combinations readable. */
.action-spinner {
    @apply inline-block [flex:0_0_1em] w-[1em] h-[1em] [border:0.125em_solid_currentColor]
        [border-inline-end-color:transparent] rounded-[50%] animate-action-spin;
}
@media (prefers-reduced-motion: reduce) {
    .action-spinner {
        @apply [animation:none];
    }
}
.scova-action-button {
    @apply min-w-11 min-h-11 h-auto max-w-full pt-2.5 pr-4 pb-2.5 pl-4 text-[1rem] leading-[1.5]
        whitespace-normal cursor-pointer;
}
.scova-action-button.scova-action--busy {
    @apply cursor-progress;
}
.scova-action-button[aria-busy='true'] :deep(.app-icon) {
    @apply hidden;
}
.scova-action-button.scova-action--text {
    @apply min-w-0 pt-1.5 pr-0 pb-1.5 pl-0;
}
.scova-action-button.scova-action--disabled {
    @apply cursor-not-allowed;
}
.scova-action-button :deep(*) {
    @apply cursor-inherit;
}
.scova-action-button :deep(.n-button__content) {
    @apply whitespace-normal break-anywhere gap-[0.5em];
}
.scova-action-button:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.1875rem];
}
</style>
