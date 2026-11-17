<template>
    <div class="agent-settings layout-grid gap-6">
        <div class="settings-intro flex items-center justify-between gap-4 flex-wrap">
            <p class="leading-[1.65] break-anywhere m-0 [.settings-intro_&:is(p)]:text-muted">
                分别配置解析、任务执行、搜索与正文提取。
            </p>
        </div>
        <state-panel v-if="query.isPending.value" state="loading" message="正在读取模型配置" />
        <state-panel
            v-else-if="query.isError.value"
            state="error"
            message="模型配置暂时无法读取"
            retryable
            @retry="refresh"
        />
        <template v-else-if="data">
            <agent-purpose-select
                :providers="data.items"
                :system-configured="data.systemConfigured"
                :disabled="pending || editing || !data.storageReady"
                @select="chooseProvider"
            >
                <search-configuration-form
                    ref="searchEditor"
                    :providers="data.items"
                    :disabled="pending || editing"
                />
            </agent-purpose-select>
            <p
                v-if="!data.storageReady"
                class="storage-warning leading-[1.65] break-anywhere text-[0.9375rem] m-0"
                role="status"
            >
                管理员尚未启用密钥加密，暂时无法添加或切换供应商。
            </p>
            <section
                class="provider-management layout-stack pt-6 [border-top:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_45%,_transparent)]"
                aria-labelledby="provider-management-heading"
            >
                <div class="management-heading flex items-center justify-between flex-wrap gap-4">
                    <div>
                        <h2
                            class="[.management-heading_&:is(h2)]:text-[1.0625rem] text-[1rem] break-anywhere m-0"
                            id="provider-management-heading"
                        >
                            供应商管理
                        </h2>
                        <p
                            class="leading-[1.65] break-anywhere m-0 [.management-heading_&:is(p)]:(mt-[0.3rem] text-[0.875rem] text-muted)"
                        >
                            管理解析和任务执行使用的模型连接。
                        </p>
                    </div>
                    <action-button
                        v-if="!editing"
                        :disabled="pending || !data.storageReady"
                        @click="open()"
                        ><app-icon name="create" />添加供应商</action-button
                    >
                </div>
                <agent-provider-form
                    v-if="editing"
                    ref="providerEditor"
                    :key="editingProvider?.id ?? 'new'"
                    :provider="editingProvider"
                    @saved="saved"
                    @close="close"
                />
                <p
                    v-if="!data.items.length && !editing"
                    class="empty-providers leading-[1.65] break-anywhere text-muted m-0"
                >
                    暂无供应商
                </p>
                <ul
                    v-if="data.items.length && !editing"
                    class="provider-list list-none grid m-0 p-0"
                    aria-label="我的供应商"
                >
                    <li
                        v-for="provider in data.items"
                        :key="provider.id"
                        class="provider-card layout-stack grid-cols-[minmax(0,_1fr)_auto] items-center pt-4 pb-4 [.provider-card_+_&.provider-card]:[border-top:0.0625rem_solid_color-mix(in_srgb,_var(--scova-border)_35%,_transparent)] [@media(max-width:_30rem)]:(grid-cols-[minmax(0,_1fr)] gap-2)"
                    >
                        <div class="provider-details min-w-0">
                            <div class="provider-heading action-row">
                                <h3 class="text-[1rem] break-anywhere m-0">{{ provider.name }}</h3>
                                <span
                                    v-if="provider.active"
                                    class="active-badge inline-flex items-center gap-[0.3rem] text-primary text-[0.8125rem]"
                                    ><app-icon name="confirm" />任务执行</span
                                >
                                <span
                                    v-if="provider.draftActive"
                                    class="active-badge inline-flex items-center gap-[0.3rem] text-primary text-[0.8125rem]"
                                    ><app-icon name="confirm" />解析</span
                                >
                            </div>
                            <p
                                class="provider-model mt-[0.35rem] mb-0 leading-[1.65] break-anywhere text-[0.9375rem] [font-weight:550] mx-0"
                            >
                                {{ provider.model }}
                            </p>
                            <p
                                class="provider-address mt-1 mb-0 leading-[1.65] break-anywhere text-[0.875rem] text-muted mx-0"
                            >
                                {{ provider.baseUrl }}
                            </p>
                            <div
                                class="provider-meta flex flex-wrap gap-[0.5rem_1rem] text-[0.8125rem] text-muted mt-[0.45rem]"
                            >
                                <span
                                    class="[.provider-meta_&:is(span)]:(inline-flex items-center gap-[0.3rem])"
                                    >{{ protocolLabel(provider.protocol) }}</span
                                ><span
                                    class="[.provider-meta_&:is(span)]:(inline-flex items-center gap-[0.3rem])"
                                    ><app-icon
                                        class="[.provider-meta_&:is(span)]:(inline-flex items-center gap-[0.3rem])"
                                        name="confirm"
                                    />密钥已保存</span
                                >
                                <span
                                    class="[.provider-meta_&:is(span)]:(inline-flex items-center gap-[0.3rem])"
                                    v-if="provider.searchApi"
                                    >含旧搜索配置 · 可在上方迁入</span
                                >
                            </div>
                            <provider-balance
                                :provider="provider"
                                :disabled="pending || !data.storageReady"
                            />
                        </div>
                        <div
                            class="provider-actions flex flex-wrap gap-1 [@media(max-width:_30rem)]:justify-start"
                        >
                            <action-button
                                quaternary
                                :disabled="pending || editing || !data.storageReady"
                                @click="open(provider)"
                                ><app-icon name="edit" />编辑</action-button
                            >
                            <action-button
                                quaternary
                                :disabled="pending || editing"
                                @click="remove(provider)"
                                ><app-icon name="delete" />删除</action-button
                            >
                        </div>
                    </li>
                </ul>
                <div
                    v-if="!editing"
                    class="settings-footer text-muted text-[0.875rem] grid gap-[0.4rem]"
                >
                    <p class="leading-[1.65] break-anywhere m-0">
                        支持 OpenAI 兼容、Anthropic 与 Gemini 协议；兼容接口可选择 JSON Schema 或
                        JSON 模式。保存不代表连接测试通过。
                    </p>
                    <button
                        type="button"
                        class="refresh-button inline-flex items-center gap-[0.4rem] justify-self-start bg-transparent [border:0] min-h-11 text-primary font-inherit cursor-pointer focus-visible:([outline:0.0625rem_solid_var(--scova-primary)] [outline-offset:0.125rem] rounded-[0.3rem])"
                        :disabled="pending"
                        @click="refresh"
                    >
                        <app-icon name="retry" />重新读取配置
                    </button>
                </div>
            </section>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { AgentProvider, AgentProviderPurpose } from '@scova/models';
import { onBeforeRouteLeave } from 'vue-router';
import { useSessionLifecycle, useSessionQuery } from '@/composables/useSessionQuery';
import {
    listProvidersEndpoint,
    activateProviderEndpoint,
    deleteProviderEndpoint,
} from '@/api/agent-providers';
import { toApiError } from '@/api/errors';
import ActionButton from '@/components/common/ActionButton.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import StatePanel from '@/components/common/StatePanel.vue';
import AgentProviderForm from '@/components/account/AgentProviderForm.vue';
import AgentPurposeSelect from '@/components/account/AgentPurposeSelect.vue';
import SearchConfigurationForm from '@/components/account/SearchConfigurationForm.vue';
import ProviderBalance from '@/components/account/ProviderBalance.vue';
import { useActionNotification } from '@/composables/useActionNotification';
const notice = useActionNotification();
const lifecycle = useSessionLifecycle();
const query = useSessionQuery(listProvidersEndpoint, {}, ['agent-providers']);
const data = computed(() => query.data.value?.data);
const isSelected = (provider: AgentProvider, purpose: AgentProviderPurpose) =>
    purpose === 'task_draft' ? provider.draftActive : provider.active;
const editing = ref(false),
    editingProvider = ref<AgentProvider>(),
    pending = ref(false),
    message = ref('');
const providerEditor = ref<InstanceType<typeof AgentProviderForm>>();
const searchEditor = ref<InstanceType<typeof SearchConfigurationForm>>();
const protocolLabel = (protocol: AgentProvider['protocol']) =>
    ({
        openai_chat_completions: 'OpenAI · JSON Schema',
        openai_json: 'OpenAI 兼容 · JSON 模式',
        anthropic_messages: 'Anthropic',
        gemini: 'Gemini',
    })[protocol];
async function open(provider?: AgentProvider) {
    editingProvider.value = provider;
    editing.value = true;
    message.value = '';
    await nextTick();
    document.querySelector<HTMLElement>('.provider-form input')?.focus();
}
function close() {
    editing.value = false;
    editingProvider.value = undefined;
}
async function refresh() {
    close();
    message.value = '';
    await query.refetch();
}
async function saved() {
    const scope = lifecycle.capture();
    close();
    await query.refetch();
    if (!scope.isCurrent()) return;
    message.value = '配置已保存。';
    notice.success('配置已保存', '保存不代表连接测试通过。');
}
async function activate(provider: AgentProvider, purpose: AgentProviderPurpose) {
    if (
        pending.value ||
        editing.value ||
        !data.value?.storageReady ||
        isSelected(provider, purpose)
    )
        return;
    pending.value = true;
    message.value = '';
    const scope = lifecycle.capture();
    try {
        await scope.request(activateProviderEndpoint, {
            params: { id: provider.id },
            body: { revision: provider.revision, purpose },
        });
        await query.refetch();
        if (!scope.isCurrent()) return;
        message.value = `${purpose === 'task_draft' ? '解析' : '任务执行'}已切换至 ${provider.name}。`;
        notice.success('模型用途已更新', message.value);
    } catch (cause) {
        if (scope.isCurrent() && toApiError(cause).kind !== 'cancelled') {
            message.value = '切换未确认，请重新读取配置后重试。';
            notice.warning('切换结果未确认', message.value);
            await query.refetch();
        }
    } finally {
        pending.value = false;
    }
}
function chooseProvider(id: string, purpose: AgentProviderPurpose) {
    const provider = data.value?.items.find((item) => item.id === id);
    if (provider) void activate(provider, purpose);
}
async function remove(provider: AgentProvider) {
    if (
        pending.value ||
        !window.confirm(
            provider.active || provider.draftActive
                ? `删除“${provider.name}”？${[provider.active ? '研究执行与报告问答' : '', provider.draftActive ? '需求整理' : ''].filter(Boolean).join('、')}将恢复部署默认模型；未配置默认模型时对应功能将不可用。`
                : `删除“${provider.name}”？`,
        )
    )
        return;
    pending.value = true;
    message.value = '';
    const scope = lifecycle.capture();
    try {
        await scope.request(deleteProviderEndpoint, {
            params: { id: provider.id },
            body: { revision: provider.revision },
        });
        await query.refetch();
        if (!scope.isCurrent()) return;
        message.value = '供应商已删除。';
        notice.success('供应商已删除');
    } catch (cause) {
        if (scope.isCurrent() && toApiError(cause).kind !== 'cancelled') {
            message.value = '删除未确认，请重新读取配置后重试。';
            notice.warning('删除结果未确认', message.value);
            await query.refetch();
        }
    } finally {
        pending.value = false;
    }
}
onBeforeRouteLeave(
    () =>
        (!editing.value || providerEditor.value?.canLeave() === true) &&
        searchEditor.value?.canLeave() !== false,
);
</script>
