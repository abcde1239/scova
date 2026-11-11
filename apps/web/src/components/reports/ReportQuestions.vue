<template>
    <section ref="panel" class="questions scova-question-tools" aria-labelledby="questions-title">
        <h2 id="questions-title"><app-icon name="question" />报告内问答</h2>
        <p>
            围绕这份报告连续讨论，历史会自动保存。提问仅查阅已有证据；生成新版与联网补充需单独确认。
        </p>
        <p v-if="state.conversation.isPending.value" role="status">正在读取对话历史</p>
        <div v-if="state.available.value && state.conversation.isError.value" role="alert">
            对话历史暂时无法读取，发送已暂停。
            <button type="button" @click="state.conversation.refetch()">重新读取对话历史</button>
        </div>
        <div
            v-if="report && state.available.value"
            class="conversation-history"
            aria-label="已保存的对话历史"
        >
            <button
                v-if="state.conversation.hasNextPage.value"
                type="button"
                :disabled="state.conversation.isFetchingNextPage.value"
                @click="state.conversation.fetchNextPage()"
            >
                {{ state.conversation.isFetchingNextPage.value ? '正在读取' : '查看更早的对话' }}
            </button>
            <report-conversation-turn
                v-for="turn in state.turns.value.filter(
                    (item) => item.id !== state.selectedId.value,
                )"
                :key="turn.id"
                :turn="turn"
                :report="report"
                @select="selectTurn"
            />
        </div>
        <div
            v-if="state.available.value && state.conversationData.value?.artifacts?.length"
            class="conversation-artifacts"
            aria-label="对话生成的报告"
        >
            <router-link
                v-for="artifact in state.conversationData.value.artifacts"
                :key="artifact.reportId"
                :to="`/reports/${artifact.reportId}`"
                class="conversation-artifact"
            >
                <app-icon name="report" /><span
                    >{{ artifact.operation === 'revise' ? '新版报告' : '补充研究成果' }}：{{
                        artifact.title
                    }}</span
                ><span>打开成果</span>
            </router-link>
        </div>
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
                        <small v-if="statement.kind === 'inference'">基于证据的解释与归纳</small>
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
        <followup-action
            v-if="state.answer.value && state.available.value"
            :key="`revision-${state.selectedId.value}`"
            operation="revise"
            :report-id="reportId"
            :question-id="state.selectedId.value"
            :report="report"
            :question="state.answer.value"
            @protected-change="revisionProtected = $event"
        />
        <action-button
            v-if="state.selectedId.value || state.address.value.error"
            :disabled="state.pending.value"
            @click="startNew"
            >提出新问题</action-button
        >
        <form class="question-form" @submit.prevent="submit">
            <label for="report-question">问题</label>
            <textarea
                id="report-question"
                v-model="state.draft.value"
                rows="5"
                :readonly="!!state.attempt.value || state.pending.value || !state.available.value"
                :aria-invalid="state.draft.value !== '' && !!textError ? 'true' : undefined"
                aria-describedby="question-input-help"
            />
            <p id="question-input-help">最多 2000 个 UTF-16 码元；问题按原文提交。</p>
            <p>回答会结合最近对话和更早的简要记录；久远或不明确的指代请写出具体内容。</p>
            <p v-if="state.draft.value !== '' && textError" role="alert">{{ textError }}</p>
            <div class="question-actions">
                <action-button
                    v-if="!state.attempt.value"
                    attr-type="submit"
                    :disabled="!state.canSubmit.value || followupProtected || revisionProtected"
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
                <button v-if="state.pending.value" type="button" @click="state.cancelPending">
                    停止等待
                </button>
            </div>
        </form>
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
import ReportConversationTurn from '@/components/reports/ReportConversationTurn.vue';
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
const revisionProtected = ref(false);
const protectedState = computed(
    () => state.protectedState.value || followupProtected.value || revisionProtected.value,
);
watch(
    () => `${lifecycle.session.epoch}:${props.reportId}:${state.selectedId.value}`,
    () => {
        followupProtected.value = false;
        followupLinked.value = false;
        revisionProtected.value = false;
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
async function selectTurn(id: string) {
    if (state.pending.value || !confirmDiscard()) return;
    await selectSaved(id);
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
    if (followupProtected.value || revisionProtected.value) return;
    return perform(state.submit);
}
function recover() {
    return perform(state.recover);
}
function confirmDiscard() {
    if (!lifecycle.session.user || !protectedState.value) return true;
    return window.confirm(
        followupProtected.value || revisionProtected.value
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
/* Scoped UnoCSS keeps the long control/state combinations readable. */
h2 {
    @apply flex items-center gap-2;
}
.questions,
.question-form,
.question-result,
.question-state,
.statement,
.question-citation {
    @apply layout-stack break-anywhere;
}
.questions {
    @apply w-[min(100%,_45rem)] gap-6 pt-8 [border-top:0.0625rem_solid_var(--scova-border)];
}
.conversation-history,
.conversation-artifacts {
    @apply layout-stack;
}
.conversation-artifact {
    @apply action-row min-h-11 border-theme rounded-3 text-primary break-anywhere p-4;
}
.conversation-artifact:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
h2,
h3,
p {
    @apply m-0;
}
h2 {
    @apply text-[1.25rem] font-semibold;
}
h3 {
    @apply text-[1.125rem] font-semibold;
}
textarea {
    @apply box-border w-full min-w-0 min-h-[8rem] border-theme rounded-2 text-default bg-surface
        [font-family:inherit] [font-size:inherit] [font-weight:inherit] [font-style:inherit]
        leading-[1.75] [font-variant:inherit] [resize:none] [cursor:text] p-3;
}
textarea:focus-visible,
h3:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
.question-actions {
    @apply action-group items-start;
}
.questions button {
    @apply font-inherit min-h-11 min-w-11 max-w-full pt-2.5 pr-4 pb-2.5 pl-4 border-theme rounded-2
        bg-surface text-primary cursor-pointer break-anywhere;
}
.questions button:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
.question-starters {
    @apply flex flex-wrap gap-2;
}
.question-starters button {
    @apply font-inherit min-w-0 max-w-full min-h-11 pt-2 pr-3 pb-2 pl-3 border-theme rounded-3
        bg-surface text-primary text-start break-anywhere cursor-pointer;
}
.question-starters button:hover {
    @apply [background:var(--scova-selected)];
}
.question-starters button:focus-visible {
    @apply [outline:0.125rem_solid_var(--scova-primary)] [outline-offset:0.25rem];
}
.question-message {
    @apply grid gap-2 rounded-3 [background:var(--scova-selected)] p-4;
}
.message-label {
    @apply text-muted text-[0.875rem];
}
.question-text,
blockquote {
    @apply whitespace-pre-wrap;
}
blockquote {
    @apply [border-left:0.1875rem_solid_var(--scova-primary)] [background:var(--scova-selected)] m-0 p-3;
}
.statements {
    @apply grid gap-8 list-none m-0 p-0;
}
.question-usage {
    @apply flex flex-wrap gap-[1rem_2rem] [font-variant-numeric:tabular-nums] m-0;
}
dt {
    @apply font-medium;
}
dd {
    @apply m-0;
}
.question-citation :deep(blockquote) {
    @apply p-3;
}
.question-citation :deep(.evidence-body) {
    @apply pl-3 pr-3;
}
@media (max-width: 40rem) {
    .question-citation :deep(.evidence-body),
    .question-citation :deep(blockquote) {
        @apply pl-2 pr-2;
    }
}
</style>
