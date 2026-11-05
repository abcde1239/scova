<template>
    <section
        ref="panel"
        class="state-panel"
        :class="{
            'state-panel--empty': state === 'empty',
            'state-panel--loading': state === 'loading',
        }"
        :aria-busy="state === 'loading' ? 'true' : undefined"
    >
        <img
            v-if="state === 'loading' && !imageFailed"
            :src="loadingImage"
            class="loading-animation"
            alt=""
            aria-hidden="true"
            decoding="async"
            @error="imageFailed = true"
        />
        <p ref="announcement" tabindex="-1" role="status" aria-live="polite" aria-atomic="true">
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

<style scoped>
.state-panel {
    display: grid;
    justify-items: start;
    gap: 1rem;
    min-inline-size: 0;
    max-inline-size: 100%;
    padding-block: 1.5rem;
    overflow-wrap: anywhere;
    cursor: default;
}
p {
    margin: 0;
    max-inline-size: 100%;
}
.state-panel--empty {
    color: var(--scova-muted);
    font-size: 0.9375rem;
}
.state-panel--loading {
    justify-items: center;
    text-align: center;
    padding-block: 2rem;
}
.loading-animation {
    display: block;
    inline-size: min(10rem, 100%);
    block-size: auto;
    object-fit: contain;
}
@media (prefers-reduced-motion: reduce) {
    .loading-animation {
        display: none;
    }
}
p:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
