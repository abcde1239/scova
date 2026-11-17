<template>
    <form
        ref="form"
        class="provider-form layout-grid gap-[0.8rem] [border:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_40%,_transparent)] rounded-[0.9rem] bg-surface p-[clamp(1rem,_4vw,_1.75rem)]"
        novalidate
        @submit.prevent="save"
    >
        <div class="form-heading action-row justify-between">
            <h2 class="text-[1.125rem] m-0">{{ provider ? '编辑供应商' : '添加供应商' }}</h2>
            <button
                type="button"
                class="close-form inline-grid place-items-center w-11 h-11 [border:0] bg-transparent text-inherit cursor-pointer focus-visible:([outline:0.0625rem_solid_var(--scova-primary)] rounded-[0.4rem])"
                aria-label="关闭供应商编辑"
                :disabled="pending"
                @click="requestClose"
            >
                <app-icon name="close" />
            </button>
        </div>
        <label class="font-medium" :for="`${id}-preset`">快速填写</label>
        <app-select
            :id="`${id}-preset`"
            v-model="preset"
            label="快速填写"
            :options="presets"
            :disabled="pending"
        />
        <p class="field-hint text-[0.875rem] leading-[1.65] break-anywhere text-muted m-0">
            选择预设会填写地址与协议，并清空模型和未保存的密钥。
        </p>
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
        <p class="field-hint text-[0.875rem] leading-[1.65] break-anywhere text-muted m-0">
            填写 HTTPS API 根地址（包含版本路径），无需填写具体请求接口。
        </p>
        <div class="secret-field grid gap-2">
            <label class="font-medium" :for="`${id}-key`"
                >API Key{{ provider ? '（留空保留）' : '' }}</label
            >
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
            <p
                v-if="errors.apiKey"
                :id="`${id}-key-error`"
                class="field-error text-[0.875rem] leading-[1.65] break-anywhere text-danger m-0"
            >
                {{ errors.apiKey }}
            </p>
            <p
                :id="`${id}-secret-hint`"
                class="field-hint text-[0.875rem] leading-[1.65] break-anywhere text-muted m-0"
            >
                密钥加密保存在服务端，保存后不回显。
            </p>
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
        <p
            v-if="message && Object.keys(errors).length"
            class="field-error text-[0.875rem] leading-[1.65] break-anywhere text-danger m-0"
            role="alert"
            tabindex="-1"
        >
            {{ message }}
        </p>
        <div class="form-actions action-row">
            <action-button attr-type="submit" :busy="pending" :disabled="uncertain"
                >保存配置</action-button
            >
            <action-button :disabled="pending" quaternary @click="requestClose">取消</action-button>
        </div>
        <p class="field-hint text-[0.875rem] leading-[1.65] break-anywhere text-muted m-0">
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
                protocol: draft.protocol,
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
