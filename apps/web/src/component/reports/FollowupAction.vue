<template>
    <section
        ref="root"
        class="followup scova-question-tools min-w-0"
        :aria-label="revision ? '资料内改写' : '补充研究'"
        tabindex="-1"
    >
        <button
            v-if="state.canOpen.value && !state.opened.value"
            type="button"
            class="followup-trigger"
            :disabled="disabled"
            @click="open"
        >
            {{ revision ? '用已有资料改写' : '据此补查新资料' }}
        </button>
        <p
            v-if="report?.mode === 'demo' && !state.candidateId.value && !revision"
            class="text-muted m-0"
        >
            演示报告仅供讨论，请从任务页启动研究。
        </p>
        <section v-if="state.opened.value" class="plan-card" :aria-labelledby="`${cardId}-title`">
            <header class="flex items-start justify-between gap-2">
                <h3 :id="`${cardId}-title`" tabindex="-1">
                    {{ revision ? '用已有资料改写' : '补查新资料' }}
                </h3>
                <button
                    type="button"
                    class="dismiss"
                    :disabled="state.pending.value"
                    aria-label="收起执行计划"
                    @click="cancel"
                >
                    <app-icon name="close" />
                </button>
            </header>
            <p>{{ question?.question }}</p>
            <p class="text-muted">
                {{
                    revision
                        ? '使用保存的证据和本轮讨论，生成独立成果。'
                        : '围绕本轮问题补充查阅，生成独立成果。'
                }}
            </p>
            <output-format-select
                compact
                v-model="formats"
                label="本次成果形式"
                :allow-empty="true"
                :disabled="state.pending.value"
            />
            <p v-if="!formats.length" class="text-muted text-sm">成果形式沿用原报告配置</p>
            <p v-if="!revision" class="text-sm">搜索方式：沿用任务</p>
            <p v-if="state.parentQuery.isFetching.value" role="status">正在读取执行预算</p>
            <template v-if="state.parent.value">
                <details class="text-sm">
                    <summary>预算详情</summary>
                    <dl class="budget-grid">
                        <div>
                            <dt>页面读取</dt>
                            <dd>{{ state.parent.value.budget.maxPages }} 页</dd>
                        </div>
                        <div>
                            <dt>时长</dt>
                            <dd>{{ state.parent.value.budget.maxDurationSeconds }} 秒</dd>
                        </div>
                        <div>
                            <dt>输入 token</dt>
                            <dd>{{ state.parent.value.budget.maxInputTokens }}</dd>
                        </div>
                        <div>
                            <dt>输出 token</dt>
                            <dd>{{ state.parent.value.budget.maxOutputTokens }}</dd>
                        </div>
                    </dl>
                </details>
                <footer class="plan-footer">
                    <span class="text-muted text-sm"
                        >{{
                            revision
                                ? '不联网 · '
                                : `最多搜索 ${state.parent.value.budget.maxSearches} 次 · `
                        }}计入模型额度</span
                    ><action-button
                        :disabled="!state.available.value || state.pending.value"
                        :busy="state.pending.value"
                        @click="state.confirm"
                        >{{ state.pending.value ? '正在提交' : '开始执行' }}</action-button
                    >
                </footer>
            </template>
            <div
                v-else-if="state.parentQuery.isError.value || !state.parentQuery.isFetching.value"
                role="alert"
            >
                原执行暂不可读取，无法开始。<button
                    type="button"
                    @click="state.parentQuery.refetch()"
                >
                    重新读取预算
                </button>
            </div>
        </section>
        <div
            v-if="state.protectedState.value"
            class="recovery-card layout-grid gap-2 border-theme rounded-3 p-3"
            role="status"
        >
            <p class="m-0">执行结果尚未确认，原请求已保留。</p>
            <div class="flex flex-wrap gap-2">
                <action-button
                    :disabled="!state.available.value || state.pending.value"
                    :busy="state.pending.value"
                    @click="state.recover"
                    >读取已保存关联</action-button
                ><action-button
                    v-if="state.phase.value === 'uncertain'"
                    :disabled="!state.available.value || state.pending.value"
                    @click="state.replay"
                    >使用同一请求重发</action-button
                >
            </div>
        </div>
        <div v-if="state.phase.value === 'rejected'" class="layout-grid gap-2" role="status">
            <p class="m-0">{{ state.message.value }}</p>
            <router-link v-if="report" :to="`/tasks/${report.taskId}`" class="navigation-link"
                >返回任务摘要<app-icon name="chevron"
            /></router-link>
        </div>
        <template v-if="state.candidateId.value || validatedId">
            <report-run-card
                :report="state.linkedRun.value ? report : undefined"
                v-if="validatedId"
                v-show="!!state.linkedRun.value"
                :run-id="validatedId"
                :latest-run-id="latestRunId"
                :question-id="questionId"
                :operation="operation ?? 'research'"
                :round="round"
                @open-artifact="emit('openArtifact', $event)"
                @open-original="emit('openOriginal')"
                @merge="emit('merge', $event)"
                @artifact="emit('artifact', $event)"
                @active-change="emit('activeChange', $event)"
                @protected-change="runProtected = $event"
            />
            <div v-if="!state.linkedRun.value" role="status">
                {{
                    state.parentQuery.isError.value || state.linkedQuery.isError.value
                        ? '关联执行暂时无法核验'
                        : '正在读取关联执行'
                }}<button
                    v-if="state.parentQuery.isError.value || state.linkedQuery.isError.value"
                    type="button"
                    @click="readLinked"
                >
                    重新读取关联执行
                </button>
            </div>
        </template>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch, useId } from 'vue';
import type { Report, OutputFormat, ReportConversation } from '@scova/models';
import type { ReportQuestionDetail } from '@/api/report-questions';
import OutputFormatSelect from '@/component/tasks/OutputFormatSelect.vue';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import ReportRunCard from '@/component/reports/ReportRunCard.vue';
import { useFollowup } from '@/composable/useFollowup';
import { useActionNotification } from '@/composable/useActionNotification';
type Artifact = NonNullable<ReportConversation['artifacts']>[number];
const props = defineProps<{
    reportId: string;
    questionId: string;
    report?: Report;
    question?: ReportQuestionDetail;
    disabled?: boolean;
    operation?: 'research' | 'revise';
    round?: number;
    latestRunId?: string;
}>();
const emit = defineEmits<{
    protectedChange: [value: boolean];
    linkedChange: [value: boolean];
    activeChange: [value: boolean];
    artifact: [artifact: Artifact];
    openArtifact: [artifact: Artifact];
    openOriginal: [];
    merge: [reportId: string];
}>();
const revision = computed(() => props.operation === 'revise');
const cardId = `followup-${useId()}`;
const formats = ref<OutputFormat[]>([]);
const state = useFollowup(
    () => props.reportId,
    () => props.questionId,
    () => props.report,
    () => props.question,
    undefined,
    () => props.operation ?? 'research',
    formats,
);
const root = ref<HTMLElement>();
const runProtected = ref(false);
const validatedId = ref('');
watch(
    state.linkedRun,
    (value) => {
        if (value) validatedId.value = value.id;
    },
    { immediate: true },
);
useActionNotification().watch(state.message, () =>
    state.phase.value === 'success'
        ? 'success'
        : state.phase.value === 'rejected'
          ? 'error'
          : 'warning',
);
async function open() {
    state.open();
    await nextTick();
    root.value?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
}
async function cancel() {
    state.close();
    await nextTick();
    root.value?.querySelector<HTMLButtonElement>('.followup-trigger')?.focus();
}
async function readLinked() {
    await state.parentQuery.refetch({ cancelRefetch: false });
    if (state.parent.value) await state.linkedQuery.refetch({ cancelRefetch: false });
}
watch(
    () => state.protectedState.value || runProtected.value,
    (value) => emit('protectedChange', value),
    { immediate: true, flush: 'sync' },
);
watch(
    () => !!state.candidateId.value,
    (value) => emit('linkedChange', value),
    { immediate: true, flush: 'sync' },
);
onUnmounted(() => {
    emit('protectedChange', false);
    emit('linkedChange', false);
    emit('activeChange', false);
});
</script>

<style scoped>
.followup-trigger {
    @apply font-inherit min-h-11 rounded-2 border-theme bg-transparent text-default text-start px-3 py-2 cursor-pointer keyboard-focus-wide;
}
.followup-trigger:hover {
    @apply [background:var(--scova-selected)];
}
.plan-card {
    @apply grid gap-3 border-theme rounded-3 overflow-hidden p-4;
}
.plan-card h3 {
    @apply text-base m-0;
}
.plan-card p {
    @apply m-0 whitespace-pre-wrap;
}
.plan-footer {
    @apply flex flex-wrap items-center justify-between gap-3 [border-top:0.0625rem_solid_var(--scova-border)] pt-3;
}
.dismiss {
    @apply flex items-center justify-center min-h-11 min-w-11 text-default bg-transparent border-0 rounded-2 cursor-pointer keyboard-focus-wide;
}
.budget-grid {
    @apply grid grid-cols-[repeat(auto-fit,_minmax(min(100%,_9rem),_1fr))] gap-3;
}
.budget-grid dd {
    @apply m-0;
}
summary {
    @apply cursor-pointer min-h-11 flex items-center keyboard-focus-wide;
}
@media (max-width: 39.999rem) {
    .plan-footer :deep(.scova-action-button) {
        @apply flex-1;
    }
}
</style>
