<template>
    <section class="purpose-section layout-stack" aria-labelledby="agent-purpose-heading">
        <div class="section-heading flex justify-between items-center flex-wrap gap-[0.5rem_1rem]">
            <h2 class="break-anywhere text-[1.0625rem] m-0" id="agent-purpose-heading">模型选择</h2>
            <info-dialog label="模型分工说明" title="Agent 如何分工">
                <p class="break-anywhere text-muted text-[0.875rem] leading-[1.65] m-0">
                    需求整理 Agent 把你的描述转成任务草稿，不执行搜索或研究。
                </p>
                <p class="break-anywhere text-muted text-[0.875rem] leading-[1.65] m-0">
                    研究执行 Agent 负责执行任务；报告问答也使用此模型。
                </p>
                <p class="break-anywhere text-muted text-[0.875rem] leading-[1.65] m-0">
                    两种用途独立选择，也可共用一个供应商配置。切换对后续调用、新开始或恢复的研究生效；正在执行的研究保持原配置。
                </p>
                <p class="break-anywhere text-muted text-[0.875rem] leading-[1.65] m-0">
                    未选择个人配置时，各用途使用管理员设置的默认模型。保存供应商不代表连接测试通过。
                </p>
            </info-dialog>
        </div>
        <div
            class="purpose-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-4 [@media(max-width:_45rem)]:grid-cols-[minmax(0,_1fr)]"
        >
            <section
                v-for="purpose in purposes"
                :key="purpose.value"
                class="purpose-card layout-grid [align-content:start] gap-3 rounded-[0.8rem] [background:var(--scova-selected)] p-[clamp(0.875rem,_3vw,_1.25rem)]"
                :aria-label="purpose.label + '模型'"
            >
                <h3
                    class="break-anywhere flex items-center gap-2 text-[0.9375rem] [font-weight:550] m-0"
                >
                    <app-icon class="[h3_&.app-icon]:text-primary" :name="purpose.icon" />{{
                        purpose.label
                    }}
                </h3>
                <p class="break-anywhere text-muted text-[0.875rem] leading-[1.65] m-0">
                    {{ purpose.description }}
                </p>
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
        <p
            v-if="!providers.length"
            class="empty-hint break-anywhere text-muted text-[0.875rem] leading-[1.65] m-0"
        >
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
