<template>
    <div class="layout-grid gap-3 max-w-[36rem]">
        <app-select v-model="selection" :label="label" :options="options" :disabled="disabled" />
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AppSelect from '@/components/common/AppSelect.vue';
const props = withDefaults(
    defineProps<{ disabled?: boolean; inherit?: boolean; label?: string; inheritLabel?: string }>(),
    { label: '搜索方式', inheritLabel: '沿用任务搜索方式' },
);
const selection = defineModel<string>({ required: true });
const options = computed(() => [
    ...(props.inherit ? [{ value: '', label: props.inheritLabel }] : []),
    { value: 'auto', label: '沿用账号搜索配置' },
    { value: 'api', label: 'Search API／自定义搜索（沿用账号读取方式）' },
    { value: 'searxng', label: '内置 SearXNG＋网页读取工具' },
]);
</script>
