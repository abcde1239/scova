<template>
    <section ref="panel" class="state-panel" :aria-busy="state === 'loading' ? 'true' : undefined">
        <p ref="announcement" tabindex="-1" role="status" aria-live="polite" aria-atomic="true">
            {{ labels[state] }}<span v-if="message">：{{ message }}</span>
        </p>
        <action-button
            v-if="retryable && state !== 'success'"
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
p:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
