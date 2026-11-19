<template>
    <section
        class="search-configuration purpose-card"
        aria-labelledby="search-configuration-heading"
    >
        <div class="search-heading action-row justify-between">
            <div class="layout-grid gap-2">
                <h3
                    class="m-0 flex items-center gap-2 text-[0.9375rem] font-medium"
                    id="search-configuration-heading"
                >
                    <app-icon name="search" class="text-primary" />搜索与正文提取
                </h3>
                <p class="m-0 text-muted text-[0.875rem] leading-[1.65] break-anywhere">
                    可使用 Search API、自定义搜索服务，或内置 SearXNG。切换模型不会改变此配置。
                </p>
            </div>
            <action-button
                v-if="!editing && loaded"
                quaternary
                :disabled="pending || disabled || !storageReady"
                @click="open"
            >
                <app-icon name="edit" />{{ configuration ? '编辑搜索配置' : '配置搜索' }}
            </action-button>
        </div>
        <state-panel v-if="query.isPending.value" state="loading" message="正在读取搜索配置" />
        <state-panel
            v-else-if="query.isError.value"
            state="error"
            message="搜索配置暂时无法读取"
            retryable
            @retry="refresh"
        />
        <template v-else-if="loaded">
            <p
                v-if="!editing"
                class="search-summary m-0 text-[0.9375rem] leading-[1.65] break-anywhere"
            >
                {{ modeLabel }}
                <span
                    v-if="configuration?.api && configuration.defaultMode === 'api'"
                    class="text-muted"
                >
                    · {{ protocolLabel(configuration.api.protocol) }} ·
                    {{
                        configuration.api.protocol === 'perplexity'
                            ? '需更换支持网页读取的协议'
                            : configuration.api.protocol === 'custom_json'
                              ? '本地工具读取网页'
                              : 'API 读取网页'
                    }}</span
                >
            </p>
            <p v-if="!storageReady" class="m-0 text-muted text-[0.875rem] leading-[1.65]">
                管理员尚未启用密钥加密，暂时无法保存搜索配置。
            </p>
            <form
                v-if="editing"
                ref="form"
                class="search-form"
                aria-labelledby="search-configuration-heading"
                novalidate
                @submit.prevent="save"
            >
                <task-config-field
                    v-model="draft.defaultMode"
                    label="账号搜索方式"
                    kind="select"
                    :options="modeOptions"
                    :disabled="pending"
                    :error="errors.defaultMode"
                    class="search-wide"
                />
                <template v-if="draft.defaultMode === 'api'">
                    <task-config-field
                        v-model="draft.protocol"
                        label="搜索 API 协议"
                        kind="select"
                        :options="protocolOptions"
                        :disabled="pending"
                        :error="errors.protocol"
                    />
                    <task-config-field
                        v-model="draft.baseUrl"
                        :label="
                            draft.protocol === 'custom_json'
                                ? '完整搜索接口地址（HTTPS）'
                                : '搜索 API 地址'
                        "
                        :disabled="pending"
                        :error="errors.baseUrl"
                    />
                    <div class="layout-grid gap-2">
                        <label class="font-medium" :for="`${id}-key`"
                            >搜索 API Key{{
                                configuration?.api
                                    ? draft.protocol === 'custom_json'
                                        ? '（地址、协议与模板不变时留空保留）'
                                        : '（地址与协议不变时留空保留）'
                                    : ''
                            }}</label
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
                                'aria-describedby': `${id}-key-hint`,
                            }"
                        />
                        <p
                            :id="`${id}-key-hint`"
                            class="m-0 text-[0.875rem] leading-[1.65] break-anywhere"
                            :class="errors.apiKey ? 'text-danger' : 'text-muted'"
                        >
                            {{ errors.apiKey || '独立加密保存，不使用模型密钥。' }}
                        </p>
                    </div>
                    <search-template-fields
                        v-if="draft.protocol === 'custom_json'"
                        v-model="templateDraft"
                        :disabled="pending"
                        :errors="errors"
                        @preset="applyBravePreset"
                        @clear="clearError"
                    />
                    <p v-else class="search-wide m-0 text-muted text-[0.875rem] leading-[1.65]">
                        搜索与网页正文均由所选 API 提供。
                        <template v-if="draft.protocol === 'perplexity'">
                            Perplexity Search 暂不支持独立网页读取，请改选 DeepSeek 或 Tavily。
                        </template>
                    </p>
                </template>
                <p v-else class="search-wide m-0 text-muted text-[0.875rem] leading-[1.65]">
                    使用内置 SearXNG 搜索，由本地网页读取工具提取原站正文，无需搜索 API 密钥。
                </p>
                <p
                    v-if="message && Object.keys(errors).length"
                    class="search-wide m-0 text-danger text-[0.875rem] leading-[1.65]"
                    role="alert"
                    tabindex="-1"
                >
                    {{ message }}
                </p>
                <div class="search-wide action-row">
                    <action-button attr-type="submit" :busy="pending" :disabled="uncertain"
                        >保存搜索配置</action-button
                    >
                    <action-button quaternary :disabled="pending" @click="close"
                        >取消</action-button
                    >
                    <action-button v-if="uncertain" quaternary :disabled="pending" @click="refresh"
                        >重新读取</action-button
                    >
                </div>
            </form>
            <div v-if="legacyProviders.length && !editing" class="legacy-import layout-grid gap-3">
                <p class="m-0 text-muted text-[0.875rem] leading-[1.65]">
                    旧供应商中保存了搜索 API，可迁入此处独立使用。
                </p>
                <div class="action-row">
                    <app-select
                        v-model="legacyProviderId"
                        label="迁入搜索配置的供应商"
                        :options="legacyOptions"
                        placeholder="选择旧搜索配置"
                        :disabled="pending || disabled || !storageReady"
                    />
                    <action-button
                        quaternary
                        :disabled="!legacyProviderId || pending || disabled || !storageReady"
                        :busy="pending"
                        @click="importLegacy"
                        >迁入搜索配置</action-button
                    >
                </div>
            </div>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue';
import { NInput } from 'naive-ui';
import { SearchConfigurationInputSchema, parseContract, type AgentProvider } from '@scova/models';
import {
    searchConfigurationEndpoint,
    saveSearchConfigurationEndpoint,
    importSearchConfigurationEndpoint,
} from '@/api/search-configuration';
import { useSessionLifecycle, useSessionQuery } from '@/composable/useSessionQuery';
import { useActionNotification } from '@/composable/useActionNotification';
import { toApiError } from '@/api/errors';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import AppSelect from '@/component/common/AppSelect.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import TaskConfigField from '@/component/tasks/TaskConfigField.vue';
import SearchTemplateFields from '@/component/account/SearchTemplateFields.vue';
import {
    braveSearchEndpoint,
    searchTemplateDraft,
    parseSearchTemplate,
} from '@/utils/account/search-template';

const props = defineProps<{ providers: AgentProvider[]; disabled?: boolean }>();
const lifecycle = useSessionLifecycle();
const notice = useActionNotification();
const query = useSessionQuery(searchConfigurationEndpoint, {}, ['search-configuration']);
const loaded = computed(() => !!query.data.value?.data);
const configuration = computed(() => query.data.value?.data.configuration ?? null);
const storageReady = computed(() => query.data.value?.data.storageReady ?? false);
const modeLabel = computed(() =>
    !configuration.value
        ? '内置 SearXNG＋网页读取工具（默认）'
        : configuration.value.defaultMode === 'api'
          ? 'Search API／自定义搜索'
          : '内置 SearXNG＋网页读取工具',
);
const protocolLabel = (protocol: string) =>
    ({
        deepseek: 'DeepSeek Search',
        perplexity: 'Perplexity Search',
        tavily: 'Tavily Search',
        custom_json: '自定义 JSON 搜索',
    })[protocol] ?? protocol;
const modeOptions = [
    { value: 'api', label: 'Search API／自定义搜索' },
    { value: 'searxng', label: '内置 SearXNG＋网页读取工具' },
];
const protocolOptions = [
    { value: 'deepseek', label: 'DeepSeek Search' },
    { value: 'tavily', label: 'Tavily Search' },
    { value: 'custom_json', label: '自定义 HTTP JSON＋本地网页读取' },
];
const id = useId();
const editing = ref(false),
    pending = ref(false),
    uncertain = ref(false),
    message = ref('');
const form = ref<HTMLFormElement>();
const errors = ref<Record<string, string>>({});
const draft = reactive({
    defaultMode: 'searxng',
    protocol: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
});
const templateDraft = ref(searchTemplateDraft());
const initial = ref('');
const editingRevision = ref<number>();
const draftIdentity = () =>
    JSON.stringify([draft, draft.protocol === 'custom_json' ? templateDraft.value : null]);
const dirty = computed(() => editing.value && draftIdentity() !== initial.value);
function canLeave() {
    return !pending.value && (!dirty.value || window.confirm('搜索配置尚未保存，确定放弃修改？'));
}
defineExpose({ canLeave });
function open() {
    const saved = configuration.value;
    editingRevision.value = saved?.revision;
    Object.assign(draft, {
        defaultMode: saved?.defaultMode ?? 'searxng',
        protocol: saved?.api?.protocol ?? 'deepseek',
        baseUrl: saved?.api?.baseUrl ?? 'https://api.deepseek.com/v1',
        apiKey: '',
    });
    templateDraft.value = searchTemplateDraft(saved?.api?.custom);
    initial.value = draftIdentity();
    errors.value = {};
    message.value = '';
    uncertain.value = false;
    editing.value = true;
}
function close() {
    if (!canLeave()) return;
    editing.value = false;
    draft.apiKey = '';
}
async function refresh() {
    if (!canLeave()) return;
    editing.value = false;
    draft.apiKey = '';
    await query.refetch();
}
watch(
    () => draft.protocol,
    (value, old) => {
        if (!editing.value || value === old) return;
        draft.baseUrl =
            value === 'deepseek'
                ? 'https://api.deepseek.com/v1'
                : value === 'tavily'
                  ? 'https://api.tavily.com'
                  : value === 'custom_json'
                    ? braveSearchEndpoint
                    : 'https://api.perplexity.ai';
        draft.apiKey = '';
        errors.value = {};
    },
    { flush: 'sync' },
);
function applyBravePreset() {
    draft.baseUrl = braveSearchEndpoint;
    templateDraft.value = searchTemplateDraft();
    draft.apiKey = '';
    errors.value = {};
}
function clearError(field: string) {
    if (errors.value[field]) delete errors.value[field];
}
async function reportFailure(cause: unknown, dispatched: boolean) {
    const error = toApiError(cause);
    if (error.kind === 'cancelled') return;
    for (const field of error.fieldErrors ?? []) {
        const parts = field.path.split('/').filter(Boolean);
        const name = parts.includes('request')
            ? 'request'
            : parts.includes('languageMap')
              ? 'languageMap'
              : parts.includes('auth') && parts.at(-1) !== 'headerName'
                ? 'auth'
                : (parts.at(-1) ?? 'custom');
        errors.value[name] = field.message;
    }
    uncertain.value = dispatched && (!error.status || error.status >= 500);
    message.value =
        error.status === 409
            ? '配置已更新，请重新读取后编辑。'
            : uncertain.value
              ? '保存结果未确认，请重新读取配置。'
              : '请检查搜索配置后重试。';
    if (!Object.keys(errors.value).length) notice.error('搜索配置未保存', message.value);
    await nextTick();
    form.value?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]')?.focus();
}
async function save() {
    if (pending.value || uncertain.value) return;
    const scope = lifecycle.capture();
    pending.value = true;
    errors.value = {};
    message.value = '';
    let dispatched = false;
    try {
        let custom;
        if (draft.defaultMode === 'api' && draft.protocol === 'custom_json') {
            try {
                custom = parseSearchTemplate(templateDraft.value);
            } catch (cause) {
                errors.value[cause instanceof TypeError ? 'request' : 'custom'] =
                    cause instanceof TypeError ? cause.message : '请检查参数、鉴权和结果字段映射。';
                message.value = '请检查自定义搜索配置后重试。';
                await nextTick();
                form.value
                    ?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]')
                    ?.focus();
                return;
            }
        }
        const body = parseContract(SearchConfigurationInputSchema, {
            ...(editingRevision.value !== undefined ? { revision: editingRevision.value } : {}),
            defaultMode: draft.defaultMode,
            ...(draft.defaultMode === 'api'
                ? {
                      api: {
                          protocol: draft.protocol,
                          baseUrl: draft.baseUrl.trim(),
                          contentMode: draft.protocol === 'custom_json' ? 'reader' : 'prefer_api',
                          ...(custom ? { custom } : {}),
                          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
                      },
                  }
                : {}),
        });
        dispatched = true;
        await scope.request(saveSearchConfigurationEndpoint, { body });
        if (!scope.isCurrent()) return;
        editing.value = false;
        draft.apiKey = '';
        await query.refetch();
        if (scope.isCurrent()) notice.success('搜索配置已保存');
    } catch (cause) {
        if (scope.isCurrent()) await reportFailure(cause, dispatched);
    } finally {
        pending.value = false;
    }
}
const legacyProviders = computed(() =>
    props.providers.filter(
        (provider) => !!provider.searchApi && provider.searchApi.protocol !== 'perplexity',
    ),
);
const legacyOptions = computed(() =>
    legacyProviders.value.map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: protocolLabel(provider.searchApi!.protocol),
    })),
);
const legacyProviderId = ref('');
async function importLegacy() {
    const provider = legacyProviders.value.find((item) => item.id === legacyProviderId.value);
    if (!provider || pending.value) return;
    if (
        configuration.value &&
        !window.confirm(`用“${provider.name}”中的搜索配置替换当前搜索配置？`)
    )
        return;
    const scope = lifecycle.capture();
    pending.value = true;
    errors.value = {};
    try {
        await scope.request(importSearchConfigurationEndpoint, {
            params: { providerId: provider.id },
            body: {
                providerRevision: provider.revision,
                ...(configuration.value ? { revision: configuration.value.revision } : {}),
            },
        });
        await query.refetch();
        if (scope.isCurrent()) notice.success('搜索配置已迁入', '后续独立保存，不随模型配置切换。');
    } catch (cause) {
        if (scope.isCurrent()) await reportFailure(cause, true);
    } finally {
        pending.value = false;
    }
}
function beforeUnload(event: BeforeUnloadEvent) {
    if (!dirty.value && !pending.value) return;
    event.preventDefault();
    event.returnValue = '';
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
const unregister = lifecycle.capture().registerCleanup(() => {
    draft.apiKey = '';
});
onBeforeUnmount(() => {
    draft.apiKey = '';
    unregister();
    window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<style scoped>
.search-configuration {
    @apply col-span-full layout-grid gap-4 rounded-[0.8rem] [background:var(--scova-selected)] p-[clamp(0.875rem,_3vw,_1.25rem)];
}
.search-form {
    @apply grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-4 pt-4 [border-top:0.0625rem_solid_var(--scova-border)] [@media(max-width:_45rem)]:grid-cols-[minmax(0,_1fr)];
}
.search-wide {
    @apply col-span-full;
}
.legacy-import {
    @apply pt-4 [border-top:0.0625rem_solid_var(--scova-border)];
}
.legacy-import :deep(.app-select) {
    @apply flex-1 min-w-0;
}
.search-form :deep(.n-input) {
    @apply ![--n-font-size:1rem] min-h-11 min-w-0 w-full max-w-full rounded-1.5;
}
</style>
