import { createHash } from 'node:crypto';
import {
    type Task as StoredTask,
    type TaskVersion as StoredTaskVersion,
    type DatabaseTransaction,
} from '@scova/db';
import { nextScheduledAt } from '@scova/shared';
import { effectiveRunScopeHash, researchComparisonScopeHash } from '@/utils/research-scope.ts';
import {
    CreateTaskInputSchema,
    DEFAULT_TASK_BUDGET_LIMITS,
    PageQuerySchema,
    TaskDetailResponseSchema,
    TaskListResponseSchema,
    TaskConfigSchema,
    TaskSchema,
    UpdateTaskInputSchema,
    parseContract,
    type TaskConfig,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { ApiError } from '@/utils/errors.ts';
import { createTaskRepo, createTaskStore, type TaskStore } from '@/repo/tasks.ts';
import { createProjectStore } from '@/repo/projects.ts';
import { createRunStore } from '@/repo/runs.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertBudget(config: TaskConfig): void {
    const fieldErrors = Object.entries(DEFAULT_TASK_BUDGET_LIMITS)
        .filter(
            ([key, maximum]) =>
                config.budget[key as keyof typeof DEFAULT_TASK_BUDGET_LIMITS]! > maximum,
        )
        .map(([key, maximum]) => ({
            path: `/config/budget/${key}`,
            message: `部署默认上限为 ${maximum}`,
        }));
    if (fieldErrors.length)
        throw new ApiError(422, 'BUDGET_EXCEEDED', '任务预算超过部署默认上限', fieldErrors);
}

function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
                .sort()
                .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
        );
    }
    return value;
}

/** 交付形式现已影响采集目标；形式集合参与范围，首选打开顺序不参与。 */
export function comparisonScopeHash(config: TaskConfig): string {
    return researchComparisonScopeHash(config);
}

export function nextRunAt(config: TaskConfig, now: Date): Date | null {
    return nextScheduledAt(config, now);
}

function listItem(task: StoredTask) {
    return parseContract(TaskSchema, {
        id: task.id,
        title: task.title,
        status: task.status,
        revision: task.revision,
        currentVersionId: task.currentVersionId!,
        nextRunAt: task.nextRunAt?.toISOString() ?? null,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
    });
}

function taskResponse(
    task: StoredTask,
    version: StoredTaskVersion,
    baselineResetRequired: boolean,
) {
    return parseContract(TaskDetailResponseSchema, {
        task: listItem(task),
        version: {
            id: version.id,
            taskId: version.taskId,
            version: version.version,
            configSchemaVersion: version.configSchemaVersion as 1,
            config: version.configJson,
            comparisonScopeHash: version.comparisonScopeHash,
            createdAt: version.createdAt.toISOString(),
        },
        baselineResetRequired,
    });
}

/** 同时供任务与 Run 服务使用，owner 缺失统一映射为 404。 */
export async function ownedTask(
    taskId: string,
    userId: string,
    store: Pick<TaskStore, 'findTask'>,
) {
    if (!UUID.test(taskId)) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
    const task = await store.findTask(taskId, userId);
    if (!task) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
    return task;
}

function cursorFor(task: StoredTask, updatedAt: string): string {
    return Buffer.from(JSON.stringify({ updatedAt, id: task.id }), 'utf8').toString('base64url');
}
function decodeCursor(value: string | undefined): { updatedAt: string; id: string } | undefined {
    if (!value) return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
            updatedAt?: string;
            id?: string;
        };
        if (
            !parsed.updatedAt ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.updatedAt) ||
            !parsed.id ||
            !UUID.test(parsed.id)
        )
            throw new Error();
        const updatedAt = new Date(parsed.updatedAt);
        if (
            !Number.isFinite(updatedAt.getTime()) ||
            updatedAt.toISOString() !== `${parsed.updatedAt.slice(0, 23)}Z`
        )
            throw new Error();
        return { updatedAt: parsed.updatedAt, id: parsed.id };
    } catch {
        throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效');
    }
}

/** 任务业务规则与事务编排；持久化只通过 repo 的领域操作完成。 */
export function createTaskService(services: ApiServices) {
    const repo = createTaskRepo(services);
    async function replayTaskSubmission(
        userId: string,
        receipt: { taskId?: string; runId: string | null },
        tx: DatabaseTransaction,
        projectId?: string,
    ) {
        const store = createTaskStore(tx);
        const run = receipt.runId ? await createRunStore(tx).findRun(receipt.runId, userId) : null;
        const taskId = receipt.taskId ?? run?.taskId;
        if (!taskId) throw new ApiError(404, 'NOT_FOUND', '原执行已不可用');
        const task = await ownedTask(taskId, userId, store);
        if (projectId && !(await createProjectStore(tx).hasTask(userId, projectId, task.id)))
            throw new ApiError(409, 'PROJECT_TASK_MOVED', '原任务已移出该项目');
        if (receipt.runId && run?.taskId !== task.id)
            throw new ApiError(404, 'NOT_FOUND', '原执行已不可用');
        const version = run
            ? await store.findVersion(run.taskVersionId, userId, task.id)
            : await store.findInitialVersion(userId, task.id);
        if (!version) throw new ApiError(404, 'NOT_FOUND', '原任务版本已不可用');
        // 保留提交时的配置与修订，防止用旧配置和最新修订覆盖之后的编辑。
        const submittedTask =
            task.currentVersionId === version.id
                ? task
                : {
                      ...task,
                      currentVersionId: version.id,
                      revision: 1,
                      title: parseContract(TaskConfigSchema, version.configJson).title,
                  };
        return { detail: taskResponse(submittedTask, version, false), runId: run?.id ?? null };
    }

    async function createConfiguredTask(
        userId: string,
        body: unknown,
        key?: string,
        target?: { id?: string; start: boolean },
        transaction?: DatabaseTransaction,
    ) {
        const input = parseContract(CreateTaskInputSchema, body);
        const scope = 'task:create';
        const hash = (value: string) => createHash('sha256').update(value).digest('hex');
        const now = services.clock();
        const create = async (tx: DatabaseTransaction) => {
            const store = createTaskStore(tx);
            const runs = createRunStore(tx);
            const projects = createProjectStore(tx);
            const projectId = target?.id;
            if (projectId && !(await projects.lockProject(userId, projectId)))
                throw new ApiError(404, 'NOT_FOUND', '资源不存在');
            let reservation;
            if (key) {
                const keyHash = hash(key);
                // 保持已有任务创建与项目创建请求的幂等摘要兼容。
                const payloadHash = hash(JSON.stringify(stable({ input, project: target })));
                reservation = await runs.reserveIdempotency({
                    userId,
                    scope,
                    keyHash,
                    payloadHash,
                    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
                });
                if (!reservation) {
                    const receipt = await runs.findIdempotency(userId, scope, keyHash);
                    if (receipt && receipt.payloadHash !== payloadHash)
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_PAYLOAD_MISMATCH',
                            '同一幂等键不能提交不同任务参数',
                        );
                    if (!receipt?.resourceId || receipt.status !== 'completed')
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_PENDING',
                            '相同任务命令仍在处理中，请稍后重试',
                        );
                    if (target)
                        return replayTaskSubmission(
                            userId,
                            target.start
                                ? { runId: receipt.resourceId }
                                : { taskId: receipt.resourceId, runId: null },
                            tx,
                            projectId,
                        );
                    const task = await ownedTask(receipt.resourceId, userId, store);
                    const version = await store.findVersion(
                        task.currentVersionId!,
                        userId,
                        task.id,
                    );
                    if (!version) throw new ApiError(404, 'NOT_FOUND', '原任务版本已不可用');
                    return { detail: taskResponse(task, version, false), runId: null };
                }
            }
            assertBudget(input.config);
            if (
                input.config.agentProviderId &&
                !(await store.findAgentProvider(userId, input.config.agentProviderId))
            )
                throw new ApiError(
                    422,
                    'AGENT_PROVIDER_UNAVAILABLE',
                    '所选执行Agent配置不可用，请重新选择',
                );
            const task = await store.createTask({
                userId,
                title: input.config.title,
                nextRunAt: nextRunAt(input.config, now),
            });
            const scopeHash = comparisonScopeHash(input.config);
            const version = await store.createVersion({
                userId,
                taskId: task.id,
                version: 1,
                inputText: input.inputText,
                configSchemaVersion: 1,
                configJson: input.config,
                comparisonScopeHash: scopeHash,
            });
            const saved = await store.setCurrentVersion(task.id, version.id);
            if (projectId) await projects.associate(userId, projectId, task.id);
            let runId: string | null = null;
            if (target?.start) {
                const run = await runs.createRun({
                    userId,
                    taskId: task.id,
                    taskVersionId: version.id,
                    comparisonScopeHash: effectiveRunScopeHash(scopeHash, 'live'),
                    mode: 'live',
                    trigger: 'manual',
                    budgetJson: input.config.budget,
                    feedbackSnapshotJson: await runs.feedbackSnapshot(userId, task.id),
                    usageJson: {
                        searches: 0,
                        pages: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        estimated: true,
                    },
                });
                await runs.enqueue(run);
                runId = run.id;
            }
            if (reservation) await runs.completeIdempotency(reservation.id, runId ?? task.id, 201);
            return { detail: taskResponse(saved, version, false), runId };
        };
        return transaction ? create(transaction) : services.db().transaction(create);
    }
    return {
        replayProjectTask(
            userId: string,
            projectId: string,
            receipt: { taskId?: string; runId: string | null },
            tx: DatabaseTransaction,
        ) {
            return replayTaskSubmission(userId, receipt, tx, projectId);
        },
        async remove(userId: string, taskId: string, expectedRevision: number) {
            await repo.transaction(async (store) => {
                if (!UUID.test(taskId) || !(await store.lockTask(taskId, userId)).length)
                    throw new ApiError(404, 'NOT_FOUND', '资源不存在');
                const task = await ownedTask(taskId, userId, store);
                if (task.revision !== expectedRevision)
                    throw new ApiError(
                        409,
                        'REVISION_CONFLICT',
                        '任务已变化，请刷新后重新确认清除',
                    );
                if (await store.lockActiveRun(taskId, userId))
                    throw new ApiError(
                        409,
                        'TASK_RUN_ACTIVE',
                        '任务仍有活动执行，请先取消执行，等待结束后再清除',
                    );
                await store.removeTaskData(taskId, userId);
            });
        },
        async list(userId: string, query: unknown) {
            const page = parseContract(PageQuerySchema, query);
            const take = Math.min(page.limit ?? 50, 100);
            const cursor = decodeCursor(page.cursor);
            return repo.readTransaction(async (store) => {
                // Task排序时间可变；游标校验、原生微秒seek与DTO加载必须看到同一快照。
                if (cursor) {
                    const anchor = await store.findTaskCursor(cursor.id, userId);
                    if (!anchor || anchor.cursorTime !== cursor.updatedAt)
                        throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效或已变化');
                }
                const tasks = await store.listTasks(userId, take + 1, cursor);
                return parseContract(TaskListResponseSchema, {
                    items: tasks.slice(0, take).map(({ task }) => listItem(task)),
                    nextCursor:
                        tasks.length > take
                            ? cursorFor(tasks[take - 1]!.task, tasks[take - 1]!.cursorTime)
                            : null,
                });
            });
        },
        async create(userId: string, body: unknown, key?: string) {
            return (await createConfiguredTask(userId, body, key)).detail;
        },
        async start(userId: string, body: unknown, key: string) {
            const { detail, runId } = await createConfiguredTask(userId, body, key, {
                start: true,
            });
            if (!runId) throw new ApiError(500, 'TASK_START_RUN_MISSING', '任务执行信息不可用');
            return { detail, runId };
        },
        createInProject(
            userId: string,
            projectId: string,
            body: unknown,
            key: string,
            start: boolean,
            transaction?: DatabaseTransaction,
        ) {
            return createConfiguredTask(userId, body, key, { id: projectId, start }, transaction);
        },
        async get(userId: string, taskId: string) {
            const task = await ownedTask(taskId, userId, repo);
            const version = await repo.findVersion(task.currentVersionId!, userId, task.id);
            if (!version) throw new ApiError(500, 'TASK_VERSION_MISSING', '任务配置版本不可用');
            return taskResponse(task, version, false);
        },
        async update(userId: string, taskId: string, body: unknown, expectedRevision: number) {
            const input = parseContract(UpdateTaskInputSchema, body);
            assertBudget(input.config);
            const result = await repo
                .transaction(async (store) => {
                    if (!UUID.test(taskId) || !(await store.lockTask(taskId, userId)).length)
                        throw new ApiError(404, 'NOT_FOUND', '资源不存在');
                    const task = await ownedTask(taskId, userId, store);
                    if (
                        input.config.agentProviderId &&
                        !(await store.findAgentProvider(userId, input.config.agentProviderId))
                    )
                        throw new ApiError(
                            422,
                            'AGENT_PROVIDER_UNAVAILABLE',
                            '所选执行Agent配置不可用，请重新选择',
                        );
                    if (task.status === 'archived')
                        throw new ApiError(409, 'TASK_ARCHIVED', '已归档任务不能再编辑');
                    if (task.revision !== expectedRevision)
                        throw new ApiError(
                            409,
                            'REVISION_CONFLICT',
                            '任务已被其他请求修改，请刷新后重试',
                        );
                    const previous = await store.requireVersion(
                        task.currentVersionId!,
                        userId,
                        task.id,
                    );
                    const previousConfig = parseContract(TaskConfigSchema, previous.configJson);
                    const scheduleChanged =
                        previousConfig.timezone !== input.config.timezone ||
                        JSON.stringify(stable(previousConfig.schedule)) !==
                            JSON.stringify(stable(input.config.schedule));
                    const scopeHash = comparisonScopeHash(input.config);
                    // 先原子占位 revision，避免同一修订的并发编辑都创建新版本。
                    const claimed = await store.claimRevision(task.id, userId, expectedRevision, {
                        title: input.config.title,
                        revision: task.revision + 1,
                        ...(task.status !== 'active'
                            ? { nextRunAt: null }
                            : scheduleChanged
                              ? { nextRunAt: nextRunAt(input.config, await store.now()) }
                              : {}),
                        ...(scheduleChanged ? { scheduleRevision: task.scheduleRevision + 1 } : {}),
                    });
                    if (claimed.count !== 1)
                        throw new ApiError(
                            409,
                            'REVISION_CONFLICT',
                            '任务已被其他请求修改，请刷新后重试',
                        );
                    const version = await store.createVersion({
                        userId,
                        taskId: task.id,
                        version: previous.version + 1,
                        inputText: input.inputText ?? previous.inputText,
                        configSchemaVersion: 1,
                        configJson: input.config,
                        comparisonScopeHash: scopeHash,
                    });
                    const updated = await store.setCurrentVersion(task.id, version.id);
                    return {
                        task: updated,
                        version,
                        baselineResetRequired: previous.comparisonScopeHash !== scopeHash,
                    };
                })
                .catch((error: unknown) => {
                    if (repo.isUniqueConflict(error))
                        throw new ApiError(
                            409,
                            'REVISION_CONFLICT',
                            '任务已被其他请求修改，请刷新后重试',
                        );
                    throw error;
                });
            return taskResponse(result.task, result.version, result.baselineResetRequired);
        },
        async transition(
            userId: string,
            taskId: string,
            action: 'pause' | 'resume' | 'archive',
            expectedRevision: number,
        ) {
            return repo.transaction(async (store) => {
                if (!UUID.test(taskId) || !(await store.lockTask(taskId, userId)).length)
                    throw new ApiError(404, 'NOT_FOUND', '资源不存在');
                const task = await ownedTask(taskId, userId, store);
                if (task.revision !== expectedRevision)
                    throw new ApiError(
                        409,
                        'REVISION_CONFLICT',
                        '任务已被其他请求修改，请刷新后重试',
                    );
                if (task.status === 'archived' && action !== 'archive')
                    throw new ApiError(409, 'TASK_ARCHIVED', '已归档任务不能恢复或暂停');
                const version = await store.requireVersion(task.currentVersionId!, userId, task.id);
                const target =
                    action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'archived';
                if (task.status === target) return taskResponse(task, version, false);
                const now = await store.now();
                const config = parseContract(TaskConfigSchema, version.configJson);
                const claimed = await store.claimRevision(task.id, userId, expectedRevision, {
                    status: target,
                    revision: task.revision + 1,
                    scheduleRevision: task.scheduleRevision + 1,
                    nextRunAt: target === 'active' ? nextRunAt(config, now) : null,
                    ...(target === 'archived' ? { archivedAt: now } : {}),
                });
                if (claimed.count !== 1)
                    throw new ApiError(
                        409,
                        'REVISION_CONFLICT',
                        '任务已被其他请求修改，请刷新后重试',
                    );
                if (target === 'archived') {
                    const run = await store.lockActiveRun(task.id, userId);
                    if (run && run.status !== 'cancel_requested') {
                        await store.requestCancel(run.id, await store.now());
                        await store.createCancelOutbox(userId, run.id);
                    }
                }
                return taskResponse(await ownedTask(task.id, userId, store), version, false);
            });
        },
    };
}
