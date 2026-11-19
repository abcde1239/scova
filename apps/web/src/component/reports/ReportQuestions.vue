<template>
    <section ref="panel" class="questions scova-question-tools" aria-label="报告对话">
        <p class="context-label">
            讨论上下文：原报告。提问只查阅保存资料，不联网；问答单独计入模型额度。
        </p>
        <div v-if="activeTurns.length || activeMerge" class="run-banner" role="status">
            <span>{{ activeMerge ? '合并报告进行中' : '后续执行进行中' }}</span
            ><button
                type="button"
                @click="activeTurns.length ? jumpTurn(activeTurns[0]!) : emit('showMerge')"
            >
                查看本轮执行
            </button>
        </div>
        <div ref="timeline" class="conversation-history" aria-label="已保存的对话历史" tabindex="0">
            <p v-if="state.conversation.isPending.value" role="status">正在读取对话历史</p>
            <div v-if="state.available.value && state.conversation.isError.value" role="alert">
                对话历史暂时无法读取，发送已暂停。<button
                    type="button"
                    @click="state.conversation.refetch()"
                >
                    重新读取对话历史
                </button>
            </div>
            <button
                v-if="state.conversation.hasNextPage.value"
                type="button"
                :disabled="state.conversation.isFetchingNextPage.value"
                @click="fetchEarlier"
            >
                {{ state.conversation.isFetchingNextPage.value ? '正在读取' : '查看更早的对话' }}
            </button>
            <div
                v-if="report && state.conversation.isSuccess.value && !turns.length"
                class="conversation-empty"
            >
                <h2>从这份报告继续</h2>
                <p>解释发现、核对依据，或讨论下一步。</p>
                <div class="question-starters" aria-label="提问建议">
                    <button
                        v-for="suggestion in suggestions"
                        :key="suggestion"
                        type="button"
                        @click="prepareQuestion(suggestion)"
                    >
                        {{ suggestion }}
                    </button>
                </div>
            </div>
            <report-conversation-turn
                v-for="turn in turns"
                v-show="visibleTurn(turn.id)"
                :key="turn.id"
                :turn="turn"
                :report="visibleTurn(turn.id) ? report : undefined"
                :continuations="state.conversationData.value?.continuations"
                @protected-change="setProtected(turn.id, $event)"
                @active-change="setActive(turn.id, $event)"
                @artifact="observeArtifact"
                @open-artifact="emit('openArtifact', $event)"
                @merge="emit('merge', $event)"
            />
            <p v-if="state.pending.value" class="pending-answer" role="status">
                正在根据报告资料回答…
            </p>
            <template
                v-if="
                    state.selectedId.value &&
                    state.available.value &&
                    !state.address.value.error &&
                    !turns.some(
                        (turn) => turn.id === state.selectedId.value && visibleTurn(turn.id),
                    )
                "
                ><p v-if="state.query.isPending.value" role="status">正在读取已保存回答</p>
                <div v-else-if="!state.answer.value" role="alert">
                    <p>{{ state.readError.value }}</p>
                    <action-button
                        :disabled="!state.canRecover.value || state.query.isFetching.value"
                        @click="recover"
                        >读取本次结果</action-button
                    >
                </div></template
            >
        </div>
        <slot name="execution" />
        <p v-if="!state.available.value" role="status">
            报告当前无法读取。本地问题与未确认的请求仍保留，恢复后可继续。
        </p>
        <p v-if="state.address.value.error" role="alert">
            {{ state.address.value.error
            }}<button type="button" @click="startNew">提出新问题</button>
        </p>
        <form class="question-form" @submit.prevent="submit">
            <label class="sr-only" for="report-question">问题</label>
            <textarea
                id="report-question"
                v-model="state.draft.value"
                rows="2"
                placeholder="围绕这份报告继续提问…"
                :readonly="!!state.attempt.value || state.pending.value || !state.available.value"
                :aria-invalid="state.draft.value !== '' && !!textError ? 'true' : undefined"
                aria-describedby="question-input-help"
                @keydown.enter="onEnter"
            />
            <p v-if="state.draft.value !== '' && textError" role="alert">{{ textError }}</p>
            <p v-if="state.retryAt.value !== undefined" role="status">
                {{ state.waiting.value ? '请稍后读取，' : '现在可再次读取，' }}服务提供的时间：<time
                    :datetime="new Date(state.retryAt.value).toISOString()"
                    >{{ new Date(state.retryAt.value).toLocaleString() }}</time
                >
            </p>
            <div class="question-actions">
                <span id="question-input-help" class="text-muted text-xs"
                    >Enter 发送 · Shift + Enter 换行</span
                >
                <div class="flex flex-wrap items-center gap-2">
                    <button
                        v-if="state.attempt.value || state.draft.value"
                        type="button"
                        :disabled="state.pending.value"
                        @click="startNew"
                    >
                        {{ state.attempt.value ? '结束本次请求' : '清空问题' }}</button
                    ><button v-if="state.pending.value" type="button" @click="state.cancelPending">
                        停止等待</button
                    ><action-button
                        v-if="!state.attempt.value"
                        attr-type="submit"
                        :disabled="!state.canSubmit.value || followupProtected"
                        :busy="state.pending.value"
                        >提问</action-button
                    ><action-button
                        v-else
                        :disabled="!state.canRecover.value || followupProtected"
                        :busy="state.pending.value"
                        @click="recover"
                        >读取本次结果</action-button
                    >
                </div>
            </div>
        </form>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import type { Report, ReportConversation } from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';
import ReportConversationTurn from '@/component/reports/ReportConversationTurn.vue';
import { useReportQuestions } from '@/composable/useReportQuestions';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import { useActionNotification } from '@/composable/useActionNotification';
import { questionTextError } from '@/utils/report/questions';
import { conversationSuggestions } from '@/utils/report/conversation';
type Artifact = NonNullable<ReportConversation['artifacts']>[number];
const props = defineProps<{
    reportId: string;
    report?: Report;
    blocked?: boolean;
    activeMerge?: boolean;
}>();
const emit = defineEmits<{
    artifactsChange: [artifacts: Artifact[]];
    openArtifact: [artifact: Artifact];
    merge: [reportId: string];
    showMerge: [];
    mergeRunsChange: [runs: NonNullable<ReportConversation['mergeRuns']>];
}>();
const route = useRoute();
const router = useRouter();
const lifecycle = useSessionLifecycle();
const state = useReportQuestions(
    () => props.reportId,
    () => props.report,
    () => route.query.questionId,
    lifecycle,
);
useActionNotification().watch(state.notice, () => (state.terminal.value ? 'error' : 'info'));
const panel = ref<HTMLElement>();
const timeline = ref<HTMLElement>();
const protectedTurns = ref<Record<string, boolean>>({});
const runningTurns = ref<Record<string, boolean>>({});
const observedArtifacts = ref<Artifact[]>([]);
const followupProtected = computed(
    () => props.blocked || Object.values(protectedTurns.value).some(Boolean),
);
const protectedState = computed(() => state.protectedState.value || followupProtected.value);
const activeTurns = computed(() =>
    Object.keys(runningTurns.value).filter((id) => runningTurns.value[id]),
);
const turns = computed(() => {
    const data = state.conversation.data.value?.pages;
    if (!data || data[0]?.data.reportId !== props.reportId) return [];
    const all = new Map(
        [...data]
            .reverse()
            .flatMap((page) => page.data.turns)
            .map((turn) => [turn.id, turn]),
    );
    const selected = state.answer.value;
    if (selected && !all.has(selected.id)) all.set(selected.id, selected);
    return [...all.values()].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
});
function visibleTurn(id: string) {
    return (
        !!props.report &&
        state.available.value &&
        state.conversation.isSuccess.value &&
        !(state.query.isError.value && state.selectedId.value === id)
    );
}
const artifacts = computed(() => [
    ...new Map(
        [...(state.conversationData.value?.artifacts ?? []), ...observedArtifacts.value].map(
            (artifact) => [artifact.reportId, artifact],
        ),
    ).values(),
]);
watch(
    artifacts,
    (value) => emit('artifactsChange', props.report && state.available.value ? value : []),
    { immediate: true },
);
watch(
    () => props.report,
    (value) => {
        if (!value) emit('artifactsChange', []);
        else emit('artifactsChange', artifacts.value);
    },
);
function observeArtifact(artifact: Artifact) {
    observedArtifacts.value = [
        ...observedArtifacts.value.filter((item) => item.reportId !== artifact.reportId),
        artifact,
    ];
}
watch(
    () => state.conversationData.value?.mergeRuns ?? [],
    (value) => emit('mergeRunsChange', value),
    { immediate: true },
);
function setProtected(id: string, value: boolean) {
    protectedTurns.value = { ...protectedTurns.value, [id]: value };
}
function setActive(id: string, value: boolean) {
    runningTurns.value = { ...runningTurns.value, [id]: value };
}
const textError = computed(() => questionTextError(state.draft.value));
const suggestions = computed(() => (props.report ? conversationSuggestions(props.report) : []));
async function prepareQuestion(question: string) {
    if (state.attempt.value || state.pending.value) return;
    state.draft.value = question;
    await nextTick();
    panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
}
function jumpTurn(id: string) {
    const target = panel.value?.querySelector<HTMLElement>(`#${CSS.escape(`turn-${id}`)}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
}
async function fetchEarlier() {
    const view = timeline.value;
    const before = view ? view.scrollHeight - view.scrollTop : 0;
    await state.conversation.fetchNextPage();
    await nextTick();
    if (view) view.scrollTop = view.scrollHeight - before;
}
let internalDestination = '';
let mounted = true;
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
    const view = timeline.value;
    const pinned = !view || view.scrollHeight - view.scrollTop - view.clientHeight < 80;
    const id = await action();
    if (!mounted || !scope.isCurrent() || route.fullPath !== path || !id) return;
    await selectSaved(id);
    await nextTick();
    if (pinned && view) view.scrollTop = view.scrollHeight;
    panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
}
function submit() {
    if (!followupProtected.value) return perform(state.submit);
}
function recover() {
    if (!followupProtected.value) return perform(state.recover);
}
function onEnter(event: KeyboardEvent) {
    if (event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
}
function confirmDiscard() {
    if (!lifecycle.session.user || !protectedState.value) return true;
    return window.confirm(
        followupProtected.value
            ? '后续执行结果尚未确认。离开会清除此页面的原请求标识，仍要继续吗？'
            : state.attempt.value
              ? '本次结果尚未确认。结束或离开后无法凭此页面恢复未知请求，再次提问可能另计用量。仍要继续吗？'
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
.questions {
    @apply grid gap-3 w-full min-w-0 break-anywhere;
}
.context-label {
    @apply m-0 text-xs text-muted leading-relaxed;
}
.conversation-history {
    @apply grid gap-2 min-w-0 [align-content:start] max-h-[65dvh] overflow-y-auto [scrollbar-gutter:stable] pr-2 [overscroll-behavior:contain];
}
.run-banner {
    @apply flex flex-wrap items-center justify-between gap-2 rounded-2 [background:var(--scova-selected)] px-3 text-sm;
}
.conversation-empty {
    @apply grid gap-3 py-8;
}
.conversation-empty h2 {
    @apply text-xl m-0;
}
.conversation-empty p {
    @apply text-muted m-0;
}
.question-starters {
    @apply grid gap-2;
}
.question-starters button {
    @apply text-start;
}
.question-form {
    @apply grid gap-2 bg-surface border-theme rounded-3 p-3;
}
textarea {
    @apply box-border w-full min-w-0 min-h-[3rem] focus:min-h-[5rem] border-0 bg-transparent text-default font-inherit leading-relaxed resize-none p-1 rounded-2 keyboard-focus-wide;
}
.question-actions {
    @apply flex flex-wrap items-center justify-between gap-2;
}
.questions button {
    @apply font-inherit min-h-11 max-w-full text-primary border-theme rounded-2 bg-transparent py-2 px-3 cursor-pointer break-anywhere keyboard-focus-wide disabled:cursor-not-allowed;
}
.questions button:hover {
    @apply [background:var(--scova-selected)];
}
</style>
