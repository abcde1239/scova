<template>
    <div v-if="!thread || blocked" class="grid gap-3 content-start justify-items-start p-4 min-w-0">
        <h1 id="page-title" ref="heading" tabindex="-1" class="m-0 text-xl">项目会话</h1>
        <state-panel
            v-if="wrongProject || blocked"
            state="error"
            message="此项目中找不到该会话。"
        />
        <state-panel
            v-else-if="query.isError.value"
            state="error"
            :message="toApiError(query.error.value).message"
            :retryable="!unavailable"
            @retry="query.refetch()"
        />
        <state-panel v-else state="loading" message="正在读取会话" />
        <router-link class="internal-link" :to="{ name: 'project-detail', params: { projectId } }"
            >返回项目</router-link
        >
        <router-link class="internal-link" :to="{ name: 'project-legacy', params: { projectId } }"
            >打开原项目页</router-link
        >
    </div>
    <div v-else class="thread-workspace">
        <section class="thread-center" aria-labelledby="page-title">
            <header class="thread-header">
                <div class="grid gap-1 min-w-0">
                    <router-link
                        class="internal-link truncate justify-self-start max-w-full text-sm"
                        :to="{ name: 'project-legacy', params: { projectId } }"
                        >{{ detail?.project.name ?? '项目管理' }}</router-link
                    >
                    <h1
                        id="page-title"
                        ref="heading"
                        class="m-0 text-xl break-anywhere"
                        tabindex="-1"
                    >
                        {{ thread.title }}
                    </h1>
                </div>
                <div class="thread-header-actions flex flex-wrap gap-1">
                    <action-button
                        v-if="!layout.wide.value"
                        quaternary
                        v-bind="{
                            'aria-haspopup': 'dialog',
                            'aria-controls': paneId,
                            'aria-expanded': paneOpen,
                        }"
                        @click="paneOpen = true"
                        >{{ paneTitle }}</action-button
                    >
                    <action-button
                        quaternary
                        v-bind="{
                            'aria-expanded': editing,
                            'aria-controls': editing ? renameId : undefined,
                        }"
                        @click="toggleRename"
                        >重命名</action-button
                    >
                    <action-button
                        quaternary
                        :busy="update.isPending.value && !editing"
                        @click="changeArchived"
                        >{{ thread.archivedAt ? '恢复会话' : '归档' }}</action-button
                    >
                </div>
                <form
                    v-if="editing"
                    :id="renameId"
                    method="post"
                    class="thread-rename"
                    @submit.prevent="saveTitle"
                >
                    <label class="text-sm font-medium" :for="titleId">会话标题</label>
                    <input
                        :id="titleId"
                        ref="titleInput"
                        v-model="title"
                        class="thread-input"
                        maxlength="120"
                        required
                        @keydown.esc.prevent="closeRename"
                    />
                    <action-button
                        attr-type="submit"
                        type="primary"
                        :busy="update.isPending.value"
                        :disabled="!title.trim()"
                        >保存</action-button
                    >
                    <action-button quaternary @click="closeRename">取消</action-button>
                </form>
                <p
                    v-if="headerError"
                    role="alert"
                    class="col-span-full m-0 text-danger text-sm break-anywhere"
                >
                    {{ headerError }}
                </p>
                <p
                    v-if="streamFailure"
                    role="status"
                    class="col-span-full flex flex-wrap items-center gap-2 m-0 text-sm"
                >
                    {{ streamFailure }}
                    <action-button text @click="reconnect">重新连接</action-button>
                </p>
            </header>
            <div
                ref="history"
                class="thread-history"
                tabindex="0"
                role="region"
                aria-label="会话记录"
                @scroll="trackScroll"
            >
                <div class="thread-lane">
                    <div v-if="!items.length" class="thread-empty">
                        <app-icon name="question" />
                        <h2 class="m-0 text-xl">开始这段会话</h2>
                        <p class="m-0 text-muted">描述你想研究的主题，或引用一份项目报告提问。</p>
                    </div>
                    <ol v-else class="grid gap-5 m-0 p-0 list-none">
                        <li
                            v-for="item in renderedItems"
                            :key="runItemKey(item) ?? item.id"
                            :id="`thread-item-${item.id}`"
                            tabindex="-1"
                            class="min-w-0 keyboard-focus-inset"
                        >
                            <project-thread-item
                                :item="item"
                                :project-id="projectId"
                                :report-title="reportTitle"
                                :task-title="taskTitle"
                                :run-command-state="runCommandState(item)"
                                :writable="writable"
                                :can-read-in-pane="!!slots.context"
                                :retry-text="retryText(item)"
                                :can-retry="writable && !activeTurn && !send.isPending.value"
                                :decision="outcomeByAction.get(item.id)"
                                :busy-decision="decisionBusy.get(item.id)"
                                :decision-error="decisionErrors.get(item.id)"
                                @decide="decide(item, $event)"
                                @cancel-run="stopRun"
                                @read-report="readReport"
                                @retry-turn="restoreMessage(item)"
                            />
                        </li>
                    </ol>
                </div>
            </div>
            <footer class="thread-footer">
                <div class="thread-lane">
                    <p v-if="thread.archivedAt" class="m-0 text-muted">
                        此会话已归档。恢复会话后可以继续发送消息。
                    </p>
                    <form
                        v-else
                        method="post"
                        class="thread-composer"
                        aria-labelledby="composer-heading"
                        @submit.prevent="sendMessage"
                    >
                        <label id="composer-heading" :for="messageId" class="font-semibold"
                            >给 Scova 发送消息</label
                        >
                        <ul
                            v-if="reportRefs.length"
                            class="flex flex-wrap gap-2 m-0 p-0 list-none"
                            aria-label="已引用报告"
                        >
                            <li v-for="ref in reportRefs" :key="refKey(ref)" class="reference-chip">
                                <span
                                    class="min-w-0 truncate"
                                    :title="reportRefPreviews.get(refKey(ref))"
                                    >{{ refTitle(ref) }}</span
                                >
                                <button
                                    type="button"
                                    :disabled="!canEditMessage"
                                    :aria-label="`移除引用：${refTitle(ref)}`"
                                    @click="removeRef(ref)"
                                >
                                    ×
                                </button>
                            </li>
                        </ul>
                        <ul
                            v-if="sourceRefs.length"
                            class="flex flex-wrap gap-2 m-0 p-0 list-none"
                            aria-label="已引用来源"
                        >
                            <li
                                v-for="source in sourceRefs"
                                :key="sourceKey(source)"
                                class="reference-chip"
                            >
                                <span class="min-w-0 truncate" :title="sourceTitle(source)"
                                    >来源 · {{ sourceTitle(source) }}</span
                                >
                                <button
                                    type="button"
                                    :disabled="!canEditMessage"
                                    :aria-label="`移除来源：${sourceTitle(source)}`"
                                    @click="removeSource(source)"
                                >
                                    ×
                                </button>
                            </li>
                        </ul>
                        <ul
                            v-if="attachmentRefs.length"
                            class="flex flex-wrap gap-2 m-0 p-0 list-none"
                            aria-label="已添加附件"
                        >
                            <li
                                v-for="attachment in attachmentRefs"
                                :key="attachment.id"
                                class="reference-chip"
                            >
                                <span class="min-w-0 truncate">{{
                                    attachmentName(attachment.id)
                                }}</span>
                                <button
                                    type="button"
                                    :disabled="!canEditMessage"
                                    :aria-label="`移除附件：${attachmentName(attachment.id)}`"
                                    @click="removeAttachment(attachment.id)"
                                >
                                    ×
                                </button>
                            </li>
                        </ul>
                        <textarea
                            :id="messageId"
                            ref="composer"
                            v-model="message"
                            class="thread-input resize-none"
                            rows="2"
                            :maxlength="THREAD_MESSAGE_MAX_LENGTH"
                            :aria-describedby="hintId"
                            :readonly="!canEditMessage"
                            placeholder="输入研究问题或描述研究计划…"
                            @keydown.enter="keyboardSend"
                        />
                        <div class="flex flex-wrap justify-between items-center gap-2">
                            <details class="thread-ref-picker" v-if="reports.length">
                                <summary class="cursor-pointer keyboard-focus-inset">
                                    引用报告
                                </summary>
                                <fieldset
                                    class="grid gap-1 m-0 px-0 pb-0 pt-2 border-0 min-w-0"
                                    :disabled="!canEditMessage"
                                >
                                    <legend class="sr-only">最近报告（最多 3 份）</legend>
                                    <label
                                        v-for="report in reports"
                                        :key="report.id"
                                        class="flex items-start gap-2 break-anywhere"
                                    >
                                        <input
                                            type="checkbox"
                                            :checked="reportIds.includes(report.id)"
                                            :disabled="
                                                reportRefs.length >= reportRefLimit &&
                                                !reportIds.includes(report.id)
                                            "
                                            @change="toggleRef(report.id)"
                                        />{{ report.title }}
                                    </label>
                                </fieldset>
                            </details>
                            <div class="ml-auto flex flex-wrap items-center gap-2">
                                <span v-if="activeTurn" class="text-sm text-muted" role="status"
                                    >Scova 正在处理</span
                                >
                                <action-button
                                    v-if="activeTurn"
                                    :busy="cancel.isPending.value"
                                    @click="stopTurn"
                                    >停止</action-button
                                >
                                <action-button
                                    v-else
                                    type="primary"
                                    attr-type="submit"
                                    :busy="send.isPending.value"
                                    :disabled="!canSend && !send.isPending.value"
                                    >发送</action-button
                                >
                            </div>
                        </div>
                        <details class="text-sm min-w-0">
                            <summary class="cursor-pointer keyboard-focus-inset">附件</summary>
                            <project-thread-attachment-upload
                                :thread-id="threadId"
                                :disabled="!canEditMessage"
                                :remaining="remainingReferences"
                                @uploaded="addAttachment"
                                @busy="attachmentBusy = $event"
                            />
                        </details>
                        <details class="text-sm min-w-0">
                            <summary class="cursor-pointer keyboard-focus-inset">本轮选项</summary>
                            <div class="grid gap-2 pt-2">
                                <label class="grid gap-1" :for="autonomyId"
                                    >本轮自主度
                                    <select
                                        :id="autonomyId"
                                        v-model="autonomy"
                                        class="thread-input"
                                        :disabled="!canEditMessage"
                                    >
                                        <option :value="undefined">
                                            项目默认{{
                                                defaultAutonomy
                                                    ? ' · ' + autonomyLabels[defaultAutonomy]
                                                    : ''
                                            }}
                                        </option>
                                        <option
                                            v-for="(label, tier) in autonomyLabels"
                                            :key="tier"
                                            :value="tier"
                                        >
                                            {{ label }}
                                        </option>
                                    </select>
                                </label>
                                <label class="grid gap-1" :for="taskPickerId"
                                    >关联项目任务
                                    <select
                                        :id="taskPickerId"
                                        v-model="taskRefId"
                                        class="thread-input"
                                        :disabled="
                                            !canEditMessage ||
                                            (!taskRefId && remainingReferences === 0)
                                        "
                                    >
                                        <option value="">请选择任务</option>
                                        <option
                                            v-for="task in tasks"
                                            :key="task.id"
                                            :value="task.id"
                                        >
                                            {{ task.title }}
                                        </option>
                                    </select>
                                </label>
                                <action-button
                                    v-if="projectQuery.hasNextPage.value"
                                    :busy="projectQuery.isFetchingNextPage.value"
                                    text
                                    @click="projectQuery.fetchNextPage()"
                                    >加载更多任务</action-button
                                >
                            </div>
                        </details>
                        <p :id="hintId" class="m-0 text-sm text-muted">
                            Enter 发送，Shift + Enter 换行
                        </p>
                        <p
                            v-if="sendError"
                            class="m-0 text-sm break-anywhere text-danger"
                            role="alert"
                        >
                            {{ sendError }}
                        </p>
                        <p v-if="feedback" class="m-0 text-sm" role="status">{{ feedback }}</p>
                    </form>
                </div>
            </footer>
        </section>
        <project-context-pane
            :pane-id="paneId"
            :title="paneTitle"
            :mode="selectedReport ? 'reading' : 'overview'"
            v-model="paneOpen"
        >
            <slot
                name="context"
                :project-id="projectId"
                :thread-id="threadId"
                :detail="detail"
                :items="knownItems"
                :focus-item="focusItem"
                :reading-wide="readingWide"
                :toggle-reading-width="toggleReadingWidth"
                :report-id="selectedReport"
                :read-report="readReport"
                :close-report="closeReport"
                :quote-report="quoteReport"
                :cite-source="citeSource"
                :can-cite="canEditMessage"
            >
                <project-thread-context :project-id="projectId" :detail="detail" />
            </slot>
        </project-context-pane>
    </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onScopeDispose, ref, useId, watch } from 'vue';
import {
    ProjectThreadItemSchema,
    type ProjectThreadItem as KnownThreadItem,
    type ProjectDetailResponse,
    type ProjectThreadAttachment,
    type UpdateProjectThread,
} from '@scova/models';
import { toApiError } from '@/api/errors';
import { projectSettingsEndpoint } from '@/api/project-settings';
import {
    THREAD_MESSAGE_MAX_LENGTH,
    updateThreadEndpoint,
    type ThreadItem,
    type ThreadReportRef,
    type ThreadSourceRef,
} from '@/api/project-threads';
import ActionButton from '@/component/common/ActionButton.vue';
import AppIcon from '@/component/common/AppIcon.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import ProjectThreadAttachmentUpload from '@/component/projects/ProjectThreadAttachmentUpload.vue';
import ProjectThreadItem from '@/component/projects/ProjectThreadItem.vue';
import ProjectThreadContext from '@/component/projects/ProjectThreadContext.vue';
import ProjectContextPane from '@/layout/ProjectContextPane.vue';
import { projectWorkspaceLayoutKey } from '@/composable/useProjectWorkspaceLayout';
import { useProject } from '@/composable/useProjects';
import { invalidateProjectThreads, useThreadTimeline } from '@/composable/useProjectThreads';
import { useProjectThreadActions } from '@/composable/useProjectThreadActions';
import type {
    ProjectReportCitation,
    ProjectReportSourceCitation,
} from '@/utils/project-report-reader';
import {
    useSessionLifecycle,
    useSessionMutation,
    useSessionQuery,
} from '@/composable/useSessionQuery';

const props = defineProps<{ projectId: string; threadId: string }>();
const slots = defineSlots<{
    context?(props: {
        projectId: string;
        threadId: string;
        detail?: ProjectDetailResponse;
        items: readonly KnownThreadItem[];
        readingWide?: boolean;
        toggleReadingWidth: () => void;
        focusItem: (id: string) => void;
        reportId?: string;
        readReport: (id: string) => void;
        closeReport: () => void;
        quoteReport: (reference: ProjectReportCitation) => void;
        citeSource: (reference: ProjectReportSourceCitation) => void;
        canCite: boolean;
    }): unknown;
}>();
const lifecycle = useSessionLifecycle();
const { detail, tasks, query: projectQuery } = useProject(props.projectId, lifecycle);
const taskTitle = (id: string) => tasks.value.find((task) => task.id === id)?.title;
const settings = useSessionQuery(
    projectSettingsEndpoint,
    { params: { projectId: props.projectId } },
    ['project-settings'],
    lifecycle,
);
const defaultAutonomy = computed(() => settings.data.value?.data.defaultAutonomy);
const autonomyLabels = { ask: '每次询问', budgeted: '预算内自动', autonomous: '自主执行' } as const;
const {
    query,
    snapshot,
    wrongProject,
    streamFailure,
    streamBlocked: blocked,
    updateThread,
    reconnect,
} = useThreadTimeline(props.projectId, props.threadId, lifecycle);
const layout = inject(projectWorkspaceLayoutKey)!;
const unavailable = computed(() =>
    [401, 403, 404].includes(toApiError(query.error.value).status ?? 0),
);
const thread = computed(() => snapshot.value?.thread);
const items = computed(() => snapshot.value?.items ?? []);
const knownKinds = new Set<string>(
    ProjectThreadItemSchema.properties.kind.anyOf.map((kind) => kind.const),
);
const knownItems = computed(() =>
    items.value.filter((item): item is KnownThreadItem => knownKinds.has(item.kind)),
);
function runItemKey(item: ThreadItem) {
    const runId = item.payload.runId;
    return item.kind === 'run' && typeof runId === 'string' && runId ? 'run:' + runId : undefined;
}
const renderedItems = computed(() => {
    const rendered: ThreadItem[] = [];
    const runPositions = new Map<string, number>();
    // Snapshots and streamed items arrive in sequence order. Update an existing card in place.
    for (const item of items.value) {
        if (['plan', 'schedule'].includes(item.kind) && typeof item.payload.actionId === 'string')
            continue;
        const key = runItemKey(item);
        const position = key === undefined ? undefined : runPositions.get(key);
        if (position !== undefined) rendered[position] = item;
        else {
            if (key !== undefined) runPositions.set(key, rendered.length);
            rendered.push(item);
        }
    }
    return rendered;
});
const reports = computed(() => detail.value?.recentReports ?? []);
const reportTitle = (id: string) =>
    reports.value.find((report) => report.id === id)?.title ?? '引用的项目报告';
const writable = computed(() => !!thread.value && !thread.value.archivedAt && !blocked.value);
const {
    message,
    autonomy,
    taskRefId,
    attachmentRefs,
    attachmentBusy,
    runFeedback,
    stopRun,
    reportRefs,
    sourceRefs,
    sendError,
    feedback,
    send,
    cancel,
    canSend,
    activeTurn,
    retryContent,
    outcomeByAction,
    decisionBusy,
    decisionErrors,
    sendMessage,
    stopTurn,
    decide,
} = useProjectThreadActions(props.projectId, props.threadId, items, writable);
const reportRefLimit = computed(() =>
    Math.max(
        0,
        3 - Number(!!taskRefId.value) - attachmentRefs.value.length - sourceRefs.value.length,
    ),
);
const remainingReferences = computed(() =>
    Math.max(0, reportRefLimit.value - reportRefs.value.length),
);
const uploadedNames = new Map<string, string>();
const attachmentName = (attachmentId: string) => uploadedNames.get(attachmentId) ?? '会话附件';
function addAttachment(attachment: ProjectThreadAttachment) {
    if (
        remainingReferences.value === 0 ||
        attachmentRefs.value.some(({ id }) => id === attachment.id)
    )
        return;
    uploadedNames.set(attachment.id, attachment.filename);
    attachmentRefs.value = [...attachmentRefs.value, { kind: 'attachment', id: attachment.id }];
}
function removeAttachment(attachmentId: string) {
    attachmentRefs.value = attachmentRefs.value.filter(({ id }) => id !== attachmentId);
}
const reportRefPreviews = ref(new Map<string, string>());
const runCommandState = (item: ThreadItem) =>
    item.kind === 'run' && typeof item.payload.runId === 'string'
        ? runFeedback.get(item.payload.runId)
        : undefined;
const reportIds = computed(() => reportRefs.value.map(({ id }) => id));
const canEditMessage = computed(
    () => writable.value && !send.isPending.value && !activeTurn.value && !attachmentBusy.value,
);
const paneOpen = ref(false);
const selectedReport = ref<string>();
const readingWide = computed(() =>
    layout.wide.value ? layout.width('reading') === layout.max('reading') : undefined,
);
function toggleReadingWidth() {
    if (readingWide.value === undefined) return;
    if (readingWide.value) layout.reset('reading');
    else layout.resize('reading', layout.max('reading'));
}
const paneTitle = computed(() => (selectedReport.value ? '报告阅读' : '项目概览'));
const heading = ref<HTMLElement>();
const composer = ref<HTMLTextAreaElement>();
const history = ref<HTMLDivElement>();
const paneId = `thread-context-${useId()}`;
const messageId = `thread-message-${useId()}`;
const hintId = `thread-hint-${useId()}`;
const renameId = `thread-rename-${useId()}`;
const autonomyId = `thread-autonomy-${useId()}`;
const taskPickerId = `thread-task-${useId()}`;
const titleId = `thread-title-${useId()}`;
const headerError = ref('');
const editing = ref(false);
const title = ref('');
const titleInput = ref<HTMLInputElement>();
const update = useSessionMutation(updateThreadEndpoint, lifecycle);
let disposed = false;
onScopeDispose(() => {
    disposed = true;
});
let follow = true;

watch(
    history,
    (element) => {
        if (element) element.scrollTop = element.scrollHeight;
    },
    { flush: 'post' },
);
watch(
    () => snapshot.value?.lastSeq,
    (seq, before) => {
        if (history.value && seq !== before && follow)
            history.value.scrollTop = history.value.scrollHeight;
    },
    { flush: 'post' },
);
function trackScroll() {
    const element = history.value;
    if (element) follow = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}
function refKey(ref: ThreadReportRef) {
    return JSON.stringify([
        ref.id,
        ref.anchor?.kind,
        ref.anchor?.paragraphIndex,
        ref.anchor?.kind === 'claim' ? ref.anchor.claimId : undefined,
    ]);
}
function refTitle(ref: ThreadReportRef) {
    return ref.anchor
        ? `${reportTitle(ref.id)} · 第 ${ref.anchor.paragraphIndex + 1} 段`
        : reportTitle(ref.id);
}
function removeRef(ref: ThreadReportRef) {
    if (canEditMessage.value)
        reportRefs.value = reportRefs.value.filter((item) => refKey(item) !== refKey(ref));
}
function toggleRef(id: string) {
    if (!canEditMessage.value) return;
    if (reportIds.value.includes(id))
        reportRefs.value = reportRefs.value.filter((ref) => ref.id !== id);
    else if (reportRefs.value.length < reportRefLimit.value)
        reportRefs.value = [...reportRefs.value, { kind: 'report', id }];
}
function keyboardSend(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void sendMessage();
}
function retryText(item: ThreadItem) {
    if (item.turnId && ['failed', 'canceled'].includes(item.status ?? ''))
        return retryContent(item.turnId)?.text;
}
function restoreMessage(item: ThreadItem) {
    if (!canEditMessage.value) return;
    const content = item.turnId && retryContent(item.turnId);
    if (!content) return;
    message.value = content.text;
    reportRefs.value = content.refs;
    sourceRefs.value = content.sources;
    attachmentRefs.value = content.attachments;
    taskRefId.value = content.taskId;
    autonomy.value = content.autonomy;
    composer.value?.focus();
}
function focusItem(id: string) {
    paneOpen.value = false;
    void nextTick(() => {
        const item = document.getElementById(`thread-item-${id}`);
        item?.focus();
        item?.scrollIntoView({ block: 'nearest' });
    });
}
function readReport(id: string) {
    if (slots.context) {
        selectedReport.value = id;
        paneOpen.value = true;
    }
}
function closeReport() {
    selectedReport.value = undefined;
}
const sourceNames = ref(new Map<string, string>());
function sourceKey(source: ThreadSourceRef) {
    return source.reportId + '/' + source.snapshotId;
}
function sourceTitle(source: ThreadSourceRef) {
    return sourceNames.value.get(sourceKey(source)) ?? reportTitle(source.reportId);
}
function removeSource(source: ThreadSourceRef) {
    if (canEditMessage.value)
        sourceRefs.value = sourceRefs.value.filter((ref) => sourceKey(ref) !== sourceKey(source));
}
const referenceLimitError = '一条消息最多添加 3 条引用，包括来源、附件和关联任务。';
function returnToComposer() {
    paneOpen.value = false;
    void nextTick(() => composer.value?.focus());
}
function citeSource({ reportId, snapshotId, title }: ProjectReportSourceCitation) {
    if (!canEditMessage.value) return;
    const next: ThreadSourceRef = { kind: 'source', reportId, snapshotId };
    const key = sourceKey(next);
    if (!sourceRefs.value.some((ref) => sourceKey(ref) === key)) {
        if (remainingReferences.value === 0) {
            sendError.value = referenceLimitError;
            returnToComposer();
            return;
        }
        sourceRefs.value = [...sourceRefs.value, next];
    }
    sourceNames.value.set(key, title);
    sendError.value = '';
    returnToComposer();
}
function quoteReport(reference: ProjectReportCitation) {
    if (!canEditMessage.value) return;
    const { reportId, source, claimId, paragraphIndex, text } = reference;
    if (
        !Number.isInteger(paragraphIndex) ||
        paragraphIndex < 0 ||
        paragraphIndex > 999 ||
        (source === 'claim' && !claimId)
    )
        return;
    const next: ThreadReportRef = {
        kind: 'report',
        id: reportId,
        anchor:
            source === 'claim'
                ? { kind: 'claim', claimId: claimId!, paragraphIndex }
                : { kind: source, paragraphIndex },
    };
    if (!reportRefs.value.some((ref) => refKey(ref) === refKey(next))) {
        const retained = reportRefs.value.filter((ref) => ref.id !== reportId || ref.anchor);
        if (retained.length >= reportRefLimit.value) {
            sendError.value = referenceLimitError;
            returnToComposer();
            return;
        }
        reportRefs.value = [...retained, next];
        sendError.value = '';
    }
    reportRefPreviews.value.set(refKey(next), text);
    returnToComposer();
}
function toggleRename() {
    if (update.isPending.value || !thread.value) return;
    if (editing.value) {
        closeRename();
        return;
    }
    title.value = thread.value.title;
    editing.value = true;
    headerError.value = '';
    void nextTick(() => {
        titleInput.value?.focus();
        titleInput.value?.select();
    });
}
function closeRename() {
    editing.value = false;
    void nextTick(() => heading.value?.focus());
}
async function updateMetadata(body: UpdateProjectThread) {
    const scope = lifecycle.capture();
    if (update.isPending.value) return false;
    headerError.value = '';
    try {
        const { data } = await update.mutateAsync({
            input: { params: { threadId: props.threadId }, body },
        });
        if (disposed || !scope.isCurrent()) return false;
        if (data.id !== props.threadId || data.projectId !== props.projectId)
            throw new Error('会话回执不匹配');
        updateThread(data);
        void invalidateProjectThreads(lifecycle, props.projectId);
        return true;
    } catch (error) {
        if (!disposed && scope.isCurrent()) headerError.value = toApiError(error).message;
        return false;
    }
}
async function saveTitle() {
    const value = title.value.trim();
    if (value && (value === thread.value?.title || (await updateMetadata({ title: value }))))
        closeRename();
}
function changeArchived() {
    if (thread.value) void updateMetadata({ archived: !thread.value.archivedAt });
}
</script>

<style scoped>
.thread-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    block-size: 100%;
    min-inline-size: 0;
    min-block-size: 0;
}
.thread-center {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-inline-size: 0;
    min-block-size: 0;
}
.thread-header {
    @apply grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 py-2.5 bg-surface
        [border-bottom:1px_solid_var(--scova-border)];
}
.thread-rename {
    @apply col-span-full flex flex-wrap items-center gap-2;
}
.thread-rename .thread-input {
    @apply flex-1 min-w-[8rem];
}
.thread-history {
    @apply min-h-0 min-w-0 overflow-auto [overscroll-behavior:contain] keyboard-focus-inset;
    scrollbar-gutter: stable;
    padding-block: clamp(1rem, 3vh, 2rem);
}
.thread-lane {
    @apply mx-auto w-full min-w-0 max-w-[48rem] box-border px-[clamp(0.875rem,2vw,2rem)];
}
.thread-empty {
    @apply grid gap-3 min-w-0 justify-items-center text-center py-8 break-anywhere;
}
.thread-empty :deep(.app-icon) {
    @apply text-primary text-3xl;
}
.thread-footer {
    @apply min-w-0 overflow-y-auto pb-3 pt-2 [max-block-size:52dvh];
}
.thread-composer {
    @apply grid gap-2 p-3 bg-surface border-theme rounded-3 min-w-0;
}
.thread-input {
    @apply min-w-0 max-w-full px-3 py-2 box-border rounded-2 bg-surface text-default
        border-theme keyboard-focus-inset font-inherit;
}
.thread-ref-picker {
    @apply text-sm min-w-0 max-w-full;
}
.reference-chip {
    @apply flex gap-2 items-center rounded-2 px-2 min-w-0 max-w-full text-sm
        [background:var(--scova-selected)];
}
.reference-chip button {
    @apply min-h-8 min-w-8 border-0 bg-transparent text-default text-xl cursor-pointer keyboard-focus-inset;
}
@media (max-width: 39.999rem) {
    .thread-header {
        grid-template-columns: minmax(0, 1fr);
    }
    .thread-header-actions {
        justify-content: flex-start;
    }
}
@media (min-width: 72rem) {
    .thread-workspace {
        grid-template-columns: minmax(24rem, 1fr) auto;
    }
}
</style>
