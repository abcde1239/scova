<template>
    <div class="task-execution-settings layout-grid gap-4 max-w-[36rem] min-w-0">
        <execution-agent-select v-model="agent" :inherit="inherit" :disabled="disabled" />
        <search-mode-select
            v-model="search"
            :inherit="inherit"
            :label="inherit ? '本次搜索方式' : '搜索方式'"
            :inherit-label="retry ? '沿用原执行搜索方式' : '沿用任务搜索方式'"
            :disabled="disabled"
        />
        <div class="execution-settings-footer layout-grid gap-2">
            <p class="text-muted text-sm leading-relaxed break-anywhere m-0">
                {{
                    inherit
                        ? retry
                            ? '选择仅用于本次重试，输出形式、任务版本与预算沿用原执行。'
                            : '选择仅用于本次执行，输出形式沿用任务配置。'
                        : '保存后用于该任务的手动与计划执行。'
                }}
            </p>
            <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
                <router-link class="navigation-link" :to="{ name: 'agent-settings' }">
                    管理 Agent 配置<app-icon name="chevron" />
                </router-link>
                <slot />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import AppIcon from '@/components/common/AppIcon.vue';
import ExecutionAgentSelect from '@/components/tasks/ExecutionAgentSelect.vue';
import SearchModeSelect from '@/components/tasks/SearchModeSelect.vue';
defineProps<{ disabled?: boolean; inherit?: boolean; retry?: boolean }>();
const agent = defineModel<string>('agent', { required: true });
const search = defineModel<string>('search', { required: true });
</script>
