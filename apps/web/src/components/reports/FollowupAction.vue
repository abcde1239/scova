<template>
    <section
        ref="root"
        class="followup scova-question-tools"
        :aria-label="revision ? '基于现有资料生成新版报告' : '问题的后续研究'"
        tabindex="-1"
    >
        <h3>{{ revision ? '生成新版报告' : '后续研究' }}</h3>
        <p v-if="!state.available.value">
            报告或回答当前不可读取。已有未知请求会保留，恢复后才能确认或读取关联。
        </p>
        <action-button v-if="state.canOpen.value" @click="open">{{
            revision ? '基于现有资料生成新版报告' : '确认后建立独立后续执行'
        }}</action-button>
        <p v-if="state.available.value && report?.mode === 'demo' && !state.candidateId.value">
            历史演示报告仅供查阅，请从任务页启动真实研究。
        </p>
        <p v-if="state.message.value" role="status">{{ state.message.value }}</p>
        <template v-if="state.protectedState.value">
            <p>离开或刷新会清除此页面的原请求标识；取消客户端读取不代表服务器回滚。</p>
            <div class="followup-actions">
                <action-button
                    :disabled="!state.available.value || state.pending.value"
                    :busy="state.pending.value"
                    @click="state.recover"
                    >读取已保存关联</action-button
                >
                <action-button
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
                v-if="state.parentQuery.isFetching.value || state.linkedQuery.isFetching.value"
                role="status"
            >
                正在核验已保存的关联执行。
            </p>
            <p
                v-if="state.parentQuery.isError.value || state.linkedQuery.isError.value"
                role="alert"
            >
                关联执行暂时无法核验，请重新读取。
            </p>
            <action-button
                v-if="state.parentQuery.isError.value || state.linkedQuery.isError.value"
                :disabled="state.parentQuery.isFetching.value || state.linkedQuery.isFetching.value"
                @click="readLinked"
                >重新读取关联执行</action-button
            >
            <p v-if="state.linkedRun.value">
                关联执行：{{ state.linkedRun.value.mode === 'demo' ? '演示 demo' : '真实 live' }} ·
                {{ executionStates[state.linkedRun.value.status][0] }}
            </p>
            <router-link v-if="state.linkedId.value" :to="`/runs/${state.linkedId.value}`"
                >查看关联执行</router-link
            >
        </template>
        <dialog
            ref="dialog"
            class="followup-dialog"
            :aria-labelledby="`${dialogId}-title`"
            :aria-describedby="`${dialogId}-consequences`"
            @cancel.prevent="cancel"
        >
            <header>
                <h3 :id="`${dialogId}-title`">
                    {{ revision ? '确认生成新版报告' : '确认建立独立后续执行' }}
                </h3>
            </header>
            <div class="dialog-body">
                <p :id="`${dialogId}-consequences`">
                    {{
                        revision
                            ? '使用原报告已保存的证据及本轮对话生成新版报告，不搜索网页或重新抓取来源；会使用模型额度。'
                            : '将为这个已保存的问题建立独立后续执行，携带报告与本轮对话上下文，可能调用搜索与模型并使用服务额度。'
                    }}沿用原报告的配置版本与预算上限，以问题原文为目标，清空重点条目并改为手动执行。原报告与任务配置版本保留，原任务计划不改，普通监控基线不变。
                </p>
                <p class="question-text">{{ question?.question }}</p>
                <output-format-select
                    v-model="formats"
                    label="本次成果形式"
                    :allow-empty="true"
                    :disabled="state.pending.value"
                />
                <p v-if="revision">修订只使用保存证据，所选形式缺少的材料会明确说明。</p>
                <p v-if="state.parentQuery.isFetching.value" role="status">
                    正在读取原报告执行的模式与预算。
                </p>
                <template v-if="state.parent.value">
                    <p>
                        {{
                            revision
                                ? '仅使用现有证据，模型生成会计量；页面额度用于读取保存证据。'
                                : '真实研究可能调用已配置的搜索与模型并使用服务额度。'
                        }}
                    </p>
                    <dl>
                        <div>
                            <dt>原配置版本</dt>
                            <dd>{{ state.parent.value.taskVersionId }}</dd>
                        </div>
                        <div>
                            <dt>搜索上限</dt>
                            <dd>{{ revision ? 0 : state.parent.value.budget.maxSearches }} 次</dd>
                        </div>
                        <div>
                            <dt>页面读取上限</dt>
                            <dd>{{ state.parent.value.budget.maxPages }} 页</dd>
                        </div>
                        <div>
                            <dt>执行时长上限</dt>
                            <dd>{{ state.parent.value.budget.maxDurationSeconds }} 秒</dd>
                        </div>
                        <div>
                            <dt>输入 token 上限</dt>
                            <dd>{{ state.parent.value.budget.maxInputTokens }}</dd>
                        </div>
                        <div>
                            <dt>输出 token 上限</dt>
                            <dd>{{ state.parent.value.budget.maxOutputTokens }}</dd>
                        </div>
                    </dl>
                </template>
                <template
                    v-if="
                        state.parentQuery.isError.value ||
                        (!state.parentQuery.isFetching.value && !state.parent.value)
                    "
                >
                    <p role="alert">原执行暂不可读取或与报告不一致，不能确认创建。</p>
                    <action-button
                        :disabled="state.pending.value"
                        @click="state.parentQuery.refetch()"
                        >重新读取原执行</action-button
                    >
                </template>
            </div>
            <footer class="followup-actions">
                <button
                    type="button"
                    :id="`${dialogId}-cancel`"
                    :disabled="state.pending.value"
                    @click="cancel"
                >
                    取消
                </button>
                <action-button
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

<style scoped>
.followup,
.dialog-body {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.followup {
    padding-block-start: 1.5rem;
    border-block-start: 0.0625rem solid var(--scova-border);
    cursor: default;
}
h3,
p {
    margin: 0;
}
h3 {
    font-size: 1.125rem;
}
.followup > :deep(.scova-action-button),
a {
    justify-self: start;
}
.followup-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    min-inline-size: 0;
}
.followup-dialog {
    box-sizing: border-box;
    inline-size: min(42rem, calc(100% - 2rem));
    max-inline-size: calc(100% - 2rem);
    max-block-size: calc(100dvh - 2rem);
    margin: auto;
    padding: 0;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.75rem;
    color: var(--scova-text);
    background: var(--scova-surface);
    font-family: var(--scova-font-interface);
    overflow: hidden;
    cursor: default;
}
.followup-dialog[open] {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
}
.followup-dialog::backdrop {
    background: rgb(0 0 0 / 45%);
}
.followup-dialog header,
.followup-dialog footer {
    padding: 1rem;
    min-inline-size: 0;
}
.followup-dialog header {
    border-block-end: 0.0625rem solid var(--scova-border);
}
.followup-dialog footer {
    border-block-start: 0.0625rem solid var(--scova-border);
}
.dialog-body {
    overflow-y: auto;
    min-block-size: 0;
    padding: 1rem;
    overscroll-behavior: contain;
}
.question-text {
    white-space: pre-wrap;
}
dl {
    display: grid;
    gap: 0.75rem;
    margin: 0;
}
dt {
    font-weight: 600;
}
dd {
    margin: 0;
}
button {
    min-block-size: 2.75rem;
    min-inline-size: 2.75rem;
    max-inline-size: 100%;
    padding: 0.625rem 1rem;
    background: var(--scova-surface);
    color: var(--scova-text);
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.5rem;
    font: inherit;
    cursor: pointer;
    overflow-wrap: anywhere;
}
button:disabled {
    cursor: not-allowed;
}
a {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    color: var(--scova-primary);
    cursor: pointer;
    text-underline-offset: 0.2em;
}
button:focus-visible,
a:focus-visible,
.followup:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
</style>
