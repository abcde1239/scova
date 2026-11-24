import {
    CreateProjectThreadSchema,
    ProjectThreadItemSchema,
    ProjectActionReceiptSchema,
    ProjectScheduleActionReceiptSchema,
    type ProjectScheduleActionReceipt,
    ProjectTurnReceiptSchema,
    SendProjectTurnSchema,
    type SendProjectTurn,
    ProjectThreadListSchema,
    ProjectThreadSchema,
    ProjectThreadSnapshotSchema,
    UpdateProjectThreadSchema,
    UuidSchema,
    parseContract,
    type CreateProjectThread,
    type ProjectThread,
    type ProjectThreadItem,
    type ProjectThreadSnapshot,
    type UpdateProjectThread,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

export type ThreadItem = Omit<ProjectThreadItem, 'kind'> & { kind: string };
export type ThreadSnapshot = Omit<ProjectThreadSnapshot, 'items'> & { items: ThreadItem[] };
type ProjectParams = { projectId: string };
type ThreadParams = { threadId: string };
const projectParams = {
    parse(value: unknown): ProjectParams {
        return { projectId: parseContract(UuidSchema, record(value).projectId) };
    },
};
const threadParams = {
    parse(value: unknown): ThreadParams {
        return { threadId: parseContract(UuidSchema, record(value).threadId) };
    },
};

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new TypeError('会话响应格式无效');
    return value as Record<string, unknown>;
}

export function parseThreadItem(input: unknown): ThreadItem {
    const value = record(input);
    const kind = value.kind;
    // Validate the stable envelope while allowing newly introduced item kinds.
    if (typeof kind !== 'string' || !/^[a-z0-9_-]{1,48}$/i.test(kind))
        throw new TypeError('会话条目类型无效');
    return { ...parseContract(ProjectThreadItemSchema, { ...value, kind: 'notice' }), kind };
}

function parseSnapshot(input: unknown): ThreadSnapshot {
    const value = record(input);
    if (!Array.isArray(value.items)) throw new TypeError('会话快照格式无效');
    const snapshot = parseContract(ProjectThreadSnapshotSchema, { ...value, items: [] });
    const items = value.items.map(parseThreadItem);
    if (
        items.some(
            (item, index) =>
                item.threadId !== snapshot.thread.id ||
                (index > 0 && item.seq <= items[index - 1]!.seq),
        ) ||
        (items.length > 0 && items.at(-1)?.seq !== snapshot.lastSeq)
    )
        throw new TypeError('会话快照序号无效');
    return { ...snapshot, items };
}

export const projectThreadsEndpoint = defineApiEndpoint<{
    params: ProjectParams;
    data: { items: ProjectThread[] };
}>({
    method: 'GET',
    path: '/projects/:projectId/threads',
    inputValidators: { params: projectParams },
    validator: modelValidator(ProjectThreadListSchema),
});
export const createThreadEndpoint = defineApiEndpoint<{
    params: ProjectParams;
    body: CreateProjectThread;
    data: ProjectThread;
}>({
    method: 'POST',
    path: '/projects/:projectId/threads',
    inputValidators: { params: projectParams, body: modelValidator(CreateProjectThreadSchema) },
    validator: modelValidator(ProjectThreadSchema),
});
export const updateThreadEndpoint = defineApiEndpoint<{
    params: ThreadParams;
    body: UpdateProjectThread;
    data: ProjectThread;
}>({
    method: 'PATCH',
    path: '/threads/:threadId',
    inputValidators: { params: threadParams, body: modelValidator(UpdateProjectThreadSchema) },
    validator: modelValidator(ProjectThreadSchema),
});
export const threadSnapshotEndpoint = defineApiEndpoint<{
    params: ThreadParams;
    data: ThreadSnapshot;
}>({
    method: 'GET',
    path: '/threads/:threadId',
    inputValidators: { params: threadParams },
    validator: { parse: parseSnapshot },
});

export const THREAD_MESSAGE_MAX_LENGTH = SendProjectTurnSchema.properties.message.maxLength ?? 2000;
export type ThreadReportRef = Extract<
    NonNullable<SendProjectTurn['refs']>[number],
    { kind: 'report' }
>;
export type ThreadSourceRef = Extract<
    NonNullable<SendProjectTurn['refs']>[number],
    { kind: 'source' }
>;
export type ThreadTurnInput = SendProjectTurn;
type TurnReceipt = ReturnType<typeof parseContract<typeof ProjectTurnReceiptSchema>>;
export type ThreadActionReceipt =
    | ReturnType<typeof parseContract<typeof ProjectActionReceiptSchema>>
    | ProjectScheduleActionReceipt;
export type ThreadDecision = 'approve' | 'reject' | 'undo';
const actionReceipt = {
    parse(value: unknown): ThreadActionReceipt {
        return Object.hasOwn(record(value), 'command')
            ? parseContract(ProjectScheduleActionReceiptSchema, value)
            : parseContract(ProjectActionReceiptSchema, value);
    },
};

export const sendThreadTurnEndpoint = defineApiEndpoint<{
    params: ThreadParams;
    body: ThreadTurnInput;
    data: TurnReceipt;
}>({
    method: 'POST',
    path: '/threads/:threadId/turns',
    inputValidators: { params: threadParams, body: modelValidator(SendProjectTurnSchema) },
    validator: modelValidator(ProjectTurnReceiptSchema),
});
export const cancelThreadTurnEndpoint = defineApiEndpoint<{
    params: ThreadParams & { turnId: string };
    data: TurnReceipt;
}>({
    method: 'POST',
    path: '/threads/:threadId/turns/:turnId/cancel',
    inputValidators: {
        params: {
            parse(value) {
                return {
                    ...threadParams.parse(value),
                    turnId: parseContract(UuidSchema, record(value).turnId),
                };
            },
        },
    },
    validator: modelValidator(ProjectTurnReceiptSchema),
});
const actionParams = {
    parse(value: unknown) {
        return {
            ...threadParams.parse(value),
            itemId: parseContract(UuidSchema, record(value).itemId),
        };
    },
};

export const approveThreadItemEndpoint = defineApiEndpoint<{
    params: ThreadParams & { itemId: string };
    data: ThreadActionReceipt;
}>({
    method: 'POST',
    path: '/threads/:threadId/items/:itemId/approve',
    inputValidators: { params: actionParams },
    validator: actionReceipt,
});
export const rejectThreadItemEndpoint = defineApiEndpoint<{
    params: ThreadParams & { itemId: string };
    data: ThreadActionReceipt;
}>({
    method: 'POST',
    path: '/threads/:threadId/items/:itemId/reject',
    inputValidators: { params: actionParams },
    validator: actionReceipt,
});

export const undoThreadItemEndpoint = defineApiEndpoint<{
    params: ThreadParams & { itemId: string };
    data: ProjectScheduleActionReceipt;
}>({
    method: 'POST',
    path: '/threads/:threadId/items/:itemId/undo',
    inputValidators: { params: actionParams },
    validator: modelValidator(ProjectScheduleActionReceiptSchema),
});
