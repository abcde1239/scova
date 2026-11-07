<template>
    <div class="provider-balance" :aria-busy="query.isFetching.value">
        <div class="balance-controls">
            <app-select
                :model-value="template"
                compact
                label="额度查询方式"
                :options="templates"
                :disabled="disabled || query.isFetching.value"
                @update:model-value="selectTemplate"
            />
            <action-button
                quaternary
                :busy="query.isFetching.value"
                :disabled="disabled"
                @click="refresh"
            >
                <app-icon name="retry" />{{
                    query.isFetching.value
                        ? '正在查询额度'
                        : query.data.value
                          ? '刷新额度'
                          : '查询额度'
                }}
            </action-button>
        </div>
        <p v-if="!queried" class="balance-hint">按需读取供应商余额；中转站请选择对应方式。</p>
        <p v-else-if="query.isFetching.value" role="status">正在读取供应商额度…</p>
        <p v-if="query.isError.value" role="status" class="balance-error">{{ errorMessage }}</p>
        <template v-if="query.data.value">
            <ul class="balance-values" aria-label="供应商额度">
                <li
                    v-for="(item, index) in query.data.value.data.items"
                    :key="index"
                    :class="{ depleted: item.remaining !== undefined && item.remaining <= 0 }"
                >
                    <strong>{{ item.label }}：</strong>
                    <span v-if="item.unlimited">Key 未设限额</span>
                    <span v-else-if="item.remaining !== undefined"
                        >剩余 {{ number(item.remaining) }} {{ item.unit }}</span
                    >
                    <span v-if="item.used !== undefined"
                        >已用 {{ number(item.used) }} {{ item.unit }}</span
                    >
                    <span v-if="item.total !== undefined"
                        >总额 {{ number(item.total) }} {{ item.unit }}</span
                    >
                </li>
            </ul>
            <p class="balance-hint">
                {{ query.isError.value ? '上次成功查询' : '查询时间' }}：<time
                    :datetime="query.data.value.data.checkedAt"
                    >{{ checkedAt }}</time
                >。Key 限额不代表账号余额；查询结果不保证后续执行可用。
            </p>
        </template>
        <p v-if="template === 'new_api'" class="balance-hint">
            New API 返回原始额度点，站点换算规则可能不同；Key 未设限额仍受账号余额约束。
        </p>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { AgentProvider, AgentProviderBalanceInput } from '@scova/models';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { providerBalanceEndpoint } from '@/api/agent-providers';
import { toApiError } from '@/api/errors';
import AppSelect from '@/components/common/AppSelect.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';

const props = defineProps<{ provider: AgentProvider; disabled?: boolean }>();
const lifecycle = useSessionLifecycle();
const template = ref<NonNullable<AgentProviderBalanceInput['template']>>('auto');
function selectTemplate(value: string) {
    if (value === 'auto' || value === 'new_api' || value === 'sub2api') template.value = value;
}
const queried = ref(false);
const templates = [
    {
        value: 'auto',
        label: '自动识别官方余额',
        description: 'DeepSeek / OpenRouter / SiliconFlow',
    },
    { value: 'new_api', label: 'New API · Key 额度' },
    { value: 'sub2api', label: 'Sub2API · 额度查询' },
];
const query = useQuery(
    computed(() => {
        const scope = lifecycle.capture();
        const input = {
            params: { id: props.provider.id },
            body: { revision: props.provider.revision, template: template.value },
        };
        return {
            queryKey: scope.queryKey(['provider-balance', input]),
            enabled: false,
            retry: false,
            staleTime: 0,
            queryFn: ({ signal }: { signal: AbortSignal }) =>
                scope.request(providerBalanceEndpoint, input, { signal, timeout: 15_000 }),
        };
    }),
    lifecycle.queryClient,
);
watch(
    () => [props.provider.id, props.provider.revision, template.value, lifecycle.session.epoch],
    () => {
        queried.value = false;
    },
    { flush: 'sync' },
);
const errorMessage = computed(() => {
    const error = toApiError(query.error.value);
    return error.code.startsWith('PROVIDER_') || error.code === 'CREDENTIAL_STORAGE_UNAVAILABLE'
        ? error.message
        : '暂时无法读取供应商额度，请重试';
});
const number = (value: number) =>
    new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value);
const checkedAt = computed(() =>
    query.data.value
        ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(
              new Date(query.data.value.data.checkedAt),
          )
        : '',
);
function refresh() {
    if (props.disabled || query.isFetching.value || !lifecycle.session.user) return;
    queried.value = true;
    void query.refetch();
}
</script>

<style scoped>
.provider-balance {
    display: grid;
    gap: 0.5rem;
    min-inline-size: 0;
    margin-block-start: 0.85rem;
    font-size: 0.875rem;
}
.balance-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    min-inline-size: 0;
}
.balance-controls > :first-child {
    flex: 0 1 18rem;
    min-inline-size: 0;
    max-inline-size: 100%;
}
p {
    margin: 0;
    overflow-wrap: anywhere;
}
.balance-hint {
    color: var(--scova-muted);
}
.balance-error,
.depleted {
    color: var(--scova-danger);
}
.balance-values {
    display: grid;
    gap: 0.35rem;
    list-style: none;
    margin: 0;
    padding: 0;
}
.balance-values li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.65rem;
    overflow-wrap: anywhere;
}
</style>
