<template>
    <section class="purpose-section" aria-labelledby="agent-purpose-heading">
        <div class="section-heading">
            <h2 id="agent-purpose-heading">模型选择</h2>
            <info-dialog label="模型分工说明" title="Agent 如何分工">
                <p>需求整理 Agent 把你的描述转成任务草稿，不执行搜索或研究。</p>
                <p>研究执行 Agent 负责执行任务；报告问答也使用此模型。</p>
                <p>
                    两种用途独立选择，也可共用一个供应商配置。切换对后续调用、新开始或恢复的研究生效；正在执行的研究保持原配置。
                </p>
                <p>
                    未选择个人配置时，各用途使用管理员设置的默认模型。保存供应商不代表连接测试通过。
                </p>
            </info-dialog>
        </div>
        <div class="purpose-grid">
            <section
                v-for="purpose in purposes"
                :key="purpose.value"
                class="purpose-card"
                :aria-label="purpose.label + '模型'"
            >
                <h3><app-icon :name="purpose.icon" />{{ purpose.label }}</h3>
                <p>{{ purpose.description }}</p>
                <app-select
                    :model-value="selected(purpose.value)?.id ?? ''"
                    :label="purpose.label + '使用的配置'"
                    :options="options"
                    :placeholder="systemConfigured ? '部署默认配置' : '尚未配置模型'"
                    :disabled="disabled || !providers.length"
                    @update:model-value="emit('select', $event, purpose.value)"
                />
            </section>
        </div>
        <p v-if="!providers.length" class="empty-hint">
            在下方添加供应商后，即可为两种用途选择模型。
        </p>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AgentProvider, AgentProviderPurpose } from '@scova/models';
import AppSelect from '@/components/common/AppSelect.vue';
import AppIcon from '@/components/common/AppIcon.vue';
import InfoDialog from '@/components/common/InfoDialog.vue';

const props = defineProps<{
    providers: AgentProvider[];
    systemConfigured: boolean;
    disabled: boolean;
}>();
const emit = defineEmits<{ select: [id: string, purpose: AgentProviderPurpose] }>();
const purposes = [
    {
        value: 'task_draft',
        label: '需求整理',
        description: '将需求描述整理为任务配置',
        icon: 'edit',
    },
    {
        value: 'research',
        label: '研究执行',
        description: '执行研究任务与报告问答',
        icon: 'search',
    },
] as const;
const selected = (purpose: AgentProviderPurpose) =>
    props.providers.find((provider) =>
        purpose === 'task_draft' ? provider.draftActive : provider.active,
    );
const options = computed(() =>
    props.providers.map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.model,
    })),
);
</script>

<style scoped>
.purpose-section {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
}
.section-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
}
h2,
h3,
p {
    margin: 0;
    overflow-wrap: anywhere;
}
h2 {
    font-size: 1.0625rem;
}
.purpose-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
}
.purpose-card {
    display: grid;
    align-content: start;
    gap: 0.75rem;
    min-inline-size: 0;
    padding: clamp(0.875rem, 3vw, 1.25rem);
    border-radius: 0.8rem;
    background: var(--scova-selected);
}
h3 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9375rem;
    font-weight: 550;
}
h3 .app-icon {
    color: var(--scova-primary);
}
p {
    color: var(--scova-muted);
    font-size: 0.875rem;
    line-height: 1.65;
}
@media (max-width: 45rem) {
    .purpose-grid {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
