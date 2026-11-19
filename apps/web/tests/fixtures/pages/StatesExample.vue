<template>
    <section class="states-example" aria-label="本地交互样例">
        <p>受控本地样例，未连接服务器。</p>
        <state-panel :state="state" :message="message" retryable @retry="retry" />
        <p role="status">派发次数：{{ retries }}</p>
        <div class="examples-actions">
            <action-button @click="activations++"
                ><app-icon name="confirm" />正常操作</action-button
            >
            <action-button disabled @click="activations++"
                ><app-icon name="confirm" />禁用操作</action-button
            >
            <action-button busy @click="activations++"
                ><app-icon name="confirm" />忙碌操作</action-button
            >
            <action-button disabled busy @click="activations++">禁用且忙碌</action-button>
        </div>
        <p role="status">正常次数：{{ activations }}</p>
        <div class="example-fields">
            <label>文字<input aria-label="文字" value="可编辑" /></label>
            <label>只读文字<input aria-label="只读文字" value="可选择" readonly /></label>
            <label>日期<input aria-label="日期" type="date" /></label>
            <label>时间<input aria-label="时间" type="time" /></label>
        </div>
        <p class="ordinary">普通内容可阅读。</p>
        <state-panel state="empty" />
    </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { useCommand } from '@/composable/useCommand';
const state = ref<'error' | 'loading' | 'success'>('error');
const message = computed(() =>
    state.value === 'error'
        ? '本地失败样例。很长的来源地址https://example.invalid/long-path-without-a-server-response应换行并保留重试操作。'
        : undefined,
);
const retries = ref(0);
const activations = ref(0);
const command = useCommand();
function retry() {
    void command.run(async () => {
        retries.value++;
        state.value = 'loading';
        await new Promise<void>((resolve) => setTimeout(resolve, 800));
        state.value = 'success';
    });
}
</script>

<style scoped>
.states-example {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
    cursor: default;
}
.examples-actions,
.example-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    min-inline-size: 0;
}
label {
    display: grid;
    gap: 0.5rem;
    max-inline-size: 100%;
    min-inline-size: 0;
}
input {
    box-sizing: border-box;
    inline-size: 100%;
    max-inline-size: 18rem;
    min-inline-size: 0;
    min-block-size: 2.75rem;
    padding: 0.5rem;
    color: var(--scova-text);
    background: var(--scova-surface);
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.375rem;
    font: inherit;
    cursor: text;
}
input[type='date'],
input[type='time'] {
    cursor: auto;
}
input:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.1875rem;
}
</style>
