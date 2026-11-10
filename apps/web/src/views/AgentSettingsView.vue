<template>
    <div class="agent-settings">
        <div class="settings-intro">
            <p>分别为需求整理和研究执行选择模型，可共用同一供应商。</p>
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
            />
            <p v-if="!data.storageReady" class="storage-warning" role="status">
                管理员尚未启用密钥加密，暂时无法添加或切换供应商。
            </p>
            <section class="provider-management" aria-labelledby="provider-management-heading">
                <div class="management-heading">
                    <div>
                        <h2 id="provider-management-heading">供应商管理</h2>
                        <p>管理连接地址、密钥与模型配置。</p>
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
                <p v-if="!data.items.length && !editing" class="empty-providers">暂无供应商</p>
                <ul
                    v-if="data.items.length && !editing"
                    class="provider-list"
                    aria-label="我的供应商"
                >
                    <li v-for="provider in data.items" :key="provider.id" class="provider-card">
                        <div class="provider-details">
                            <div class="provider-heading">
                                <h3>{{ provider.name }}</h3>
                                <span v-if="provider.active" class="active-badge"
                                    ><app-icon name="confirm" />研究执行</span
                                >
                                <span v-if="provider.draftActive" class="active-badge"
                                    ><app-icon name="confirm" />需求整理</span
                                >
                            </div>
                            <p class="provider-model">{{ provider.model }}</p>
                            <p class="provider-address">{{ provider.baseUrl }}</p>
                            <div class="provider-meta">
                                <span>{{ protocolLabel(provider.protocol) }}</span
                                ><span><app-icon name="confirm" />密钥已保存</span>
                                <span v-if="provider.webSearch && provider.webSearch !== 'disabled'"
                                    >内置搜索已允许</span
                                >
                            </div>
                            <provider-balance
                                :provider="provider"
                                :disabled="pending || !data.storageReady"
                            />
                        </div>
                        <div class="provider-actions">
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
                <div v-if="!editing" class="settings-footer">
                    <p>
                        支持 OpenAI 兼容、Anthropic 与 Gemini 协议；兼容接口可选择 JSON Schema 或
                        JSON 模式。保存不代表连接测试通过。
                    </p>
                    <button
                        type="button"
                        class="refresh-button"
                        :disabled="pending"
                        @click="refresh"
                    >
                        <app-icon name="retry" />重新读取配置
                    </button>
                </div>
            </section>
        </template>
        <p v-if="message" role="status" class="action-message">{{ message }}</p>
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
        message.value = `${purpose === 'task_draft' ? '需求整理' : '研究执行'}已切换至 ${provider.name}。`;
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
onBeforeRouteLeave(() => !editing.value || providerEditor.value?.canLeave() === true);
</script>

<style scoped>
.agent-settings {
    display: grid;
    gap: 1.5rem;
    min-inline-size: 0;
}
.settings-intro {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
}
p {
    margin: 0;
    line-height: 1.65;
    overflow-wrap: anywhere;
}
.settings-intro p,
.settings-footer,
.empty-providers {
    color: var(--scova-muted);
}
.provider-management {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    padding-block-start: 1.5rem;
    border-block-start: 0.0625rem solid color-mix(in srgb, var(--scova-border) 45%, transparent);
}
.management-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
}
.management-heading h2 {
    font-size: 1.0625rem;
}
.management-heading p {
    margin-block-start: 0.3rem;
    font-size: 0.875rem;
    color: var(--scova-muted);
}
.provider-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
}
.provider-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 1rem;
    padding-block: 1rem;
    min-inline-size: 0;
}
.provider-card + .provider-card {
    border-block-start: 0.0625rem solid color-mix(in srgb, var(--scova-border) 35%, transparent);
}
.provider-details {
    min-inline-size: 0;
}
.provider-heading {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
}
h2,
h3 {
    font-size: 1rem;
    margin: 0;
    overflow-wrap: anywhere;
}
.active-badge,
.provider-meta span {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
}
.active-badge {
    color: var(--scova-primary);
    font-size: 0.8125rem;
}
.provider-model {
    margin-block-start: 0.35rem;
    font-size: 0.9375rem;
    font-weight: 550;
}
.provider-address {
    font-size: 0.875rem;
    color: var(--scova-muted);
    margin-block-start: 0.25rem;
}
.provider-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    font-size: 0.8125rem;
    color: var(--scova-muted);
    margin-block-start: 0.45rem;
}
.provider-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
}
.settings-footer {
    font-size: 0.875rem;
    display: grid;
    gap: 0.4rem;
}
.refresh-button {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    justify-self: start;
    background: transparent;
    border: 0;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    font: inherit;
    cursor: pointer;
}
.storage-warning,
.action-message {
    font-size: 0.9375rem;
}
.refresh-button:focus-visible {
    outline: 0.0625rem solid var(--scova-primary);
    outline-offset: 0.125rem;
    border-radius: 0.3rem;
}
@media (max-width: 30rem) {
    .provider-card {
        grid-template-columns: minmax(0, 1fr);
        gap: 0.5rem;
    }
    .provider-actions {
        justify-content: flex-start;
    }
}
</style>
