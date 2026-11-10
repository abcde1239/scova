<template>
    <form ref="form" class="provider-form" novalidate @submit.prevent="save">
        <div class="form-heading">
            <h2>{{ provider ? '编辑供应商' : '添加供应商' }}</h2>
            <button
                type="button"
                class="close-form"
                aria-label="关闭供应商编辑"
                :disabled="pending"
                @click="requestClose"
            >
                <app-icon name="close" />
            </button>
        </div>
        <label :for="`${id}-preset`">快速填写</label>
        <app-select
            :id="`${id}-preset`"
            v-model="preset"
            label="快速填写"
            :options="presets"
            :disabled="pending"
        />
        <p class="field-hint">选择预设会填写地址与协议，并清空模型和未保存的密钥。</p>
        <task-config-field
            v-model="draft.name"
            label="配置名称"
            :error="errors.name"
            :disabled="pending"
        />
        <task-config-field
            v-model="draft.protocol"
            label="接口协议"
            kind="select"
            :options="protocols"
            :error="errors.protocol"
            :disabled="pending"
        />
        <task-config-field
            v-model="draft.baseUrl"
            label="API 地址"
            :error="errors.baseUrl"
            :disabled="pending"
        />
        <p class="field-hint">填写 HTTPS API 根地址（包含版本路径），无需填写具体请求接口。</p>
        <div class="secret-field">
            <label :for="`${id}-key`">API Key{{ provider ? '（留空保留）' : '' }}</label>
            <n-input
                v-model:value="draft.apiKey"
                type="password"
                show-password-on="click"
                :disabled="pending"
                :input-props="{
                    id: `${id}-key`,
                    autocomplete: 'new-password',
                    'aria-invalid': errors.apiKey ? 'true' : undefined,
                    'aria-describedby': errors.apiKey ? `${id}-key-error` : `${id}-secret-hint`,
                }"
            />
            <p v-if="errors.apiKey" :id="`${id}-key-error`" class="field-error">
                {{ errors.apiKey }}
            </p>
            <p :id="`${id}-secret-hint`" class="field-hint">密钥加密保存在服务端，保存后不回显。</p>
        </div>
        <provider-model-select
            v-model="draft.model"
            :provider="provider"
            :base-url="draft.baseUrl"
            :protocol="draft.protocol"
            :api-key="draft.apiKey"
            :error="errors.model"
            :disabled="pending"
        />
        <p v-if="message" class="field-error" role="alert" tabindex="-1">{{ message }}</p>
        <task-config-field
            v-model="draft.webSearch"
            label="研究内置搜索"
            kind="select"
            :options="searchOptions"
            :error="errors.webSearch"
            :disabled="pending"
        />
        <p class="field-hint">
            仅为研究搜索授权。请确认所选模型和地址支持该搜索接口；调用计入搜索与 Token
            额度，并可能产生额外费用。关闭时使用部署的搜索服务。
        </p>
        <div class="form-actions">
            <action-button attr-type="submit" :busy="pending" :disabled="uncertain"
                >保存配置</action-button
            >
            <action-button :disabled="pending" quaternary @click="requestClose">取消</action-button>
        </div>
        <p class="field-hint">
            保存不会发起模型调用；{{
                provider?.active ? '修改对后续调用生效。' : '保存后可在列表中设为当前使用。'
            }}
        </p>
    </form>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, useId, watch } from 'vue';
import { NInput } from 'naive-ui';
import {
    AgentProviderInputSchema,
    AgentProviderUpdateSchema,
    parseContract,
    type AgentProvider,
} from '@scova/models';
import TaskConfigField from '@/components/tasks/TaskConfigField.vue';
import ProviderModelSelect from '@/components/account/ProviderModelSelect.vue';
import AppSelect from '@/components/common/AppSelect.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { createProviderEndpoint, updateProviderEndpoint } from '@/api/agent-providers';
import { toApiError } from '@/api/errors';
import { useActionNotification } from '@/composables/useActionNotification';
const notice = useActionNotification();
const props = defineProps<{ provider?: AgentProvider }>();
const emit = defineEmits<{ saved: []; close: [] }>();
const id = useId(),
    scope = useSessionLifecycle().capture();
const form = ref<HTMLFormElement>(),
    pending = ref(false),
    uncertain = ref(false),
    message = ref('');
const errors = ref<Record<string, string>>({});
const draft = reactive({
    name: props.provider?.name ?? '',
    baseUrl: props.provider?.baseUrl ?? 'https://api.openai.com/v1',
    model: props.provider?.model ?? '',
    protocol: String(props.provider?.protocol ?? 'openai_chat_completions'),
    webSearch: String(props.provider?.webSearch ?? 'disabled'),
    apiKey: '',
});
const initial = JSON.stringify(draft);
const dirty = computed(() => JSON.stringify(draft) !== initial);
function canLeave() {
    return !pending.value && (!dirty.value || window.confirm('配置尚未保存，确定放弃修改？'));
}
function requestClose() {
    if (canLeave()) emit('close');
}
function beforeUnload(event: BeforeUnloadEvent) {
    if (!dirty.value && !pending.value) return;
    event.preventDefault();
    event.returnValue = '';
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
defineExpose({ canLeave });
const presets = [
    { value: 'custom', label: '自定义' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'deepseek', label: 'DeepSeek（OpenAI 兼容）' },
    { value: 'openrouter', label: 'OpenRouter（OpenAI 兼容）' },
];
const protocols = [
    { value: 'openai_chat_completions', label: 'OpenAI 兼容 · JSON Schema' },
    { value: 'openai_json', label: 'OpenAI 兼容 · JSON 模式' },
    { value: 'anthropic_messages', label: 'Anthropic Messages' },
    { value: 'gemini', label: 'Gemini generateContent' },
];
const preset = ref('custom');
const searchOptions = computed(() => [
    { value: 'disabled', label: '关闭内置搜索' },
    ...(['openai_chat_completions', 'openai_json'].includes(draft.protocol)
        ? [{ value: 'openai_responses', label: '允许 OpenAI Responses Web Search' }]
        : draft.protocol === 'anthropic_messages'
          ? [{ value: 'anthropic_web_search', label: '允许 Anthropic Web Search' }]
          : []),
]);
watch(
    () => draft.protocol,
    () => {
        draft.webSearch = 'disabled';
    },
);
watch(preset, (value) => {
    const config = {
        openai: ['OpenAI', 'https://api.openai.com/v1', 'openai_chat_completions'],
        anthropic: ['Anthropic', 'https://api.anthropic.com/v1', 'anthropic_messages'],
        gemini: ['Google Gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini'],
        deepseek: ['DeepSeek', 'https://api.deepseek.com/v1', 'openai_json'],
        openrouter: ['OpenRouter', 'https://openrouter.ai/api/v1', 'openai_chat_completions'],
    }[value];
    if (config) {
        draft.name = config[0]!;
        draft.baseUrl = config[1]!;
        draft.protocol = config[2] as AgentProvider['protocol'];
        draft.model = '';
        draft.apiKey = '';
        draft.webSearch = 'disabled';
    }
});
async function save() {
    if (pending.value || uncertain.value) return;
    errors.value = {};
    message.value = '';
    pending.value = true;
    let dispatched = false;
    try {
        if (props.provider) {
            const body = parseContract(AgentProviderUpdateSchema, {
                name: draft.name.trim(),
                model: draft.model.trim(),
                baseUrl: draft.baseUrl.trim(),
                protocol: draft.protocol,
                webSearch: draft.webSearch,
                ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
                revision: props.provider.revision,
            });
            dispatched = true;
            await scope.request(updateProviderEndpoint, {
                params: { id: props.provider.id },
                body,
            });
        } else {
            const body = parseContract(AgentProviderInputSchema, {
                ...draft,
                name: draft.name.trim(),
                model: draft.model.trim(),
                baseUrl: draft.baseUrl.trim(),
                apiKey: draft.apiKey.trim(),
            });
            dispatched = true;
            await scope.request(createProviderEndpoint, { body });
        }
        draft.apiKey = '';
        if (!scope.isCurrent()) return;
        emit('saved');
    } catch (cause) {
        const error = toApiError(cause);
        if (error.kind === 'cancelled' || !scope.isCurrent()) return;
        for (const field of error.fieldErrors ?? [])
            errors.value[field.path.split('/').filter(Boolean).at(-1) ?? ''] = field.message;
        uncertain.value = dispatched && (!error.status || error.status >= 500);
        message.value = uncertain.value
            ? '保存结果尚未确认。请关闭并重新读取列表，确认后再编辑。'
            : error.status === 409
              ? '配置已更新，请重新读取后编辑。'
              : '请检查配置后重试。';
        if (uncertain.value) notice.warning('保存结果未确认', message.value);
        else if (!Object.keys(errors.value).length) notice.error('配置未保存', message.value);
        await nextTick();
        form.value?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]')?.focus();
    } finally {
        pending.value = false;
    }
}
const unregister = scope.registerCleanup(() => {
    draft.apiKey = '';
});
onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', beforeUnload);
    draft.apiKey = '';
    unregister();
});
</script>

<style scoped>
.provider-form {
    display: grid;
    gap: 0.8rem;
    padding: clamp(1rem, 4vw, 1.75rem);
    border: 0.0625rem solid color-mix(in srgb, var(--scova-border) 40%, transparent);
    border-radius: 0.9rem;
    background: var(--scova-surface);
    min-inline-size: 0;
}
.form-heading,
.form-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
}
.form-heading {
    justify-content: space-between;
}
h2 {
    margin: 0;
    font-size: 1.125rem;
}
label {
    font-weight: 500;
}
.secret-field {
    display: grid;
    gap: 0.5rem;
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
.close-form {
    display: inline-grid;
    place-items: center;
    inline-size: 2.75rem;
    block-size: 2.75rem;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
}
.close-form:focus-visible {
    outline: 0.0625rem solid var(--scova-primary);
    border-radius: 0.4rem;
}
</style>
