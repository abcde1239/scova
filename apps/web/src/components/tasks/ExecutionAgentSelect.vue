<template>
    <div class="execution-agent-select">
        <app-select
            v-model="selection"
            label="执行 Agent 配置"
            :options="options"
            :disabled="disabled"
        />
        <p v-if="query.isPending.value" role="status">正在读取执行 Agent 配置…</p>
        <template v-else-if="query.isError.value">
            <p role="status">执行 Agent 配置读取失败，已保存的选择保持不变。</p>
            <action-button :busy="query.isFetching.value" @click="query.refetch()"
                >重试读取配置</action-button
            >
        </template>
        <p v-else-if="query.data.value && !query.data.value.data.items.length">
            尚未添加个人配置，可前往账号设置添加。
        </p>
        <p v-else>{{ hint || '此选择用于该任务的手动和计划执行，不改变账号默认配置。' }}</p>
        <router-link class="scova-reference" :to="{ name: 'agent-settings' }"
            >管理 Agent 配置</router-link
        >
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import AppSelect from '@/components/common/AppSelect.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import { listProvidersEndpoint } from '@/api/agent-providers';
import { useSessionQuery } from '@/composables/useSessionQuery';
const props = defineProps<{ disabled?: boolean; inherit?: boolean; hint?: string }>();
const selection = defineModel<string>({ required: true });
const query = useSessionQuery(listProvidersEndpoint, {}, ['agent-providers']);
const options = computed(() => {
    const items = query.isError.value ? [] : (query.data.value?.data.items ?? []);
    const active = items.find((item) => item.active);
    const defaults = {
        value: props.inherit ? '__default' : '',
        label: '账号默认配置',
        description: active
            ? `${active.name} · ${active.model}`
            : '使用账号默认研究模型；未设置时使用部署默认',
    };
    const values = [
        ...(props.inherit ? [{ value: '', label: '沿用任务执行配置' }] : []),
        defaults,
        ...items.map((item) => ({ value: item.id, label: item.name, description: item.model })),
    ];
    if (selection.value && !values.some((item) => item.value === selection.value))
        values.push({
            value: selection.value,
            label: '已指定的配置',
            description: '配置暂不可读取，请刷新或重新选择',
        });
    return values;
});
</script>

<style scoped>
.execution-agent-select {
    display: grid;
    gap: 0.75rem;
    min-inline-size: 0;
    max-inline-size: 36rem;
}
p {
    margin: 0;
    color: var(--scova-muted);
    overflow-wrap: anywhere;
}
.execution-agent-select > :deep(.scova-action-button) {
    justify-self: start;
}
</style>
