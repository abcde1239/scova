import { createHash } from 'node:crypto';
import { PageQuerySchema, TaskConfigSchema, UuidSchema, parseContract } from '@scova/models';
import {
    WorkflowDetailSchema,
    WorkflowDraftInputSchema,
    WorkflowRunSchema,
    WorkflowSchema,
    WorkflowStartInputSchema,
    WorkflowVersionSchema,
    type WorkflowBinding,
} from '@scova/models';
import type { WorkflowRow, WorkflowRunRow, WorkflowVersionRow } from '@scova/db';
import type { ApiServices } from '@/app/services';
import { createTaskStore } from '@/repo/tasks.ts';
import { bindWorkflowResearch } from '@/repo/workflow-research.ts';
import { advanceWorkflow } from '@/service/workflow-checkpoint.ts';
import {
    activeWorkflowStatuses,
    createWorkflowRepository,
    type WorkflowStore,
} from '@/repo/workflows.ts';
import { ownedTask } from '@/service/tasks.ts';
import { workflowCheckpointNodes, workflowStages } from '@/service/workflow-graph.ts';
import { ApiError } from '@/utils/errors.ts';

function requireId(id: string) {
    if (!new RegExp(UuidSchema.pattern!).test(id)) notFound();
}
function notFound(): never {
    throw new ApiError(404, 'NOT_FOUND', '资源不存在');
}
async function requireWorkflow(store: WorkflowStore, userId: string, id: string, lock = false) {
    requireId(id);
    return (await store.find(userId, id, lock)) ?? notFound();
}
async function requireRun(store: WorkflowStore, userId: string, id: string, lock = false) {
    requireId(id);
    return (await store.findRun(userId, id, lock)) ?? notFound();
}
function checkRevision(workflow: WorkflowRow, expected: number) {
    if (workflow.revision !== expected)
        throw new ApiError(412, 'REVISION_MISMATCH', '工作流草稿已更新，请加载最新版本后重试');
}
function summary(row: WorkflowRow) {
    return parseContract(WorkflowSchema, {
        id: row.id,
        title: row.title,
        revision: row.revision,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    });
}
function versionDto(row: WorkflowVersionRow) {
    return parseContract(WorkflowVersionSchema, {
        id: row.id,
        workflowId: row.workflowId,
        version: row.version,
        draftRevision: row.draftRevision,
        title: row.title,
        graph: row.graphJson,
        bindings: row.bindingsJson,
        publishedAt: row.publishedAt.toISOString(),
    });
}
function detail(row: WorkflowRow, version: WorkflowVersionRow | null) {
    return parseContract(WorkflowDetailSchema, {
        workflow: summary(row),
        draft: row.draftJson,
        publishedVersion: version ? versionDto(version) : null,
    });
}
function runDto(row: WorkflowRunRow) {
    return parseContract(WorkflowRunSchema, {
        id: row.id,
        workflowId: row.workflowId,
        versionId: row.versionId,
        mode: row.mode,
        status: row.status,
        nodes: row.nodesJson,
        createdAt: row.createdAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        failureCode: row.failureCode,
    });
}
function pagination(input: unknown) {
    const { limit, cursor } = parseContract(PageQuerySchema, input);
    if (cursor && !new RegExp(UuidSchema.pattern!).test(cursor)) invalidCursor();
    return { limit: Math.min(limit ?? 20, 100), cursor };
}
function invalidCursor(): never {
    throw new ApiError(400, 'INVALID_CURSOR', '工作流分页游标不可用');
}
function page<Row extends { id: string }, Item>(
    rows: Row[] | null,
    limit: number,
    map: (row: Row) => Item,
) {
    if (!rows) invalidCursor();
    const items = rows.slice(0, limit).map(map);
    return { items, nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
}

export function createWorkflowService(services: Pick<ApiServices, 'db' | 'clock'>) {
    const repository = createWorkflowRepository(services.db);
    return {
        async list(userId: string, input: unknown) {
            const { limit, cursor } = pagination(input);
            return page(await repository.read().list(userId, limit + 1, cursor), limit, summary);
        },
        async get(userId: string, workflowId: string) {
            const store = repository.read();
            const row = await requireWorkflow(store, userId, workflowId);
            return detail(row, await store.findVersion(userId, row.id));
        },
        async listVersions(userId: string, workflowId: string, input: unknown) {
            const { limit, cursor } = pagination(input);
            const store = repository.read();
            const workflow = await requireWorkflow(store, userId, workflowId);
            return page(
                await store.listVersions(userId, workflow.id, limit + 1, cursor),
                limit,
                versionDto,
            );
        },
        async getVersion(userId: string, workflowId: string, versionId: string) {
            requireId(workflowId);
            requireId(versionId);
            const row = await repository.read().findVersion(userId, workflowId, versionId);
            return versionDto(row ?? notFound());
        },
        async create(userId: string, input: unknown) {
            const { title, graph } = parseContract(WorkflowDraftInputSchema, input);
            const now = services.clock();
            const row = await repository.read().insert({
                userId,
                title: title.trim(),
                draftJson: graph,
                createdAt: now,
                updatedAt: now,
            });
            return detail(row, null);
        },
        async updateDraft(
            userId: string,
            workflowId: string,
            input: unknown,
            expectedRevision: number,
        ) {
            const { title, graph } = parseContract(WorkflowDraftInputSchema, input);
            return repository.transaction(async (store) => {
                const workflow = await requireWorkflow(store, userId, workflowId, true);
                checkRevision(workflow, expectedRevision);
                const row = await store.updateDraft(userId, workflow.id, {
                    title: title.trim(),
                    draftJson: graph,
                    revision: workflow.revision + 1,
                    updatedAt: services.clock(),
                });
                return detail(row, await store.findVersion(userId, row.id));
            });
        },
        async publish(userId: string, workflowId: string, expectedRevision: number) {
            return repository.transaction(async (store, tx) => {
                const row = await requireWorkflow(store, userId, workflowId, true);
                checkRevision(row, expectedRevision);
                const latest = await store.findVersion(userId, row.id);
                if (latest?.draftRevision === row.revision) return detail(row, latest);
                const ordered = workflowStages(row.draftJson).flat();
                const taskIds = [
                    ...new Set(
                        ordered.flatMap((node) =>
                            node.type === 'study' ? [node.taskId.toLowerCase()] : [],
                        ),
                    ),
                ].sort();
                const tasks = createTaskStore(tx);
                const pinned = new Map<string, string>();
                // Acquire shared Task locks in UUID order even when workflows order their nodes differently.
                for (const taskId of taskIds) {
                    await tasks.lockTask(taskId, userId);
                    const task = await ownedTask(taskId, userId, tasks);
                    if (task.status === 'archived')
                        throw new ApiError(409, 'TASK_ARCHIVED', '已归档任务不能发布为研究节点');
                    const version =
                        task.currentVersionId &&
                        (await tasks.findVersion(task.currentVersionId, userId, taskId));
                    if (!version)
                        throw new ApiError(422, 'TASK_VERSION_MISSING', '研究节点缺少有效任务配置');
                    const config = parseContract(TaskConfigSchema, version.configJson);
                    if (
                        config.agentProviderId &&
                        !(await tasks.findAgentProvider(userId, config.agentProviderId))
                    )
                        throw new ApiError(
                            422,
                            'AGENT_PROVIDER_UNAVAILABLE',
                            '研究节点的执行 Agent 配置不可用',
                        );
                    pinned.set(taskId, version.id);
                }
                const bindings: WorkflowBinding[] = ordered.flatMap((node) => {
                    if (node.type !== 'study') return [];
                    const taskId = node.taskId.toLowerCase();
                    return [{ nodeId: node.id, taskId, taskVersionId: pinned.get(taskId)! }];
                });
                const version = await store.publish({
                    userId,
                    workflowId: row.id,
                    version: (latest?.version ?? 0) + 1,
                    draftRevision: row.revision,
                    title: row.title,
                    graphJson: row.draftJson,
                    bindingsJson: bindings,
                    publishedAt: services.clock(),
                });
                return detail(row, version);
            });
        },
        async start(userId: string, workflowId: string, input: unknown, key: string) {
            const { versionId, mode = 'live' } = parseContract(WorkflowStartInputSchema, input);
            const keyHash = createHash('sha256').update(key).digest('hex');
            return repository.transaction(async (store) => {
                const workflow = await requireWorkflow(store, userId, workflowId, true);
                const replay = await store.findStartedRun(userId, workflow.id, keyHash);
                if (replay) {
                    if (replay.versionId !== versionId.toLowerCase() || replay.mode !== mode)
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_PAYLOAD_MISMATCH',
                            '同一幂等键不能提交不同运行参数',
                        );
                    return { run: runDto(replay), reused: true };
                }
                const version = await store.findVersion(userId, workflow.id, versionId);
                if (!version) notFound();
                const nodes = workflowCheckpointNodes(version.graphJson, version.bindingsJson);
                const now = services.clock();
                const run = await store.insertRun({
                    userId,
                    workflowId: workflow.id,
                    versionId: version.id,
                    mode,
                    nodesJson: nodes,
                    startKeyHash: keyHash,
                    createdAt: now,
                    nextCheckAt: now,
                });
                return { run: runDto(run), reused: false };
            });
        },
        async listRuns(userId: string, workflowId: string, input: unknown) {
            const { limit, cursor } = pagination(input);
            const store = repository.read();
            const workflow = await requireWorkflow(store, userId, workflowId);
            return page(
                await store.listRuns(userId, workflow.id, limit + 1, cursor),
                limit,
                runDto,
            );
        },
        async getRun(userId: string, runId: string) {
            return runDto(await requireRun(repository.read(), userId, runId));
        },
        async cancel(userId: string, runId: string) {
            return repository.transaction(async (store, tx) => {
                const row = await requireRun(store, userId, runId, true);
                if (
                    row.status === 'cancel_requested' ||
                    !activeWorkflowStatuses.some((status) => status === row.status)
                )
                    return runDto(row);
                const now = services.clock();
                const checkpoint = await advanceWorkflow(
                    { ...row, status: 'cancel_requested' },
                    now,
                    0,
                    bindWorkflowResearch(tx, row, now),
                );
                return runDto(await store.writeCheckpoint(row, checkpoint));
            });
        },
    };
}
