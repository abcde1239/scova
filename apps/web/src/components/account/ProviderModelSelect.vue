<template>
    <div class="provider-models">
        <label :for="`${id}-model`">模型</label>
        <app-select
            :id="`${id}-model`"
            v-model="model"
            label="模型"
            searchable
            search-placeholder="搜索模型名称或 ID"
            placeholder="先获取模型列表，再选择模型"
            :options="options"
            :disabled="disabled || loading || !options.length"
            :invalid="!!error"
            :describedby="error ? `${id}-error` : `${id}-status`"
        />
        <p v-if="error" :id="`${id}-error`" class="field-error">{{ error }}</p>
        <div class="model-actions">
            <action-button
                quaternary
                type="primary"
                class="model-action model-action--load"
                :busy="loading"
                :disabled="disabled || !canLoad"
                @click="load"
            >
                <app-icon name="retry" />
                {{
                    loading
                        ? '正在读取模型列表'
                        : state === 'idle'
                          ? '获取模型列表'
                          : state === 'error'
                            ? '重试获取模型列表'
                            : '刷新模型列表'
                }}
            </action-button>
            <action-button
                quaternary
                class="model-action model-action--manual"
                :disabled="disabled || loading"
                v-bind="{ 'aria-expanded': manual }"
                @click="manual = !manual"
            >
                <app-icon name="edit" />
                {{ manual ? '收起手动输入' : '手动输入模型 ID' }}
            </action-button>
        </div>
        <state-panel v-if="loading" state="loading" message="正在读取供应商模型列表" />
        <p
            v-else
            :id="`${id}-status`"
            :role="state === 'error' ? 'alert' : 'status'"
            :class="state === 'error' ? 'field-error' : 'field-hint'"
        >
            {{ status }}
        </p>
        <task-config-field
            v-if="manual"
            v-model="model"
            label="模型 ID"
            :disabled="disabled"
            :error="error"
        />
        <p class="field-hint">列表由供应商返回，不代表所有模型都支持研究所需的结构化输出。</p>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue';
import type { AgentProvider, AgentModelCatalogInput } from '@scova/models';
import AppSelect from '@/components/common/AppSelect.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import { useProviderModels } from '@/composables/useProviderModels';

const props = defineProps<{
    provider?: AgentProvider;
    baseUrl: string;
    protocol: string;
    apiKey: string;
    error?: string;
    disabled?: boolean;
}>();
const model = defineModel<string>({ required: true });
const id = useId(),
    manual = ref(false);
const input = computed<AgentModelCatalogInput>(() => ({
    baseUrl: props.baseUrl.trim(),
    protocol: props.protocol as AgentProvider['protocol'],
    ...(props.apiKey.trim() ? { apiKey: props.apiKey.trim() } : {}),
    ...(props.provider ? { providerId: props.provider.id, revision: props.provider.revision } : {}),
}));
const savedKeyAllowed = computed(
    () =>
        !!props.provider &&
        props.baseUrl.trim().replace(/\/$/, '') === props.provider.baseUrl.replace(/\/$/, '') &&
        props.protocol === props.provider.protocol,
);
const canLoad = computed(
    () => !!props.baseUrl.trim() && (!!props.apiKey.trim() || savedKeyAllowed.value),
);
const { state, result, message, loading, load } = useProviderModels(input);
const listed = computed(() => result.value?.items.some((item) => item.id === model.value));
const options = computed(() => {
    const items = (result.value?.items ?? []).map((item) => ({
        value: item.id,
        label: item.name,
        description: item.name === item.id ? undefined : item.id,
    }));
    if (model.value && !listed.value)
        items.unshift({
            value: model.value,
            label: model.value,
            description: result.value ? '当前配置，列表中未返回' : '当前配置，尚未读取列表',
        });
    return items;
});
const status = computed(() => {
    if (state.value === 'error') return message.value;
    if (state.value === 'ready') {
        if (!result.value?.items.length) return '供应商未返回可选模型，可刷新列表或手动填写。';
        return `已读取 ${result.value.items.length} 个模型${result.value.truncated ? '（仅显示部分结果）' : ''}，请选择所需模型。`;
    }
    return canLoad.value
        ? '获取模型列表后，可搜索名称或 ID 进行选择。'
        : '请先填写 API 地址与密钥；更改地址或协议后需重新填写密钥。';
});
onMounted(() => {
    if (savedKeyAllowed.value) void load();
});
</script>

<style scoped>
.provider-models {
    display: grid;
    gap: 0.5rem;
    min-inline-size: 0;
}
label {
    font-weight: 500;
}
.model-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
}
.model-action {
    min-block-size: 2.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.625rem;
    font-size: 0.875rem;
    line-height: 1.5;
}
.model-action--load {
    background: color-mix(in srgb, var(--scova-primary) 8%, transparent);
}
.model-action--manual {
    color: var(--scova-muted);
    background: color-mix(in srgb, var(--scova-muted) 6%, transparent);
}
.model-action--load:hover:not([aria-disabled='true']) {
    background: color-mix(in srgb, var(--scova-primary) 14%, transparent);
}
.model-action--manual:hover:not([aria-disabled='true']) {
    color: var(--scova-text);
    background: color-mix(in srgb, var(--scova-muted) 12%, transparent);
}
.field-hint,
.field-error {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.65;
    overflow-wrap: anywhere;
}
.field-hint {
    color: var(--scova-muted);
}
.field-error {
    color: var(--scova-danger);
}
</style>
