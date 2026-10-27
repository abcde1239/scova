import { createHash } from 'node:crypto';
import { nextScheduledAt } from '@scova/utils';
import type { Task as StoredTask, TaskVersion as StoredTaskVersion } from '@scova/models';
import {
    CreateTaskInputSchema,
    PageQuerySchema,
    TaskDetailResponseSchema,
    TaskListResponseSchema,
    TaskConfigSchema,
    TaskSchema,
    UpdateTaskInputSchema,
    parseContract,
    type TaskConfig,
} from '@scova/contracts';
import type { ApiServices } from '@/app/context.ts';
import { ApiError } from '@/utils/errors.ts';
import { TASK_BUDGET_LIMITS } from '@/app/task-policy.ts';
import { createTaskRepo, type TaskStore } from '@/repo/tasks.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** 检索与正文提取策略升级时递增，避免错误复用旧比较范围。 */
const RETRIEVAL_STRATEGY_VERSION = 1;
const EXTRACTION_STRATEGY_VERSION = 'readability-v1';

function assertBudget(config: TaskConfig): void {
    const fieldErrors = Object.entries(TASK_BUDGET_LIMITS)
        .filter(
            ([key, maximum]) => config.budget[key as keyof typeof TASK_BUDGET_LIMITS]! > maximum,
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

/** 语义范围不包含标题、计划时点、展示格式和提醒偏好，避免无关编辑重置基线。 */
export function comparisonScopeHash(config: TaskConfig): string {
    return hash(
        JSON.stringify(
            stable({
                retrievalStrategyVersion: RETRIEVAL_STRATEGY_VERSION,
                extractionStrategyVersion: EXTRACTION_STRATEGY_VERSION,
                topic: config.topic,
                goal: config.goal,
                focusPoints: config.focusPoints,
                exclusions: config.exclusions,
                sourcePreferences: config.sourcePreferences,
                timeRange: config.timeRange,
            }),
        ),
    );
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

function cursorFor(task: StoredTask): string {
    return Buffer.from(
        JSON.stringify({ updatedAt: task.updatedAt.toISOString(), id: task.id }),
        'utf8',
    ).toString('base64url');
}
function decodeCursor(value: string | undefined): { updatedAt: Date; id: string } | undefined {
    if (!value) return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
            updatedAt?: string;
            id?: string;
        };
        if (!parsed.updatedAt || !parsed.id || !UUID.test(parsed.id)) throw new Error();
        const updatedAt = new Date(parsed.updatedAt);
        if (!Number.isFinite(updatedAt.getTime())) throw new Error();
        return { updatedAt, id: parsed.id };
    } catch {
        throw new ApiError(400, 'INVALID_CURSOR', '分页游标无效');
    }
}

/** 任务业务规则与事务编排；持久化只通过 repo 的领域操作完成。 */
export function createTaskService(services: ApiServices) {
    const repo = createTaskRepo(services);
    return {
        async list(userId: string, query: unknown) {
            const page = parseContract(PageQuerySchema, query);
            const take = Math.min(page.limit ?? 50, 100);
            const tasks = await repo.listTasks(userId, take + 1, decodeCursor(page.cursor));
            return parseContract(TaskListResponseSchema, {
                items: tasks.slice(0, take).map(listItem),
                nextCursor: tasks.length > take ? cursorFor(tasks[take - 1]!) : null,
            });
        },
        async create(userId: string, body: unknown) {
            const input = parseContract(CreateTaskInputSchema, body);
            assertBudget(input.config);
            const scopeHash = comparisonScopeHash(input.config);
            const next = nextRunAt(input.config, services.clock());
            const result = await repo.transaction(async (store) => {
                const task = await store.createTask({
                    userId,
                    title: input.config.title,
                    nextRunAt: next,
                });
                const version = await store.createVersion({
                    userId,
                    taskId: task.id,
                    version: 1,
                    inputText: input.inputText,
                    configSchemaVersion: 1,
                    configJson: input.config,
                    comparisonScopeHash: scopeHash,
                });
                const updated = await store.setCurrentVersion(task.id, version.id);
                return { task: updated, version };
            });
            return taskResponse(result.task, result.version, false);
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
                        revision: { increment: 1 },
                        ...(task.status !== 'active'
                            ? { nextRunAt: null }
                            : scheduleChanged
                              ? { nextRunAt: nextRunAt(input.config, await store.now()) }
                              : {}),
                        ...(scheduleChanged ? { scheduleRevision: { increment: 1 } } : {}),
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
                    revision: { increment: 1 },
                    scheduleRevision: { increment: 1 },
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
