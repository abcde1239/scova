<template>
    <div
        class="execution-agent-select layout-grid gap-3 max-w-[36rem] [&.execution-agent-select_>_.scova-action-button]:justify-self-start"
    >
        <app-select
            v-model="selection"
            label="执行 Agent 配置"
            :options="options"
            :disabled="disabled"
        />
        <p class="text-muted break-anywhere m-0" v-if="query.isPending.value" role="status">
            正在读取执行 Agent 配置…
        </p>
        <template v-else-if="query.isError.value">
            <p class="text-muted break-anywhere m-0" role="status">
                执行 Agent 配置读取失败，已保存的选择保持不变。
            </p>
            <action-button :busy="query.isFetching.value" @click="query.refetch()"
                >重试读取配置</action-button
            >
        </template>
        <div v-else-if="missingModel" class="layout-grid gap-2" role="note">
            <p class="scova-partial break-anywhere m-0">
                当前账号和部署都没有可用的研究模型，立即执行会失败。可以先保存任务，配置模型后再执行。
            </p>
            <p v-if="!query.data.value?.data.storageReady" class="text-muted break-anywhere m-0">
                此部署尚未启用密钥加密，暂时无法添加个人模型，请联系部署管理员启用或配置部署默认模型。
            </p>
            <router-link class="navigation-link" :to="{ name: 'agent-settings' }"
                >前往 Agent 配置<app-icon name="chevron"
            /></router-link>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AppSelect from '@/component/common/AppSelect.vue';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import { listProvidersEndpoint } from '@/api/agent-providers';
import { useSessionQuery } from '@/composable/useSessionQuery';
const props = defineProps<{ disabled?: boolean; inherit?: boolean }>();
const selection = defineModel<string>({ required: true });
const query = useSessionQuery(listProvidersEndpoint, {}, ['agent-providers']);
// Explain before starting. Saving the task stays available; the server still decides at run time.
const missingModel = computed(() => {
    const data = query.data.value?.data;
    if (!data || data.systemConfigured) return false;
    return !data.items.some((item) => item.active || item.id === selection.value);
});
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
