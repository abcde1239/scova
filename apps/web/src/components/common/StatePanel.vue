<template>
    <section
        ref="panel"
        class="state-panel layout-stack [justify-items:start] max-w-full pt-6 pb-6 break-anywhere cursor-default [&.state-panel--empty]:(text-muted text-[0.9375rem]) [&.state-panel--loading]:(grid-cols-[auto_minmax(0,_1fr)] items-center [justify-items:start] text-start) [&.state-panel--centered]:(grid-cols-[minmax(0,_1fr)] [justify-items:center] text-center) [&.state-panel--loading_>_.scova-action-button]:col-span-full"
        :class="{
            'state-panel--empty': state === 'empty',
            'state-panel--loading': state === 'loading',
            'state-panel--centered': centered,
        }"
        :aria-busy="state === 'loading' ? 'true' : undefined"
    >
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
                >{{ labels[state] }}<span v-if="message">：{{ message }}</span></template
            >
        </p>
        <action-button
            v-if="retryable && (state === 'error' || state === 'loading')"
            :busy="state === 'loading'"
            @click="retry"
        >
            <app-icon name="retry" />{{ state === 'loading' ? '正在重试' : '重试' }}
        </action-button>
    </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
const props = defineProps<{
    state: 'loading' | 'empty' | 'error' | 'success';
    message?: string;
    retryable?: boolean;
    centered?: boolean;
}>();
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
