import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction, ProjectThreadItemRow } from '@scova/db';
import {
    DEFAULT_TASK_BUDGET_LIMITS,
    TaskConfigSchema,
    parseContract,
    type Budget,
    type TaskConfig,
    ProjectScheduleActionReceiptSchema,
    ProjectScheduleProposalSchema,
    type ProjectAutonomyInput,
    type ProjectScheduleActionReceipt,
    type ProjectScheduleProposal,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { appendProjectThreadItems, createProjectThreadStore } from '@/repo/project-threads.ts';
import { createProjectStore } from '@/repo/projects.ts';
import { createRunStore } from '@/repo/runs.ts';
import { createTaskStore } from '@/repo/tasks.ts';
import { createThreadScheduleStore } from '@/repo/thread-schedule-actions.ts';
import { requireVisibleProjectEvidence } from '@/service/project-evidence.ts';
import { decideProjectAutonomy } from '@/service/project-autonomy.ts';
import { createRunService } from '@/service/runs.ts';
import { createTaskService } from '@/service/tasks.ts';
import { ApiError } from '@/utils/errors.ts';
import { isUuid } from '@/utils/security.ts';

const missing = () => new ApiError(404, 'NOT_FOUND', '资源不存在');
const conflict = () => new ApiError(409, 'ACTION_CONFLICT', '此操作已处理或任务已更新');

type Scope = { userId: string; threadId: string };
type ActionScope = Scope & { projectId: string; tx: DatabaseTransaction; archivedAt: Date | null };
type Proposal = Pick<ProjectThreadItemRow, 'id' | 'turnId'>;
type Target = Pick<ProjectAutonomyInput, 'autonomy' | 'target'>;

// Only server-side callers can supply this function. A reservation must use the action transaction.
export type AuthorizeScheduleBudget = (
    request: Scope & {
        projectId: string;
        actionId: string;
        proposal: ProjectScheduleProposal;
        budget: Budget;
    },
    tx: DatabaseTransaction,
) => Promise<ProjectAutonomyInput['budget']>;

function requireWritable({ archivedAt }: ActionScope) {
    if (archivedAt) throw new ApiError(409, 'THREAD_ARCHIVED', '请先恢复已归档的会话');
}

function receipt(
    proposal: Proposal,
    command: ProjectScheduleProposal['command'],
    status: ProjectScheduleActionReceipt['status'],
    result?: { id: string; revision: number },
): ProjectScheduleActionReceipt {
    return {
        actionId: proposal.id,
        command,
        status,
        taskId: result?.id ?? null,
        runId: null,
        taskRevision: result?.revision ?? null,
        undoable: status === 'applied',
    };
}

export function createThreadScheduleActionService(services: ApiServices) {
    const tasks = createTaskService(services);
    const runs = createRunService(services);

    async function withThread<T>(
        scope: Scope,
        work: (context: ActionScope) => Promise<T>,
        transaction?: DatabaseTransaction,
    ) {
        const { userId, threadId } = scope;
        if (!isUuid(threadId)) throw missing();
        const run = async (tx: DatabaseTransaction) => {
            const threads = createProjectThreadStore(tx, userId);
            const preview = await threads.find(threadId);
            if (!preview || !(await createProjectStore(tx).lockProject(userId, preview.projectId)))
                throw missing();
            const thread = await threads.lock(threadId);
            if (!thread) throw missing();
            return work({
                ...scope,
                tx,
                projectId: thread.projectId,
                archivedAt: thread.archivedAt,
            });
        };
        return transaction ? run(transaction) : services.db().transaction(run);
    }

    function store({ tx, userId, threadId }: ActionScope) {
        return createThreadScheduleStore(tx, userId, threadId);
    }

    async function requirePlan(scope: ActionScope, actionId: string) {
        if (!isUuid(actionId)) throw missing();
        const item = await store(scope).findProposal(actionId);
        if (
            !item ||
            !['create_schedule', 'update_schedule', 'pause_task'].includes(
                String(item.payload.command),
            ) ||
            'actionId' in item.payload
        )
            throw missing();
        return { item, action: parseContract(ProjectScheduleProposalSchema, item.payload) };
    }

    async function findReceipt(
        scope: ActionScope,
        actionId: string,
        status: ProjectScheduleActionReceipt['status'],
    ) {
        const item = await store(scope).findDecision(actionId, status);
        return item ? parseContract(ProjectScheduleActionReceiptSchema, item.payload) : undefined;
    }

    async function recurringTask(
        scope: ActionScope,
        taskId: string,
        expectedRevision: number,
        status?: 'active' | 'paused',
    ) {
        const task = await store(scope).lockTaskInProject(scope.projectId, taskId);
        if (!task) throw missing();
        if (
            task.revision !== expectedRevision ||
            task.status === 'archived' ||
            (status && task.status !== status)
        )
            throw conflict();
        const version = await createTaskStore(scope.tx).requireVersion(
            task.currentVersionId!,
            scope.userId,
            taskId,
        );
        const config = parseContract(TaskConfigSchema, version.configJson);
        if (config.schedule.frequency === 'manual')
            throw new ApiError(409, 'TASK_NOT_RECURRING', '此任务没有周期计划');
        return { config, versionId: version.id };
    }

    async function apply(scope: ActionScope, proposal: Proposal, action: ProjectScheduleProposal) {
        const { tx, userId, projectId } = scope;
        if (action.command === 'create_schedule') {
            if (action.task.config.schedule.frequency === 'manual')
                throw new ApiError(422, 'RECURRING_SCHEDULE_REQUIRED', '请选择每日或每周执行');
            const result = await tasks.createInProject(
                userId,
                projectId,
                action.task,
                proposal.id,
                false,
                tx,
            );
            return receipt(proposal, action.command, 'applied', result.detail.task);
        }
        const before = await recurringTask(
            scope,
            action.taskId,
            action.revision,
            action.command === 'pause_task' ? 'active' : undefined,
        );
        if (action.command === 'update_schedule') {
            if (action.schedule.frequency === 'manual')
                throw new ApiError(422, 'RECURRING_SCHEDULE_REQUIRED', '请选择每日或每周执行');
            const config = {
                ...before.config,
                schedule: action.schedule,
                timezone: action.timezone,
            };
            const result = await tasks.update(
                userId,
                action.taskId,
                { config },
                action.revision,
                tx,
            );
            return {
                ...receipt(proposal, action.command, 'applied', result.task),
                previousVersionId: before.versionId,
            };
        }
        const result = await tasks.transition(userId, action.taskId, 'pause', action.revision, tx);
        return receipt(proposal, action.command, 'applied', result.task);
    }

    async function appendDecision(
        scope: ActionScope,
        proposal: Proposal,
        result: ProjectScheduleActionReceipt,
    ) {
        const { tx, userId, threadId } = scope;
        await store(scope).setStatus(proposal.id, result.status);
        await appendProjectThreadItems(
            tx,
            userId,
            threadId,
            [
                {
                    kind: 'schedule',
                    status: result.status,
                    turnId: proposal.turnId,
                    payload: result,
                },
            ],
            services.clock(),
        );
        return result;
    }

    return {
        cancelRun(scope: Scope, runId: string) {
            if (!isUuid(runId)) throw missing();
            return withThread(scope, async (context) => {
                const run = await createRunStore(context.tx).findRun(runId, context.userId);
                if (
                    !run ||
                    !(await store(context).lockTaskInProject(context.projectId, run.taskId))
                )
                    throw missing();
                return runs.cancel(context.userId, runId, context.tx);
            });
        },
        propose(
            scope: Scope,
            proposal: unknown,
            target: Target,
            options: {
                turnId?: string;
                refs?: ProjectThreadItemRow['refs'];
                authorizeBudget?: AuthorizeScheduleBudget;
                tx?: DatabaseTransaction;
            } = {},
        ) {
            const action = parseContract(ProjectScheduleProposalSchema, proposal);
            return withThread(
                scope,
                async (context) => {
                    requireWritable(context);
                    const { tx, userId, threadId, projectId } = context;
                    const policyInput = { ...target, operation: action.command };
                    const preflight = decideProjectAutonomy({
                        ...policyInput,
                        budget: 'authorized',
                    });
                    if (preflight.outcome === 'deny') throw missing();
                    if (preflight.outcome === 'clarify') {
                        await appendProjectThreadItems(
                            tx,
                            userId,
                            threadId,
                            [
                                {
                                    kind: 'disambiguation',
                                    turnId: options.turnId,
                                    payload: { text: '请明确要操作的周期计划。' },
                                },
                            ],
                            services.clock(),
                        );
                        return { decision: preflight, actionId: null, receipt: null } as const;
                    }
                    if (
                        action.command === 'update_schedule' &&
                        action.schedule.frequency === 'manual'
                    )
                        throw new ApiError(
                            422,
                            'RECURRING_SCHEDULE_REQUIRED',
                            '请选择每日或每周执行',
                        );
                    let config: TaskConfig;
                    if (action.command === 'create_schedule') {
                        config = action.task.config;
                        if (config.schedule.frequency === 'manual')
                            throw new ApiError(
                                422,
                                'RECURRING_SCHEDULE_REQUIRED',
                                '请选择每日或每周执行',
                            );
                    } else
                        ({ config } = await recurringTask(
                            context,
                            action.taskId,
                            action.revision,
                            action.command === 'pause_task' ? 'active' : undefined,
                        ));
                    const actionId = randomUUID();
                    const candidate = { id: actionId, turnId: options.turnId ?? null };
                    const exceedsDeployment = Object.entries(DEFAULT_TASK_BUDGET_LIMITS).some(
                        ([dimension, maximum]) =>
                            config.budget[dimension as keyof Budget]! > maximum,
                    );
                    const budget = exceedsDeployment
                        ? 'exceeded'
                        : preflight.outcome === 'execute' && options.authorizeBudget
                          ? await options.authorizeBudget(
                                {
                                    userId,
                                    projectId,
                                    threadId,
                                    actionId,
                                    proposal: action,
                                    budget: config.budget,
                                },
                                tx,
                            )
                          : 'unavailable';
                    const decision = decideProjectAutonomy({ ...policyInput, budget });
                    await appendProjectThreadItems(
                        tx,
                        userId,
                        threadId,
                        [
                            {
                                ...candidate,
                                kind: 'schedule',
                                status: 'pending',
                                payload: action,
                                refs: options.refs,
                            },
                        ],
                        services.clock(),
                    );
                    const result =
                        decision.outcome === 'execute'
                            ? await appendDecision(
                                  context,
                                  candidate,
                                  await apply(context, candidate, action),
                              )
                            : null;
                    return { decision, actionId, receipt: result };
                },
                options.tx,
            );
        },
        decide(scope: Scope, actionId: string, approve: boolean) {
            return withThread(scope, async (context) => {
                const { item, action } = await requirePlan(context, actionId);
                const status = approve ? 'applied' : 'rejected';
                const replay = await findReceipt(context, actionId, status);
                if (replay) return replay;
                requireWritable(context);
                if (item.status !== 'pending') throw conflict();
                if (approve)
                    await requireVisibleProjectEvidence(
                        context.tx,
                        context.userId,
                        context.projectId,
                        item.refs,
                    );
                const result = approve
                    ? await apply(context, item, action)
                    : receipt(item, action.command, status);
                return appendDecision(context, item, result);
            });
        },
        undo(scope: Scope, actionId: string) {
            return withThread(scope, async (context) => {
                const { item, action } = await requirePlan(context, actionId);
                const replay = await findReceipt(context, actionId, 'undone');
                if (replay) return replay;
                requireWritable(context);
                const applied = await findReceipt(context, actionId, 'applied');
                if (item.status !== 'applied' || !applied?.taskId || applied.taskRevision === null)
                    throw conflict();
                const { taskId, taskRevision } = applied;
                const { tx, userId } = context;
                const { config } = await recurringTask(
                    context,
                    taskId,
                    taskRevision,
                    action.command === 'pause_task'
                        ? 'paused'
                        : action.command === 'create_schedule'
                          ? 'active'
                          : undefined,
                );
                let schedule: TaskConfig['schedule'] = { frequency: 'manual' };
                let timezone = config.timezone;
                if (action.command === 'update_schedule') {
                    if (!applied.previousVersionId) throw conflict();
                    const version = await createTaskStore(tx).requireVersion(
                        applied.previousVersionId,
                        userId,
                        taskId,
                    );
                    const previous = parseContract(TaskConfigSchema, version.configJson);
                    ({ schedule, timezone } = previous);
                }
                const result =
                    action.command === 'pause_task'
                        ? await tasks.transition(userId, taskId, 'resume', taskRevision, tx)
                        : await tasks.update(
                              userId,
                              taskId,
                              { config: { ...config, schedule, timezone } },
                              taskRevision,
                              tx,
                          );
                return appendDecision(
                    context,
                    item,
                    receipt(item, action.command, 'undone', result.task),
                );
            });
        },
    };
}
