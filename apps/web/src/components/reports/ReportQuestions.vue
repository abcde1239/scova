<template>
    <section ref="panel" class="questions scova-question-tools" aria-labelledby="questions-title">
        <h2 id="questions-title"><app-icon name="question" />报告内问答</h2>
        <p>仅查阅这份报告已保存的证据；提问不会搜索网页或启动新的研究。</p>
        <p v-if="!state.available.value" role="status">
            报告当前无法读取。本地问题仍可复制；报告恢复后才能提问或读取回答。
        </p>
        <p v-if="state.address.value.error" role="alert">{{ state.address.value.error }}</p>
        <div
            v-if="
                state.available.value &&
                !state.selectedId.value &&
                !state.attempt.value &&
                !state.draft.value &&
                !state.address.value.error
            "
            class="question-starters"
            aria-label="提问建议"
        >
            <button type="button" @click="prepareQuestion('请总结这份报告的主要发现。')">
                总结主要发现
            </button>
            <button type="button" @click="prepareQuestion('哪些来源支持报告的主要结论？')">
                查看结论依据
            </button>
        </div>
        <form
            v-if="!state.selectedId.value || (!state.available.value && state.draft.value)"
            class="question-form"
            @submit.prevent="submit"
        >
            <label for="report-question">问题</label>
            <textarea
                id="report-question"
                v-model="state.draft.value"
                rows="5"
                :readonly="
                    !!state.selectedId.value ||
                    !!state.attempt.value ||
                    state.pending.value ||
                    !state.available.value
                "
                :aria-invalid="state.draft.value !== '' && !!textError ? 'true' : undefined"
                aria-describedby="question-input-help"
            />
            <p id="question-input-help">最多 2000 个 UTF-16 码元；问题按原文提交。</p>
            <p v-if="state.draft.value !== '' && textError" role="alert">{{ textError }}</p>
            <div v-if="!state.selectedId.value" class="question-actions">
                <action-button
                    v-if="!state.attempt.value"
                    attr-type="submit"
                    :disabled="!state.canSubmit.value"
                    :busy="state.pending.value"
                    >提问</action-button
                >
                <action-button
                    v-if="state.attempt.value"
                    :disabled="!state.canRecover.value"
                    :busy="state.pending.value"
                    @click="recover"
                    >读取本次结果</action-button
                >
                <action-button
                    v-if="state.attempt.value || state.draft.value"
                    :disabled="state.pending.value"
                    @click="startNew"
                    >{{ state.attempt.value ? '结束本次请求' : '清空问题' }}</action-button
                >
            </div>
        </form>
        <p v-if="state.notice.value" role="status">{{ state.notice.value }}</p>
        <p v-if="state.retryAt.value !== undefined">
            服务提供的再次读取时间：<time :datetime="new Date(state.retryAt.value).toISOString()">{{
                new Date(state.retryAt.value).toLocaleString()
            }}</time
            >{{
                state.waiting.value ? '，请稍后读取。' : '，现在可明确读取。'
            }}读取可能返回已保存结果，不代表重新调用模型。
        </p>
        <template
            v-if="state.selectedId.value && state.available.value && !state.address.value.error"
        >
            <p v-if="state.query.isPending.value" role="status">正在读取已保存回答</p>
            <div v-else-if="!state.answer.value" class="question-state">
                <p role="alert">{{ state.readError.value }}</p>
                <action-button
                    :disabled="!state.canRecover.value || state.query.isFetching.value"
                    :busy="state.query.isFetching.value"
                    @click="recover"
                    >读取本次结果</action-button
                >
            </div>
            <article v-else class="question-result" aria-labelledby="question-result-title">
                <div class="question-message question-message--user">
                    <p class="message-label">你的问题</p>
                    <p class="question-text">{{ state.answer.value.question }}</p>
                </div>
                <h3 id="question-result-title" tabindex="-1">
                    {{
                        state.answer.value.answer.status === 'answered'
                            ? '证据回答'
                            : '未获得可核验回答'
                    }}
                </h3>
                <p>{{ questionReasons[state.answer.value.answer.reason] }}</p>
                <ol v-if="state.answer.value.answer.statements.length" class="statements">
                    <li
                        v-for="(statement, index) in state.answer.value.answer.statements"
                        :key="index"
                        class="statement"
                    >
                        <p class="question-text">{{ statement.text }}</p>
                        <div
                            v-for="(citation, citationIndex) in statement.citations"
                            :key="`${citation.evidenceId}-${citationIndex}`"
                            class="question-citation"
                        >
                            <p>证据 {{ citation.evidenceId }}</p>
                            <blockquote>{{ citation.quote }}</blockquote>
                            <evidence-citation
                                v-if="evidence(citation.evidenceId)"
                                :evidence="evidence(citation.evidenceId)!"
                            />
                        </div>
                    </li>
                </ol>
                <p v-if="state.answer.value.answer.needsResearch">
                    仍需更多资料。{{
                        followupLinked
                            ? '这个问题已有关联后续执行，见下方操作。'
                            : followupProtected
                              ? '后续执行结果尚未确认，请保留原请求。'
                              : '本次没有启动后续研究。'
                    }}
                </p>
                <dl class="question-usage" aria-label="本次独立问答用量">
                    <div>
                        <dt>模型尝试</dt>
                        <dd>{{ state.answer.value.answer.usage.attempts }} 次</dd>
                    </div>
                    <div>
                        <dt>输入 token</dt>
                        <dd>{{ state.answer.value.answer.usage.inputTokens }}</dd>
                    </div>
                    <div>
                        <dt>输出 token</dt>
                        <dd>{{ state.answer.value.answer.usage.outputTokens }}</dd>
                    </div>
                </dl>
                <p>
                    {{
                        state.answer.value.answer.usage.estimated
                            ? '以上含保守估算或未知调用预留，并非精确扣款。'
                            : '以上为本次问答记录的用量。'
                    }}不计入原报告 Run 预算。
                </p>
            </article>
        </template>
        <followup-action
            v-if="state.selectedId.value && !state.address.value.error"
            :key="state.selectedId.value"
            :report-id="reportId"
            :question-id="state.selectedId.value"
            :report="report"
            :question="state.answer.value"
            @protected-change="followupProtected = $event"
            @linked-change="followupLinked = $event"
        />
        <action-button
            v-if="state.selectedId.value || state.address.value.error"
            :disabled="state.pending.value"
            @click="startNew"
            >提出新问题</action-button
        >
    </section>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import type { Report } from '@scova/models';
import ActionButton from '@/components/common/ActionButton.vue';
import EvidenceCitation from '@/components/reports/EvidenceCitation.vue';
import FollowupAction from '@/components/reports/FollowupAction.vue';
import { useReportQuestions } from '@/composables/useReportQuestions';
import { useSessionLifecycle } from '@/composables/useSessionQuery';
import { questionReasons, questionTextError } from '@/utils/report-questions';
const props = defineProps<{ reportId: string; report?: Report }>();
const route = useRoute();
const router = useRouter();
const lifecycle = useSessionLifecycle();
const state = useReportQuestions(
    () => props.reportId,
    () => props.report,
    () => route.query.questionId,
    lifecycle,
);
const panel = ref<HTMLElement>();
const followupProtected = ref(false);
const followupLinked = ref(false);
const protectedState = computed(() => state.protectedState.value || followupProtected.value);
watch(
    () => `${lifecycle.session.epoch}:${props.reportId}:${state.selectedId.value}`,
    () => {
        followupProtected.value = false;
        followupLinked.value = false;
    },
    { flush: 'sync' },
);
const textError = computed(() => questionTextError(state.draft.value));
async function prepareQuestion(question: string) {
    state.draft.value = question;
    await nextTick();
    panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}
let internalDestination = '';
let mounted = true;
function evidence(id: string) {
    return props.report?.evidence.find((item) => item.id.toLowerCase() === id.toLowerCase());
}
async function selectSaved(id?: string) {
    const query = { ...route.query };
    if (id) query.questionId = id;
    else delete query.questionId;
    const destination = { path: route.path, query, hash: route.hash };
    internalDestination = router.resolve(destination).fullPath;
    try {
        await router.replace(destination);
    } finally {
        internalDestination = '';
    }
}
async function perform(action: () => Promise<string | undefined>) {
    const scope = lifecycle.capture();
    const path = route.fullPath;
    const id = await action();
    if (!mounted || !scope.isCurrent() || route.fullPath !== path || !id) return;
    await selectSaved(id);
    await nextTick();
    panel.value?.querySelector<HTMLElement>('#question-result-title')?.focus();
}
function submit() {
    return perform(state.submit);
}
function recover() {
    return perform(state.recover);
}
function confirmDiscard() {
    if (!lifecycle.session.user || !protectedState.value) return true;
    return window.confirm(
        followupProtected.value
            ? '后续执行结果尚未确认，服务端可能已经创建执行。离开或提出新问题会清除此页面的原请求标识，无法在此使用同一请求恢复；取消客户端读取不代表回滚。仍要继续吗？'
            : state.attempt.value
              ? '本次结果尚未确认，服务端可能仍在处理或已经保存回答。请先复制问题。结束或离开后无法凭此页面恢复未知请求；再次提问可能另计用量。仍要继续吗？'
              : '尚有本地问题未提交，请先复制需要保留的内容。仍要清空或离开吗？',
    );
}
async function startNew() {
    if (state.pending.value || !confirmDiscard()) return;
    await selectSaved();
    state.newQuestion();
    await nextTick();
    panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}
onBeforeRouteLeave(confirmDiscard);
onBeforeRouteUpdate((to) => to.fullPath === internalDestination || confirmDiscard());
function beforeUnload(event: BeforeUnloadEvent) {
    if (protectedState.value) {
        event.preventDefault();
        event.returnValue = '';
    }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onUnmounted(() => {
    mounted = false;
    window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<style scoped>
h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.questions,
.question-form,
.question-result,
.question-state,
.statement,
.question-citation {
    display: grid;
    gap: 1rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.questions {
    inline-size: min(100%, 45rem);
    gap: 1.5rem;
    padding-block-start: 2rem;
    border-block-start: 0.0625rem solid var(--scova-border);
}
h2,
h3,
p {
    margin: 0;
}
h2 {
    font-size: 1.25rem;
    font-weight: 600;
}
h3 {
    font-size: 1.125rem;
    font-weight: 600;
}
textarea {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    min-block-size: 8rem;
    padding: 0.75rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.5rem;
    color: var(--scova-text);
    background: var(--scova-surface);
    font: inherit;
    line-height: 1.75;
    resize: vertical;
    cursor: text;
}
textarea:focus-visible,
h3:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.question-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: start;
}
.question-starters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}
.question-starters button {
    min-inline-size: 0;
    max-inline-size: 100%;
    min-block-size: 2.75rem;
    padding: 0.5rem 0.75rem;
    border: 0.0625rem solid var(--scova-border);
    border-radius: 0.75rem;
    background: var(--scova-surface);
    color: var(--scova-primary);
    font: inherit;
    text-align: start;
    overflow-wrap: anywhere;
    cursor: pointer;
}
.question-starters button:hover {
    background: var(--scova-selected);
}
.question-starters button:focus-visible {
    outline: 0.125rem solid var(--scova-primary);
    outline-offset: 0.25rem;
}
.question-message {
    display: grid;
    gap: 0.5rem;
    padding: 1rem;
    border-radius: 0.75rem;
    background: var(--scova-selected);
}
.message-label {
    color: var(--scova-muted);
    font-size: 0.875rem;
}
.question-text,
blockquote {
    white-space: pre-wrap;
}
blockquote {
    margin: 0;
    padding: 0.75rem;
    border-inline-start: 0.1875rem solid var(--scova-primary);
    background: var(--scova-selected);
}
.statements {
    padding: 0;
    margin: 0;
    display: grid;
    gap: 2rem;
    list-style: none;
}
.question-usage {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 2rem;
    margin: 0;
    font-variant-numeric: tabular-nums;
}
dt {
    font-weight: 500;
}
dd {
    margin: 0;
}
.question-citation :deep(blockquote) {
    padding: 0.75rem;
}
.question-citation :deep(.evidence-body) {
    padding-inline: 0.75rem;
}
@media (max-width: 40rem) {
    .question-citation :deep(.evidence-body),
    .question-citation :deep(blockquote) {
        padding-inline: 0.5rem;
    }
}
</style>
