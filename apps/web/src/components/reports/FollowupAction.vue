<template>
    <section
        ref="root"
        class="followup scova-question-tools layout-stack break-anywhere pt-6 [border-top:0.0625rem_solid_var(--scova-border)] cursor-default keyboard-focus-wide [&.followup_>_.scova-action-button]:justify-self-start"
        :aria-label="revision ? '基于现有资料生成新版报告' : '问题的后续研究'"
        tabindex="-1"
    >
        <h3 class="text-[1.125rem] m-0">{{ revision ? '生成新版报告' : '后续研究' }}</h3>
        <p class="m-0" v-if="!state.available.value">
            报告或回答当前不可读取。已有未知请求会保留，恢复后才能确认或读取关联。
        </p>
        <action-button
            class="min-h-11 min-w-11 max-w-full bg-surface text-default border-theme rounded-2 font-inherit cursor-pointer break-anywhere py-2.5 px-4 keyboard-focus-wide disabled:cursor-not-allowed"
            v-if="state.canOpen.value"
            @click="open"
            >{{ revision ? '基于现有资料生成新版报告' : '确认后建立独立后续执行' }}</action-button
        >
        <p
            class="m-0"
            v-if="state.available.value && report?.mode === 'demo' && !state.candidateId.value"
        >
            历史演示报告仅供查阅，请从任务页启动真实研究。
        </p>
        <p class="m-0" v-if="state.message.value" role="status">{{ state.message.value }}</p>
        <template v-if="state.protectedState.value">
            <p class="m-0">离开或刷新会清除此页面的原请求标识；取消客户端读取不代表服务器回滚。</p>
            <div class="followup-actions action-row min-w-0">
                <action-button
                    class="min-h-11 min-w-11 max-w-full bg-surface text-default border-theme rounded-2 font-inherit cursor-pointer break-anywhere py-2.5 px-4 keyboard-focus-wide disabled:cursor-not-allowed"
                    :disabled="!state.available.value || state.pending.value"
                    :busy="state.pending.value"
                    @click="state.recover"
                    >读取已保存关联</action-button
                >
                <action-button
                    class="min-h-11 min-w-11 max-w-full bg-surface text-default border-theme rounded-2 font-inherit cursor-pointer break-anywhere py-2.5 px-4 keyboard-focus-wide disabled:cursor-not-allowed"
                    v-if="state.phase.value === 'uncertain'"
                    :disabled="!state.available.value || state.pending.value"
                    :busy="state.pending.value"
                    @click="state.replay"
                    >使用同一请求重发</action-button
                >
            </div>
        </template>
        <template v-if="state.available.value && state.candidateId.value">
            <p
                class="m-0"
                v-if="state.parentQuery.isFetching.value || state.linkedQuery.isFetching.value"
                role="status"
            >
                正在核验已保存的关联执行。
            </p>
            <p
                class="m-0"
                v-if="state.parentQuery.isError.value || state.linkedQuery.isError.value"
                role="alert"
            >
                关联执行暂时无法核验，请重新读取。
            </p>
            <action-button
                class="min-h-11 min-w-11 max-w-full bg-surface text-default border-theme rounded-2 font-inherit cursor-pointer break-anywhere py-2.5 px-4 keyboard-focus-wide disabled:cursor-not-allowed"
                v-if="state.parentQuery.isError.value || state.linkedQuery.isError.value"
                :disabled="state.parentQuery.isFetching.value || state.linkedQuery.isFetching.value"
                @click="readLinked"
                >重新读取关联执行</action-button
            >
            <p class="m-0" v-if="state.linkedRun.value">
                关联执行：{{ state.linkedRun.value.mode === 'demo' ? '演示 demo' : '真实 live' }} ·
                {{ executionStates[state.linkedRun.value.status][0] }}
            </p>
            <router-link
                class="justify-self-start inline-flex items-center min-h-11 text-primary cursor-pointer underline-offset-[0.2em] keyboard-focus-wide"
                v-if="state.linkedId.value"
                :to="`/runs/${state.linkedId.value}`"
                >查看关联执行</router-link
            >
        </template>
        <dialog
            ref="dialog"
            class="followup-dialog box-border w-[min(42rem,_calc(100%_-_2rem))] max-w-[calc(100%_-_2rem)] max-h-[calc(100dvh_-_2rem)] border-theme rounded-3 text-default bg-surface [font-family:var(--scova-font-interface)] overflow-hidden cursor-default m-[auto] p-0 [&.followup-dialog[open]]:(grid grid-rows-[auto_minmax(0,_1fr)_auto]) [&.followup-dialog::backdrop]:[background:rgb(0_0_0_/_45%)]"
            :aria-labelledby="`${dialogId}-title`"
            :aria-describedby="`${dialogId}-consequences`"
            @cancel.prevent="cancel"
        >
            <header
                class="[.followup-dialog_&:is(header)]:(min-w-0 [border-bottom:0.0625rem_solid_var(--scova-border)] p-4)"
            >
                <h3 class="text-[1.125rem] m-0" :id="`${dialogId}-title`">
                    {{ revision ? '确认生成新版报告' : '确认建立独立后续执行' }}
                </h3>
            </header>
            <div
                class="dialog-body layout-stack break-anywhere [overflow-y:auto] min-h-0 [overscroll-behavior:contain] p-4"
            >
                <p class="m-0" :id="`${dialogId}-consequences`">
                    {{
                        revision
                            ? '使用原报告已保存的证据及本轮对话生成新版报告，不搜索网页或重新抓取来源；会使用模型额度。'
                            : '将为这个已保存的问题建立独立后续执行，携带报告与本轮对话上下文，可能调用搜索与模型并使用服务额度。'
                    }}沿用原报告的配置版本与预算上限，以问题原文为目标，清空重点条目并改为手动执行。原报告与任务配置版本保留，原任务计划不改，普通监控基线不变。
                </p>
                <p class="question-text whitespace-pre-wrap m-0">{{ question?.question }}</p>
                <output-format-select
                    v-model="formats"
                    label="本次成果形式"
                    :allow-empty="true"
                    :disabled="state.pending.value"
                />
                <p class="m-0" v-if="revision">
                    修订只使用保存证据，所选形式缺少的材料会明确说明。
                </p>
                <p class="m-0" v-if="state.parentQuery.isFetching.value" role="status">
                    正在读取原报告执行的模式与预算。
                </p>
                <template v-if="state.parent.value">
                    <p class="m-0">
                        {{
                            revision
                                ? '仅使用现有证据，模型生成会计量；页面额度用于读取保存证据。'
                                : '真实研究可能调用已配置的搜索与模型并使用服务额度。'
                        }}
                    </p>
                    <dl class="grid gap-3 m-0">
                        <div>
                            <dt class="font-semibold">原配置版本</dt>
                            <dd class="m-0">{{ state.parent.value.taskVersionId }}</dd>
                        </div>
                        <div>
                            <dt class="font-semibold">搜索上限</dt>
                            <dd class="m-0">
                                {{ revision ? 0 : state.parent.value.budget.maxSearches }} 次
                            </dd>
                        </div>
                        <div>
                            <dt class="font-semibold">页面读取上限</dt>
                            <dd class="m-0">{{ state.parent.value.budget.maxPages }} 页</dd>
                        </div>
                        <div>
                            <dt class="font-semibold">执行时长上限</dt>
                            <dd class="m-0">
                                {{ state.parent.value.budget.maxDurationSeconds }} 秒
                            </dd>
                        </div>
                        <div>
                            <dt class="font-semibold">输入 token 上限</dt>
                            <dd class="m-0">{{ state.parent.value.budget.maxInputTokens }}</dd>
                        </div>
                        <div>
                            <dt class="font-semibold">输出 token 上限</dt>
                            <dd class="m-0">{{ state.parent.value.budget.maxOutputTokens }}</dd>
                        </div>
                    </dl>
                </template>
                <template
                    v-if="
                        state.parentQuery.isError.value ||
                        (!state.parentQuery.isFetching.value && !state.parent.value)
                    "
                >
                    <p class="m-0" role="alert">原执行暂不可读取或与报告不一致，不能确认创建。</p>
                    <action-button
                        class="min-h-11 min-w-11 max-w-full bg-surface text-default border-theme rounded-2 font-inherit cursor-pointer break-anywhere py-2.5 px-4 keyboard-focus-wide disabled:cursor-not-allowed"
                        :disabled="state.pending.value"
                        @click="state.parentQuery.refetch()"
                        >重新读取原执行</action-button
                    >
                </template>
            </div>
            <footer
                class="followup-actions action-row min-w-0 [.followup-dialog_&:is(footer)]:(min-w-0 [border-top:0.0625rem_solid_var(--scova-border)] p-4)"
            >
                <button
                    class="min-h-11 min-w-11 max-w-full bg-surface text-default border-theme rounded-2 font-inherit cursor-pointer break-anywhere py-2.5 px-4 keyboard-focus-wide disabled:cursor-not-allowed"
                    type="button"
                    :id="`${dialogId}-cancel`"
                    :disabled="state.pending.value"
                    @click="cancel"
                >
                    取消
                </button>
                <action-button
                    class="min-h-11 min-w-11 max-w-full bg-surface text-default border-theme rounded-2 font-inherit cursor-pointer break-anywhere py-2.5 px-4 keyboard-focus-wide disabled:cursor-not-allowed"
                    :disabled="
                        !state.parent.value ||
                        !state.available.value ||
                        state.pending.value ||
                        state.parentQuery.isFetching.value
                    "
                    :busy="state.pending.value"
                    @click="state.confirm"
                    >{{ revision ? '确认并生成新版报告' : '确认并建立后续执行' }}</action-button
                >
            </footer>
        </dialog>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch, useId } from 'vue';
import { RouterLink } from 'vue-router';
import type { Report, ReportQuestion, OutputFormat } from '@scova/models';
import OutputFormatSelect from '@/components/tasks/OutputFormatSelect.vue';
import ActionButton from '@/components/common/ActionButton.vue';
import { useFollowup } from '@/composables/useFollowup';
import { executionStates } from '@/composables/useExecution';
const props = defineProps<{
    reportId: string;
    questionId: string;
    report?: Report;
    question?: ReportQuestion;
    operation?: 'research' | 'revise';
}>();
const emit = defineEmits<{ protectedChange: [value: boolean]; linkedChange: [value: boolean] }>();
const revision = computed(() => props.operation === 'revise');
const dialogId = `followup-${useId()}`;
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
const dialog = ref<HTMLDialogElement>();
let trigger: HTMLElement | undefined;
function open(event: MouseEvent) {
    trigger = event.currentTarget as HTMLElement;
    state.open();
}
function cancel() {
    state.close();
}
async function readLinked() {
    await state.parentQuery.refetch({ cancelRefetch: false });
    if (state.parent.value) await state.linkedQuery.refetch({ cancelRefetch: false });
}
watch(state.opened, async (opened) => {
    await nextTick();
    if (opened && state.opened.value && dialog.value?.isConnected) {
        dialog.value.showModal();
        dialog.value.querySelector<HTMLButtonElement>(`#${CSS.escape(dialogId)}-cancel`)?.focus();
    } else if (!state.opened.value && dialog.value?.open) {
        dialog.value.close();
        await nextTick();
        if (trigger?.isConnected) trigger.focus();
        else root.value?.focus();
    }
});
watch(state.protectedState, (value) => emit('protectedChange', value), {
    immediate: true,
    flush: 'sync',
});
watch(
    () => !!state.candidateId.value,
    (value) => emit('linkedChange', value),
    { immediate: true, flush: 'sync' },
);
onUnmounted(() => {
    emit('protectedChange', false);
    emit('linkedChange', false);
});
</script>
