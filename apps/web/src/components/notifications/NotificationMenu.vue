<template>
    <n-popover
        v-model:show="show"
        trigger="hover"
        placement="bottom-end"
        :delay="120"
        :duration="180"
        :show-arrow="false"
        :to="false"
    >
        <template #trigger>
            <button
                ref="trigger"
                class="notification-trigger"
                :class="{ selected: selected }"
                type="button"
                :aria-expanded="show"
                aria-haspopup="dialog"
                aria-label="通知"
                @focus="show = true"
                @blur="leaveFocus"
                @click="show = true"
                @keydown.esc.stop="show = false"
            >
                <app-icon name="notifications" />通知
            </button>
        </template>
        <div
            ref="panel"
            role="dialog"
            aria-label="通知预览"
            @keydown.esc.stop="close"
            @focusout="leaveFocus"
        >
            <notification-preview v-if="show" @navigate="show = false" />
        </div>
    </n-popover>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { NPopover } from 'naive-ui';
import AppIcon from '@/components/common/AppIcon.vue';
import NotificationPreview from '@/components/notifications/NotificationPreview.vue';
defineProps<{ selected: boolean }>();
const route = useRoute();
const show = ref(false);
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
function leaveFocus(event: FocusEvent) {
    const next = event.relatedTarget;
    // Replacing a retry button with its result can blur to the body; keep that result open.
    if (!next) return;
    if (next instanceof Node && (next === trigger.value || panel.value?.contains(next))) return;
    show.value = false;
}
function close() {
    trigger.value?.focus();
    show.value = false;
}
watch(
    () => route.fullPath,
    () => {
        show.value = false;
    },
);
</script>

<style scoped>
.notification-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    min-block-size: 2.75rem;
    padding: 0.5rem 0.875rem;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
}
.notification-trigger:hover,
.selected {
    background: var(--scova-selected);
    color: var(--scova-primary);
}
.selected {
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 0.35em;
}
.notification-trigger:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
