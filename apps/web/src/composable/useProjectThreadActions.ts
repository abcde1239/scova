import {
    ProjectThreadAttachmentRefSchema,
    ProjectThreadReportRefSchema,
    ProjectThreadSourceRefSchema,
    parseContract,
    type ProjectAutonomy,
    type ProjectThreadAttachmentRef,
} from '@scova/models';
import { computed, onScopeDispose, reactive, ref, shallowRef, watch, type ComputedRef } from 'vue';
import {
    approveThreadItemEndpoint,
    cancelThreadTurnEndpoint,
    rejectThreadItemEndpoint,
    undoThreadItemEndpoint,
    type ThreadDecision,
    sendThreadTurnEndpoint,
    THREAD_MESSAGE_MAX_LENGTH,
    type ThreadItem,
    type ThreadReportRef,
    type ThreadSourceRef,
    type ThreadTurnInput,
} from '@/api/project-threads';
import { toApiError } from '@/api/errors';
import { cancelRunEndpoint } from '@/api/runs';
import { invalidateProjectThreads } from '@/composable/useProjectThreads';
import { useSessionLifecycle, useSessionMutation } from '@/composable/useSessionQuery';

type ActionState = {
    status: string;
    taskId?: string | null;
    runId?: string | null;
    undoable?: boolean;
};
const terminalTurn = new Set(['completed', 'failed', 'canceled']);

export function useProjectThreadActions(
    projectId: string,
    threadId: string,
    items: ComputedRef<ThreadItem[]>,
    writable: ComputedRef<boolean>,
) {
    const lifecycle = useSessionLifecycle();
    const params = { threadId };
    const send = useSessionMutation(sendThreadTurnEndpoint, lifecycle);
    const cancel = useSessionMutation(cancelThreadTurnEndpoint, lifecycle);
    const approve = useSessionMutation(approveThreadItemEndpoint, lifecycle);
    const reject = useSessionMutation(rejectThreadItemEndpoint, lifecycle);
    const undo = useSessionMutation(undoThreadItemEndpoint, lifecycle);
    const cancelRun = useSessionMutation(cancelRunEndpoint, lifecycle);
    const runFeedback = reactive(
        new Map<string, { busy?: boolean; status?: string; error?: string }>(),
    );
    const taskRefId = ref('');
    const autonomy = ref<ProjectAutonomy>();
    const message = ref('');
    const reportRefs = ref<ThreadReportRef[]>([]);
    const sourceRefs = ref<ThreadSourceRef[]>([]);
    const attachmentRefs = ref<ProjectThreadAttachmentRef[]>([]);
    const attachmentBusy = ref(false);
    const submittedAutonomy = new Map<string, ProjectAutonomy>();
    const sendError = ref('');
    const feedback = ref('');
    const request = shallowRef<ThreadTurnInput>();
    const runningReceipt = ref<string>();
    const decisions = reactive(new Map<string, ActionState>());
    const decisionBusy = reactive(new Map<string, ThreadDecision>());
    const decisionErrors = reactive(new Map<string, string>());
    let disposed = false;
    onScopeDispose(() => {
        disposed = true;
    });
    const states = computed(() => {
        const byTurn = new Map<string, ThreadItem>();
        for (const item of items.value) {
            if (
                item.turnId &&
                item.kind === 'message' &&
                (item.status === 'running' || terminalTurn.has(item.status ?? ''))
            )
                byTurn.set(item.turnId, item);
        }
        return byTurn;
    });
    const sourceMessages = computed(
        () =>
            new Map(
                items.value.flatMap((item) =>
                    item.turnId &&
                    item.kind === 'message' &&
                    item.payload.role === 'user' &&
                    typeof item.payload.text === 'string'
                        ? [[item.turnId, { text: item.payload.text, refs: item.refs }] as const]
                        : [],
                ),
            ),
    );
    const activeTurn = computed(() => {
        const active = [...states.value.values()].findLast((item) => item.status === 'running');
        const optimisticallyRunning = runningReceipt.value;
        return (
            active?.turnId ??
            (optimisticallyRunning && !states.value.has(optimisticallyRunning)
                ? optimisticallyRunning
                : undefined)
        );
    });
    const outcomeByAction = computed(() => {
        const result = new Map<string, ActionState>();
        for (const item of items.value) {
            const { actionId, runId, taskId, undoable } = item.payload;
            if (
                (item.kind === 'plan' || item.kind === 'schedule') &&
                typeof actionId === 'string' &&
                item.status
            )
                result.set(actionId, {
                    status: item.status,
                    runId: typeof runId === 'string' ? runId : undefined,
                    taskId: typeof taskId === 'string' ? taskId : undefined,
                    undoable: undoable === true,
                });
        }
        for (const [id, receipt] of decisions) {
            const streamed = result.get(id);
            if (!streamed || (receipt.status === 'undone' && streamed.status !== 'undone'))
                result.set(id, receipt);
        }
        return result;
    });
    const canSend = computed(
        () =>
            writable.value &&
            !attachmentBusy.value &&
            !send.isPending.value &&
            !activeTurn.value &&
            !cancel.isPending.value &&
            !!message.value.trim() &&
            message.value.length <= THREAD_MESSAGE_MAX_LENGTH,
    );
    function currentBody() {
        return {
            message: message.value.trim(),
            refs: [
                ...reportRefs.value,
                ...sourceRefs.value,
                ...attachmentRefs.value,
                ...(taskRefId.value ? [{ kind: 'task' as const, id: taskRefId.value }] : []),
            ],
            ...(autonomy.value ? { autonomy: autonomy.value } : {}),
        };
    }
    function sameInput(left: ThreadTurnInput, right: Omit<ThreadTurnInput, 'turnId'>) {
        return (
            left.message === right.message &&
            left.autonomy === right.autonomy &&
            JSON.stringify(left.refs) === JSON.stringify(right.refs)
        );
    }
    function retryContent(turnId: string) {
        const source = sourceMessages.value.get(turnId);
        if (!source) return;
        const references = source.refs;
        const refs = references.flatMap((ref) => {
            if (
                typeof ref !== 'object' ||
                ref === null ||
                !('kind' in ref) ||
                ref.kind !== 'report'
            )
                return [];
            try {
                return [parseContract(ProjectThreadReportRefSchema, ref)];
            } catch {
                return [];
            }
        });
        const sources = references.flatMap((ref) => {
            if (!ref || typeof ref !== 'object' || !('kind' in ref) || ref.kind !== 'source')
                return [];
            try {
                return [parseContract(ProjectThreadSourceRefSchema, ref)];
            } catch {
                return [];
            }
        });
        const attachments = references.flatMap((ref) => {
            try {
                return [parseContract(ProjectThreadAttachmentRefSchema, ref)];
            } catch {
                return [];
            }
        });
        const task = references.find(
            (ref): ref is { kind: 'task'; id: string } =>
                !!ref &&
                typeof ref === 'object' &&
                'kind' in ref &&
                ref.kind === 'task' &&
                'id' in ref &&
                typeof ref.id === 'string',
        );
        return {
            text: source.text,
            refs,
            sources,
            attachments,
            taskId: task?.id ?? '',
            autonomy: submittedAutonomy.get(turnId),
        };
    }
    function clearAccepted(input: ThreadTurnInput) {
        if (request.value?.turnId !== input.turnId) return;
        request.value = undefined;
        if (input.autonomy) submittedAutonomy.set(input.turnId, input.autonomy);
        if (sameInput(input, currentBody())) {
            message.value = '';
            reportRefs.value = [];
            sourceRefs.value = [];
            attachmentRefs.value = [];
            taskRefId.value = '';
            autonomy.value = undefined;
        }
        sendError.value = '';
    }
    watch(states, (current) => {
        const input = request.value;
        if (input && current.has(input.turnId)) clearAccepted(input);
    });
    async function sendMessage() {
        if (!canSend.value) return;
        const scope = lifecycle.capture();
        const current = () => !disposed && scope.isCurrent();
        const body = currentBody();
        const previous = request.value;
        const turnId =
            previous && sameInput(previous, body) ? previous.turnId : crypto.randomUUID();
        const input = { ...body, turnId };
        request.value = input;
        sendError.value = '';
        feedback.value = '';
        try {
            const { data } = await send.mutateAsync({ input: { params, body: input } });
            if (!current()) return;
            if (data.turnId !== turnId) throw new Error('轮次回执不匹配');
            runningReceipt.value = data.status === 'running' ? turnId : undefined;
            clearAccepted(input);
            if (data.status === 'failed') feedback.value = '本轮处理失败，可在记录中编辑并重试。';
            if (data.status === 'canceled') feedback.value = '已停止本轮。';
            void invalidateProjectThreads(lifecycle, projectId);
        } catch (error) {
            if (current() && request.value?.turnId === turnId)
                sendError.value = toApiError(error).message;
        }
    }
    async function stopTurn() {
        const turnId = activeTurn.value;
        if (!turnId || !writable.value || cancel.isPending.value) return;
        const scope = lifecycle.capture();
        sendError.value = '';
        try {
            const { data } = await cancel.mutateAsync({ input: { params: { ...params, turnId } } });
            if (disposed || !scope.isCurrent()) return;
            if (data.turnId !== turnId) throw new Error('轮次回执不匹配');
            if (data.status !== 'running') runningReceipt.value = undefined;
            if (data.status === 'canceled') feedback.value = '已停止本轮。';
        } catch (error) {
            if (!disposed && scope.isCurrent()) sendError.value = toApiError(error).message;
        }
    }
    async function decide(item: ThreadItem, action: ThreadDecision) {
        const state = outcomeByAction.value.get(item.id);
        const allowed =
            action === 'undo'
                ? item.kind === 'schedule' &&
                  (state?.status ?? item.status) === 'applied' &&
                  (state?.undoable ?? item.payload.undoable) === true
                : !state && item.status === 'pending';
        if (!writable.value || decisionBusy.has(item.id) || !allowed) return;
        const scope = lifecycle.capture();
        decisionErrors.delete(item.id);
        decisionBusy.set(item.id, action);
        try {
            const mutation = { approve, reject, undo }[action];
            const { data } = await mutation.mutateAsync({
                input: { params: { ...params, itemId: item.id } },
            });
            if (disposed || !scope.isCurrent()) return;
            if (data.actionId !== item.id) throw new Error('动作回执不匹配');
            decisions.set(item.id, { ...data, undoable: 'undoable' in data && data.undoable });
            feedback.value =
                action === 'undo'
                    ? '已撤销此周期动作。'
                    : action === 'reject'
                      ? '已拒绝此提案。'
                      : item.kind === 'schedule'
                        ? '已应用周期动作。'
                        : '已批准研究。';
        } catch (error) {
            if (!disposed && scope.isCurrent())
                decisionErrors.set(item.id, toApiError(error).message);
        } finally {
            decisionBusy.delete(item.id);
        }
    }
    async function stopRun(runId: string) {
        if (runFeedback.get(runId)?.busy) return;
        const scope = lifecycle.capture();
        runFeedback.set(runId, { busy: true });
        try {
            const { data } = await cancelRun.mutateAsync({ input: { params: { runId } } });
            if (disposed || !scope.isCurrent()) return;
            if (data.run.id !== runId) throw new Error('运行回执不匹配');
            runFeedback.set(runId, { status: data.run.status });
        } catch (error) {
            if (!disposed && scope.isCurrent())
                runFeedback.set(runId, { error: toApiError(error).message });
        }
    }
    return {
        taskRefId,
        attachmentRefs,
        attachmentBusy,
        autonomy,
        runFeedback,
        stopRun,
        message,
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
    };
}
