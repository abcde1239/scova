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
                :composer-open="composerOpen"
                @protected-change="setProtected(turn.id, $event)"
                @active-change="setActive(turn.id, $event)"
                @artifact="observeArtifact"
                @open-artifact="emit('openArtifact', $event)"
                @open-original="emit('openOriginal')"
                @merge="emit('merge', $event)"
            />
            <div v-if="state.pending.value" class="pending-answer">
                <span role="status">正在根据报告资料回答…</span>
                <button type="button" @click="state.cancelPending">停止等待</button>
            </div>
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
            <slot name="execution" />
            <p v-if="!state.available.value" role="status">
                报告当前无法读取。本地问题与未确认的请求仍保留，恢复后可继续。
            </p>
            <p v-if="state.address.value.error" role="alert">
                {{ state.address.value.error
                }}<button type="button" @click="startNew">提出新问题</button>
            </p>
            <report-composer-followup
                ref="composer"
                :report-id="reportId"
                :report="report"
                :after-question-id="state.turns.value.at(-1)?.id ?? null"
                @opened="composerOpen = $event"
                @closed="restoreComposerFocus"
                @refresh="state.conversation.refetch({ cancelRefetch: false })"
                @saved="onComposerSaved"
            />
            <slot name="secondary" />
        </div>
        <form class="question-form" @submit.prevent="submit">
            <label class="sr-only" for="report-question">问题</label>
            <textarea
                id="report-question"
                v-model="state.draft.value"
                rows="2"
                placeholder="围绕这份报告继续提问…"
                :readonly="
                    composerOpen ||
                    !!state.attempt.value ||
                    state.pending.value ||
                    !state.available.value
                "
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
                <report-workspace-menu
                    v-if="report?.mode === 'live' || state.draft.value"
                    ref="composerTrigger"
                    label="添加功能"
                    icon="create"
                    placement="top-start"
                    :disabled="composerOpen || !!state.attempt.value || followupProtected"
                >
                    <template #default="{ close }">
                        <button
                            v-if="report?.mode === 'live'"
                            type="button"
                            class="workspace-menu-item"
                            :disabled="!state.canSubmit.value || followupProtected"
                            @click="
                                close();
                                openComposer();
                            "
                        >
                            <app-icon name="search" />补查新资料
                        </button>
                        <p v-if="!state.draft.value" class="picker-status">先输入要补查的问题。</p>
                        <button
                            v-if="state.draft.value"
                            type="button"
                            class="workspace-menu-item"
                            @click="
                                close();
                                startNew();
                            "
                        >
                            清空问题
                        </button>
                    </template>
                </report-workspace-menu>
                <div class="question-pickers">
                    <report-workspace-menu
                        label="本对话使用的模型"
                        :text="
                            selectedProvider?.model ?? (providerId ? '模型不可用' : defaultModel)
                        "
                        :disabled="settingsLocked"
                    >
                        <template #default="{ close }">
                            <p class="picker-status">本对话使用的模型</p>
                            <button
                                type="button"
                                class="workspace-menu-item"
                                :aria-pressed="!providerId"
                                @click="
                                    providerId = '';
                                    close();
                                "
                            >
                                <span
                                    >沿用配置<small v-if="defaultModel !== '模型'">{{
                                        defaultModel
                                    }}</small></span
                                >
                                <app-icon v-if="!providerId" name="confirm" />
                            </button>
                            <p v-if="providers.isPending.value" class="picker-status" role="status">
                                正在读取已保存的模型配置…
                            </p>
                            <button
                                v-else-if="providers.isError.value"
                                type="button"
                                class="workspace-menu-item"
                                @click="providers.refetch()"
                            >
                                重试读取模型配置
                            </button>
                            <template v-else>
                                <button
                                    v-for="provider in modelOptions"
                                    :key="provider.id"
                                    type="button"
                                    class="workspace-menu-item"
                                    :disabled="!provider.hasApiKey"
                                    :aria-pressed="provider.id === providerId"
                                    @click="
                                        providerId = provider.id;
                                        close();
                                    "
                                >
                                    <span
                                        >{{ provider.name
                                        }}<small
                                            >{{ provider.model
                                            }}{{ provider.hasApiKey ? '' : ' · 缺少密钥' }}</small
                                        ></span
                                    >
                                    <app-icon v-if="provider.id === providerId" name="confirm" />
                                </button>
                                <p v-if="!modelOptions.length" class="picker-status">
                                    尚无已保存的模型配置。
                                </p>
                            </template>
                        </template>
                    </report-workspace-menu>
                    <report-workspace-menu
                        label="本对话的推理强度"
                        text="推理强度"
                        :disabled="settingsLocked"
                    >
                        <template #default="{ close }">
                            <button
                                type="button"
                                class="workspace-menu-item"
                                aria-pressed="true"
                                @click="close"
                            >
                                沿用配置<app-icon name="confirm" />
                            </button>
                            <p class="picker-status">当前配置未提供可选的推理强度。</p>
                        </template>
                    </report-workspace-menu>
                </div>
                <button
                    v-if="!state.attempt.value || state.pending.value"
                    type="submit"
                    class="question-send"
                    aria-label="提问"
                    title="发送问题"
                    :disabled="!canSend"
                >
                    <app-icon name="send" />
                </button>
                <action-button
                    v-else
                    :disabled="!state.canRecover.value || followupProtected"
                    @click="recover"
                    >读取本次结果</action-button
                >
            </div>
            <div v-if="state.attempt.value && !state.pending.value" class="question-recovery">
                <button type="button" :disabled="composerOpen" @click="startNew">
                    结束本次请求
                </button>
            </div>
            <span id="question-input-help" class="sr-only">Enter 发送 · Shift + Enter 换行</span>
        </form>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import type { Report, ReportConversation } from '@scova/models';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import ReportWorkspaceMenu from '@/component/reports/ReportWorkspaceMenu.vue';
import { listProvidersEndpoint } from '@/api/agent-providers';
import ReportComposerFollowup from '@/component/reports/ReportComposerFollowup.vue';
import ReportConversationTurn from '@/component/reports/ReportConversationTurn.vue';
import { useReportQuestions } from '@/composable/useReportQuestions';
import { useSessionLifecycle, useSessionQuery } from '@/composable/useSessionQuery';
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
    openOriginal: [];
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
const composer = ref<InstanceType<typeof ReportComposerFollowup>>();
const composerTrigger = ref<InstanceType<typeof ReportWorkspaceMenu>>();
const providers = useSessionQuery(listProvidersEndpoint, {}, ['agent-providers']);
const providerId = ref('');
const modelOptions = computed(() => providers.data.value?.data.items ?? []);
const selectedProvider = computed(() =>
    modelOptions.value.find((item) => item.id === providerId.value),
);
const defaultModel = computed(
    () => modelOptions.value.find((item) => item.active)?.model ?? '模型',
);
const settingsLocked = computed(
    () => composerOpen.value || !!state.attempt.value || followupProtected.value,
);
const canSend = computed(
    () =>
        state.canSubmit.value &&
        !followupProtected.value &&
        (!providerId.value || !!selectedProvider.value?.hasApiKey),
);
const composerOpen = ref(false);
const followupProtected = computed(
    () => composerOpen.value || props.blocked || Object.values(protectedTurns.value).some(Boolean),
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
    if (composerOpen.value || state.attempt.value || state.pending.value) return;
    state.draft.value = question;
    await nextTick();
    panel.value
        ?.querySelector<HTMLTextAreaElement>('#report-question')
        ?.focus({ preventScroll: true });
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
    panel.value
        ?.querySelector<HTMLTextAreaElement>('#report-question')
        ?.focus({ preventScroll: true });
}
function openComposer() {
    if (state.canSubmit.value && !followupProtected.value)
        void composer.value?.open(state.draft.value, state.turns.value.at(-1)?.id ?? null);
}
async function restoreComposerFocus() {
    await nextTick();
    if (composerTrigger.value && !settingsLocked.value) composerTrigger.value.focus();
    else panel.value?.querySelector<HTMLTextAreaElement>('#report-question')?.focus();
}
function onComposerSaved(id: string) {
    void perform(async () => {
        const scope = lifecycle.capture();
        const reportId = props.reportId;
        state.draft.value = '';
        await state.conversation.refetch({ cancelRefetch: false });
        if (scope.isCurrent() && props.reportId === reportId) return id;
    });
}
function submit() {
    if (canSend.value) return perform(() => state.submit(providerId.value || undefined));
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
    if (composerOpen.value || state.pending.value || !confirmDiscard()) return;
    await selectSaved();
    state.newQuestion();
    await nextTick();
    panel.value?.querySelector<HTMLTextAreaElement>('#report-question')?.focus();
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
    @apply flex flex-col flex-1 gap-3 w-full min-w-0 min-h-0 break-anywhere;
}
.context-label {
    @apply m-0 text-xs text-muted leading-relaxed;
}
.conversation-history {
    @apply grid flex-1 gap-2 min-w-0 min-h-0 [align-content:start] overflow-y-auto pr-1 [overscroll-behavior:contain];
    min-block-size: 8rem;
    scrollbar-width: thin;
}
.run-banner {
    @apply flex flex-wrap items-center justify-between gap-2 rounded-2 [background:var(--scova-selected)] px-3 text-sm;
}
.conversation-empty {
    @apply grid gap-2 py-5;
}
.conversation-empty h2 {
    @apply text-xl m-0;
}
.conversation-empty p {
    @apply text-muted m-0;
}
.question-starters {
    @apply flex flex-wrap gap-1.5;
}
.question-starters button {
    @apply text-start;
}
.question-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.375rem;
    min-width: 0;
    flex: none;
    padding: 0.625rem;
    border: 1px solid color-mix(in srgb, var(--scova-border) 62%, var(--scova-surface));
    border-radius: 1.125rem;
    background: var(--scova-surface);
}
textarea {
    @apply box-border w-full min-w-0 border-0 bg-transparent text-default font-inherit leading-relaxed resize-none p-2 rounded-2;
    field-sizing: content;
    min-block-size: 3rem;
    max-block-size: min(12rem, 32dvh);
    overflow-y: auto;
    outline: none;
}
textarea:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--scova-text) 28%, transparent);
    outline-offset: -1px;
}
.question-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
}
.question-pickers {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.125rem;
    flex: 1 1 6rem;
    min-inline-size: 0;
}
.question-pickers :deep(.workspace-menu-trigger) {
    max-inline-size: min(9rem, 100%);
}
.picker-status {
    margin: 0;
    padding: 0.375rem 0.625rem;
    color: var(--scova-muted);
    font-size: 0.75rem;
}
.workspace-menu-item small {
    display: block;
    color: var(--scova-muted);
    font-size: 0.75rem;
}
.question-send {
    display: inline-grid;
    place-items: center;
    flex: none;
    inline-size: 2.375rem;
    block-size: 2.375rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--scova-text);
    color: var(--scova-surface);
    font-size: 1.125rem;
    cursor: pointer;
    transition:
        opacity 140ms ease,
        scale 140ms ease;
}
.question-send:disabled {
    opacity: 0.28;
    cursor: not-allowed;
}
.question-send:not(:disabled):hover {
    opacity: 0.8;
}
.question-send:not(:disabled):active {
    scale: 0.92;
}
.question-send:focus-visible {
    outline: 1px solid var(--scova-text);
    outline-offset: 2px;
}
.question-recovery {
    justify-self: end;
}
.pending-answer {
    @apply flex flex-wrap items-center justify-between gap-2 text-sm text-muted;
}
@media (pointer: coarse) {
    .question-send {
        inline-size: 2.75rem;
        block-size: 2.75rem;
    }
}
@media (prefers-reduced-motion: reduce) {
    .question-send {
        transition: none;
        scale: none;
    }
}
.questions
    :is(.conversation-history, .run-banner, .question-recovery)
    button:not(.scova-action-button) {
    @apply font-inherit min-h-11 max-w-full text-primary border-theme rounded-2 bg-transparent py-2 px-3 cursor-pointer break-anywhere keyboard-focus-wide disabled:cursor-not-allowed;
}
.questions
    :is(.conversation-history, .run-banner, .question-recovery)
    button:not(.scova-action-button):hover {
    @apply [background:var(--scova-selected)];
}
</style>
