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
        <div
            class="info-content layout-stack break-anywhere text-[1rem] leading-[1.7] [&.info-content_p]:m-0 [&.info-content_dl]:m-0"
        >
            <slot />
        </div>
        <template #footer>
            <div class="info-actions action-group justify-end">
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
