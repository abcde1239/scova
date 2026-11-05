<template>
    <action-button text type="primary" @click="show = true"
        ><app-icon name="help" />{{ label }}</action-button
    >
    <n-modal
        v-model:show="show"
        to=".scova-theme"
        preset="card"
        :title="title"
        v-bind="{ 'aria-label': title }"
        class="scova-info-dialog"
        :style="{
            width: `min(${wide ? '52rem' : '36rem'}, calc(100vw - 2rem))`,
            maxHeight: 'calc(100dvh - 2rem)',
            overflow: 'auto',
        }"
        :bordered="false"
        :segmented="{ content: true }"
    >
        <div class="info-content"><slot /></div>
        <template #footer>
            <div class="info-actions">
                <action-button type="primary" @click="show = false">知道了</action-button>
            </div>
        </template>
    </n-modal>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { NModal } from 'naive-ui';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
defineProps<{ title: string; label: string; wide?: boolean }>();
const show = ref(false);
</script>

<style scoped>
.info-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.75rem;
}
.info-content {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
    font-size: 1rem;
    line-height: 1.7;
}
.info-content :deep(p),
.info-content :deep(dl) {
    margin: 0;
}
</style>
