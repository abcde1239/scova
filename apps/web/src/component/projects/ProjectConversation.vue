<template>
    <section class="layout-grid gap-3" aria-labelledby="project-conversation-heading">
        <h3 id="project-conversation-heading" ref="heading" tabindex="-1" class="m-0">项目对话</h3>
        <p v-if="query.isError.value" role="alert" class="m-0">
            无法读取项目对话。 <action-button @click="query.refetch()">重新读取</action-button>
        </p>
        <p v-else-if="query.isPending.value" role="status" class="m-0">正在读取对话</p>
        <ol v-if="view?.turns.length" class="layout-grid gap-3 m-0 p-0 list-none">
            <li
                v-for="turn in view.turns"
                :key="turn.id"
                class="layout-grid gap-2 border-theme rounded-2 p-3 bg-surface break-anywhere"
            >
                <p class="m-0 whitespace-pre-wrap font-semibold">{{ turn.message }}</p>
                <p v-if="turn.status === 'running'" role="status" class="m-0 text-muted">
                    正在处理本轮
                </p>
                <p v-else-if="turn.answer" class="m-0 whitespace-pre-wrap">{{ turn.answer }}</p>
                <router-link
                    v-if="turn.reportId"
                    class="internal-link"
                    :to="{ name: 'report-detail', params: { reportId: turn.reportId } }"
                    >打开引用报告</router-link
                >
                <action-button
                    v-if="turn.status === 'failed' || turn.status === 'canceled'"
                    :disabled="Boolean(running) || pending"
                    @click="retry(turn)"
                    >继续编辑这条请求</action-button
                >
            </li>
        </ol>
        <section
            v-if="view?.drafts.length"
            class="layout-grid gap-2"
            aria-labelledby="project-drafts-heading"
        >
            <h4 id="project-drafts-heading" class="m-0">研究草案</h4>
            <article
                v-for="draft in view.drafts"
                :key="draft.id"
                class="layout-grid gap-2 p-3 rounded-2 border-theme bg-surface break-anywhere"
            >
                <h5 class="m-0 text-base">{{ draft.config.title }}</h5>
                <p class="m-0 text-sm text-muted">
                    第 {{ draft.revision }} 版 · {{ draft.taskId ? '已提交' : '待确认' }}
                </p>
                <p class="m-0">{{ draft.config.goal }}</p>
                <template v-if="draft.taskId">
                    <router-link
                        class="internal-link"
                        :to="{ name: 'task-summary', params: { taskId: draft.taskId } }"
                        >查看任务</router-link
                    >
                    <router-link
                        v-if="draft.runId"
                        class="internal-link"
                        :to="{ name: 'run-detail', params: { runId: draft.runId } }"
                        >查看执行</router-link
                    >
                </template>
                <div v-else class="flex flex-wrap items-center gap-2">
                    <router-link
                        class="internal-link keyboard-focus"
                        :to="{
                            name: 'project-draft-edit',
                            params: { projectId, draftId: draft.id },
                        }"
                        >在表单中编辑</router-link
                    >
                    <action-button
                        :disabled="pending || Boolean(running)"
                        @click="targetDraft(draft)"
                        >继续调整</action-button
                    >
                    <action-button
                        :disabled="pending || Boolean(running)"
                        @click="confirm(draft, false)"
                        >保存任务</action-button
                    >
                    <action-button
                        type="primary"
                        :disabled="pending || Boolean(running)"
                        @click="confirm(draft, true)"
                        >保存并立即运行</action-button
                    >
                </div>
            </article>
        </section>
        <form
            v-if="view"
            class="layout-grid gap-2"
            method="post"
            aria-labelledby="project-conversation-heading"
            @submit.prevent="send"
        >
            <div v-if="draftTarget && !target" class="flex flex-wrap items-center gap-2">
                <p class="m-0">原草案版本已变更。</p>
                <action-button @click="draftTarget = undefined">清除草案选择</action-button>
            </div>
            <fieldset
                class="layout-grid gap-2 m-0 p-0 border-0"
                :disabled="pending || Boolean(running)"
            >
                <legend class="p-0 mb-1 font-semibold">下一轮</legend>
                <div v-if="target" class="flex flex-wrap items-center gap-2">
                    <span
                        >正在调整「{{ target.config.title }}」第
                        {{ draftTarget?.revision }} 版</span
                    >
                    <action-button @click="draftTarget = undefined">清除草案选择</action-button>
                </div>
                <label v-else class="layout-grid gap-1"
                    >操作
                    <select v-model="kind" class="report-select" name="kind">
                        <option value="draft">起草研究</option>
                        <option value="ask">询问已有报告</option>
                    </select>
                </label>
                <label v-if="kind === 'ask'" class="layout-grid gap-1"
                    >引用报告
                    <select v-model="reportId" class="report-select" name="reportId">
                        <option value="">选择报告</option>
                        <option v-for="report in reports" :key="report.id" :value="report.id">
                            {{ report.title }}
                        </option>
                    </select>
                </label>
                <label class="layout-grid gap-1"
                    >消息
                    <textarea
                        ref="composer"
                        v-model="message"
                        class="report-select w-full"
                        rows="3"
                        name="message"
                        maxlength="2000"
                        required
                    />
                </label>
            </fieldset>
            <div class="flex flex-wrap gap-2 items-center">
                <action-button
                    v-if="!running"
                    type="primary"
                    attr-type="submit"
                    :busy="pending"
                    :disabled="!message.trim()"
                    >发送</action-button
                >
                <action-button v-else :busy="canceling" @click="cancel(running.id)"
                    >停止本轮</action-button
                >
                <p v-if="error" class="m-0 text-sm" role="alert">{{ error }}</p>
            </div>
        </form>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import type {
    ProjectConversation,
    ProjectConversationInput,
    ProjectDetailResponse,
    ProjectResearchDraft,
} from '@scova/models';
import {
    projectConversationEndpoint,
    sendProjectTurnEndpoint,
    cancelProjectTurnEndpoint,
    confirmProjectDraftEndpoint,
} from '@/api/projects';
import { toApiError } from '@/api/errors';
import type { ApiResponse } from '@/api/client';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import ActionButton from '@/component/common/ActionButton.vue';

const props = defineProps<{ projectId: string; reports: ProjectDetailResponse['recentReports'] }>();
const lifecycle = useSessionLifecycle();
const scope = lifecycle.capture();
const projectId = props.projectId;
const params = { projectId };
const key = scope.queryKey(['projects', projectId, 'conversation']);
const pending = ref(false);
const canceling = ref(false);
const query = useQuery(
    computed(() => ({
        ...lifecycle.queryOptions(projectConversationEndpoint, { params }, [
            'projects',
            projectId,
            'conversation',
        ]),
        refetchInterval: (state: { state: { data?: ApiResponse<ProjectConversation> } }) =>
            pending.value || state.state.data?.data.turns.some((turn) => turn.status === 'running')
                ? 800
                : false,
    })),
    lifecycle.queryClient,
);
const view = computed(() => query.data.value?.data);
const running = computed(() => view.value?.turns.find((turn) => turn.status === 'running'));
const route = useRoute();
const heading = ref<HTMLElement>();
watch(
    [() => route.hash, heading],
    ([hash, element]) => {
        if (hash === '#project-conversation-heading') element?.focus();
    },
    { flush: 'post' },
);
const composer = ref<HTMLTextAreaElement>();
const message = ref('');
const kind = ref<ProjectConversationInput['kind']>('draft');
const reportId = ref('');
const draftTarget = ref<{ id: string; revision: number }>();
const error = ref('');
const target = computed(() =>
    view.value?.drafts.find(
        (draft) =>
            draft.id === draftTarget.value?.id &&
            draft.revision === draftTarget.value.revision &&
            !draft.taskId,
    ),
);
const controller = new AbortController();
const cleanup = scope.registerCleanup(() => controller.abort());
onBeforeUnmount(() => {
    controller.abort();
    cleanup();
});
let attempt: { fingerprint: string; turnId: string } | undefined;
async function refresh() {
    if (scope.isCurrent() && !controller.signal.aborted)
        await lifecycle.queryClient.invalidateQueries({ queryKey: key });
}
async function send() {
    if (pending.value || running.value || !message.value.trim()) return;
    if (draftTarget.value && !target.value) {
        error.value = '所选草案已不可编辑，请清除选择。';
        return;
    }
    const selected = target.value;
    const input = {
        kind: selected ? ('draft' as const) : kind.value,
        message: message.value,
        ...(selected ? { target: { id: selected.id, revision: selected.revision } } : {}),
        ...(kind.value === 'ask' && reportId.value && !selected
            ? { reportId: reportId.value }
            : {}),
    };
    const fingerprint = JSON.stringify(input);
    if (attempt?.fingerprint !== fingerprint)
        attempt = { fingerprint, turnId: crypto.randomUUID() };
    pending.value = true;
    error.value = '';
    try {
        await scope.request(
            sendProjectTurnEndpoint,
            { params, body: { ...input, turnId: attempt.turnId } },
            { signal: controller.signal },
        );
        message.value = '';
        draftTarget.value = undefined;
        attempt = undefined;
    } catch (cause) {
        if (!controller.signal.aborted) error.value = toApiError(cause).message;
    } finally {
        pending.value = false;
        await refresh();
    }
}
async function cancel(turnId: string) {
    if (canceling.value) return;
    canceling.value = true;
    try {
        await scope.request(
            cancelProjectTurnEndpoint,
            { params: { projectId, turnId } },
            { signal: controller.signal },
        );
    } catch (cause) {
        if (!controller.signal.aborted) error.value = toApiError(cause).message;
    } finally {
        canceling.value = false;
        await refresh();
    }
}
async function confirm(draft: ProjectResearchDraft, start: boolean) {
    if (pending.value || running.value) return;
    pending.value = true;
    error.value = '';
    try {
        await scope.request(
            confirmProjectDraftEndpoint,
            {
                params: { projectId, draftId: draft.id },
                body: { revision: draft.revision, start },
            },
            { signal: controller.signal },
        );
        if (scope.isCurrent())
            await Promise.all([
                lifecycle.queryClient.invalidateQueries({
                    queryKey: scope.queryKey(['projects', projectId]),
                }),
                lifecycle.queryClient.invalidateQueries({ queryKey: scope.queryKey(['tasks']) }),
            ]);
    } catch (cause) {
        if (!controller.signal.aborted) error.value = toApiError(cause).message;
    } finally {
        pending.value = false;
        await refresh();
    }
}
function targetDraft(draft: ProjectResearchDraft) {
    draftTarget.value = { id: draft.id, revision: draft.revision };
    kind.value = 'draft';
    void nextTick(() => composer.value?.focus());
}
function retry(turn: ProjectConversation['turns'][number]) {
    message.value = turn.message;
    kind.value = turn.kind;
    reportId.value = turn.reportId ?? '';
    draftTarget.value = turn.target;
    attempt = undefined;
    void nextTick(() => composer.value?.focus());
}
</script>
