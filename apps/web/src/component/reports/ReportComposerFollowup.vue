<template>
    <section
        v-if="state.opened.value"
        class="layout-grid gap-3 border-theme rounded-3 p-3 min-w-0"
        :aria-labelledby="`${id}-title`"
        @keydown.esc.stop.prevent="close"
    >
        <header class="flex items-start justify-between gap-2">
            <h3 :id="`${id}-title`" ref="heading" tabindex="-1">补查新资料</h3>
            <button v-if="!state.locked.value" type="button" @click="close">取消</button>
        </header>
        <p class="break-anywhere whitespace-pre-wrap">{{ state.draft.value?.question }}</p>
        <p class="text-sm text-muted break-anywhere">原报告 {{ report?.title }}</p>
        <fieldset class="layout-grid gap-1 min-w-0" :disabled="state.locked.value">
            <label :for="`${id}-source`" class="text-sm">搜索方式</label>
            <select
                :id="`${id}-source`"
                v-model="state.searchMode.value"
                class="theme-input min-w-0"
            >
                <option value="" disabled>选择搜索方式</option>
                <option value="searxng">内置搜索</option>
                <option value="api" :disabled="!state.configuredApi.value">账号 Search API</option>
            </select>
            <p v-if="state.settings.isFetching.value" role="status">正在读取搜索配置</p>
            <p v-else-if="state.settings.isError.value" class="text-sm" role="status">
                账号搜索配置暂不可读取。<button type="button" @click="state.settings.refetch()">
                    重新读取
                </button>
            </p>
            <p v-else-if="!state.configuredApi.value" class="text-muted text-sm">
                账号 Search API 尚不可用
            </p>
        </fieldset>
        <output-format-select
            compact
            v-model="state.formats.value"
            label="本次成果形式"
            :allow-empty="true"
            :disabled="state.locked.value"
        />
        <p v-if="!state.formats.value.length" class="text-muted text-sm">成果形式沿用原报告配置</p>
        <p class="text-muted text-sm">补查沿用原执行预算，搜索和模型调用按实际用量计入额度。</p>
        <p v-if="state.parentQuery.isFetching.value" role="status">正在读取执行预算</p>
        <details v-else-if="state.parent.value" class="text-sm">
            <summary>预算详情</summary>
            <p>
                搜索 {{ state.parent.value.budget.maxSearches }} 次 · 读取
                {{ state.parent.value.budget.maxPages }} 页 ·
                {{ state.parent.value.budget.maxDurationSeconds }} 秒 · 输入
                {{ state.parent.value.budget.maxInputTokens }} / 输出
                {{ state.parent.value.budget.maxOutputTokens }} token
            </p>
        </details>
        <p v-else role="status">
            原执行暂不可读取。<button type="button" @click="state.parentQuery.refetch()">
                重新读取预算
            </button>
        </p>
        <p v-if="state.stalePlan.value && !state.locked.value" role="status" class="text-sm">
            请查看更新后的会话，再重新打开补查确认。
        </p>
        <p v-if="state.message.value" role="status" class="text-sm break-anywhere">
            {{ state.message.value }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
            <action-button
                v-if="!state.attempt.value"
                :disabled="!state.canConfirm.value"
                @click="state.confirm"
                >开始补查</action-button
            >
            <template v-else>
                <action-button
                    v-if="!state.blocked.value"
                    :disabled="!report"
                    :busy="state.pending.value"
                    @click="state.send"
                    >{{ state.pending.value ? '正在确认' : '使用同一请求重发' }}</action-button
                >
                <button v-if="!state.pending.value" type="button" @click="abandon">
                    结束本次请求
                </button>
            </template>
        </div>
    </section>
</template>

<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue';
import type { Report } from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';
import OutputFormatSelect from '@/component/tasks/OutputFormatSelect.vue';
import { useReportComposerFollowup } from '@/composable/useReportComposerFollowup';

const props = defineProps<{ reportId: string; report?: Report; afterQuestionId: string | null }>();
const emit = defineEmits<{
    saved: [id: string];
    opened: [value: boolean];
    closed: [];
    refresh: [];
}>();
const id = useId();
const heading = ref<HTMLElement>();
const state = useReportComposerFollowup(
    () => props.reportId,
    () => props.report,
    () => props.afterQuestionId,
    (id) => emit('saved', id),
    () => emit('refresh'),
);
watch(state.opened, (value) => emit('opened', value), { flush: 'sync' });
async function open(question: string, afterQuestionId: string | null) {
    state.open(question, afterQuestionId);
    await nextTick();
    heading.value?.focus();
}
function close() {
    if (state.locked.value) return;
    state.close();
    emit('closed');
}
function abandon() {
    if (!window.confirm('执行结果尚未确认。结束本次请求后将无法用原请求重发，仍要继续吗？')) return;
    state.abandon();
    emit('refresh');
    emit('closed');
}
defineExpose({ open });
</script>
