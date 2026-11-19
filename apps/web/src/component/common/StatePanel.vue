<template>
    <section
        ref="panel"
        class="state-panel layout-stack [justify-items:start] max-w-full pt-6 pb-6 break-anywhere cursor-default [&.state-panel--empty]:(text-muted text-[0.9375rem] [justify-items:center] text-center gap-3 rounded-3 [background:color-mix(in_srgb,_var(--scova-border)_7%,_transparent)] py-10 px-6) [&.state-panel--loading]:(grid-cols-[auto_minmax(0,_1fr)] items-center [justify-items:start] text-start) [&.state-panel--centered]:(grid-cols-[minmax(0,_1fr)] [justify-items:center] text-center) [&.state-panel--loading_>_.scova-action-button]:col-span-full [&.state-panel--alert]:(grid-cols-[auto_minmax(0,_1fr)] items-start gap-[0.75rem_0.75rem] rounded-3 [background:color-mix(in_srgb,_var(--scova-danger)_8%,_transparent)] [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-danger)_24%,_transparent)] py-4 px-4 mt-6) [&.state-panel--alert_>_.scova-action-button]:(col-start-2 justify-self-start)"
        :class="{
            'state-panel--empty': state === 'empty',
            'state-panel--loading': state === 'loading' && !centered,
            'state-panel--centered': centered,
            'state-panel--alert': alert && state === 'error',
        }"
        :aria-busy="state === 'loading' ? 'true' : undefined"
    >
        <span
            v-if="state === 'empty' && icon"
            class="state-panel-icon inline-flex text-[1.5rem] opacity-60"
            aria-hidden="true"
            ><app-icon :name="icon"
        /></span>
        <app-icon
            v-if="alert && state === 'error'"
            class="text-danger [font-size:1.25rem] mt-0.5"
            name="warning"
        />
        <img
            v-if="state === 'loading' && !imageFailed"
            :src="loadingImage"
            class="loading-animation block w-12 h-auto [object-fit:contain] [@media(prefers-reduced-motion:_reduce)]:hidden"
            alt=""
            aria-hidden="true"
            decoding="async"
            @error="imageFailed = true"
        />
        <p
            class="max-w-full m-0 keyboard-focus-wide"
            ref="announcement"
            tabindex="-1"
            role="status"
            aria-live="polite"
            aria-atomic="true"
        >
            <template v-if="state === 'loading'">{{ message || labels.loading }}</template>
            <template v-else-if="state === 'empty'">{{ message || labels.empty }}</template>
            <template v-else
                ><template v-if="state === 'error' && hideErrorPrefix && message">{{
                    message
                }}</template>
                <template v-else
                    >{{ labels[state] }}<span v-if="message">：{{ message }}</span></template
                ></template
            >
        </p>
        <div v-if="state === 'empty' && $slots.action" class="state-panel-action">
            <slot name="action" />
        </div>
        <action-button
            v-if="retryable && (state === 'error' || state === 'loading')"
            :busy="state === 'loading'"
            :type="alert ? 'primary' : 'default'"
            @click="retry"
        >
            <app-icon name="retry" />{{ retryLabel ?? (state === 'loading' ? '正在重试' : '重试') }}
        </action-button>
    </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import type { IconName } from '@/utils/icons';
const props = defineProps<{
    state: 'loading' | 'empty' | 'error' | 'success';
    message?: string;
    retryable?: boolean;
    retryLabel?: string;
    hideErrorPrefix?: boolean;
    centered?: boolean;
    icon?: IconName;
    alert?: boolean;
}>();
defineSlots<{ action?(): unknown }>();
const emit = defineEmits<{ retry: [] }>();
const labels = { loading: '正在加载', empty: '暂无内容', error: '加载失败', success: '加载成功' };
const loadingImage = `${import.meta.env.BASE_URL}img/loading.gif`;
const imageFailed = ref(false);
const announcement = ref<HTMLParagraphElement>();
const panel = ref<HTMLElement>();
let focusAfterRetry = false;
function retry() {
    if (props.state === 'loading') return;
    focusAfterRetry = true;
    emit('retry');
}
watch(
    () => props.state,
    async (state) => {
        if (state === 'success' && focusAfterRetry) {
            const moveFocus = panel.value?.contains(document.activeElement);
            await nextTick();
            if (moveFocus && document.activeElement === document.body) announcement.value?.focus();
            focusAfterRetry = false;
        }
    },
);
</script>
