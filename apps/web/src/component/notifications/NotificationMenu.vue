<template>
    <n-popover
        v-model:show="show"
        trigger="hover"
        :placement="placement"
        :delay="120"
        :duration="180"
        :show-arrow="false"
        :to="false"
    >
        <template #trigger>
            <button
                ref="trigger"
                class="notification-trigger notification-control"
                :class="{ selected: selected }"
                type="button"
                :aria-expanded="show"
                aria-haspopup="dialog"
                :aria-label="t('pages.notifications')"
                :title="compact ? t('pages.notifications') : undefined"
                @focus="show = true"
                @blur="leaveFocus"
                @click="show = true"
                @keydown.esc.stop="show = false"
            >
                <app-icon name="notifications" />
                <span v-if="!compact">{{ t('pages.notifications') }}</span>
            </button>
        </template>
        <div
            ref="panel"
            role="dialog"
            :aria-label="t('shell.notificationPreview')"
            @keydown.esc.stop="close"
            @focusout="leaveFocus"
        >
            <notification-preview v-if="show" @navigate="show = false" />
        </div>
    </n-popover>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { NPopover, type PopoverProps } from 'naive-ui';
import AppIcon from '@/component/common/AppIcon.vue';
import NotificationPreview from '@/component/notifications/NotificationPreview.vue';
withDefaults(
    defineProps<{ selected: boolean; placement?: PopoverProps['placement']; compact?: boolean }>(),
    { placement: 'bottom-end' },
);
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
const { t } = useI18n({ useScope: 'global' });
</script>
