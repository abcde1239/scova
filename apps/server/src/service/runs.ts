import {
    reportSearchConfigurationHash,
    type DatabaseTransaction,
    type Run as StoredRun,
} from '@scova/db';
import { openCredential } from '@scova/shared/credentials';
import { createHash } from 'node:crypto';
import { effectiveRunScopeHash } from '@scova/shared';
import {
    PageQuerySchema,
    RunListResponseSchema,
    RunCommandInputSchema,
    RunSchema,
    TaskConfigSchema,
    parseContract,
    selectedOutputFormats,
    type RunCommandInput,
    type TaskConfig,
    type ReportConversationContext,
    ReportConversationContextSchema,
    type OutputFormat,
    type Report,
    type ReportFollowupInput,
    type ReportFollowupSearch,
    QuestionAnswerSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { ApiError } from '@/utils/errors.ts';
import { createRunRepo, createRunStore, type RunStore } from '@/repo/runs.ts';
import { requireConversationHead } from '@/repo/report-questions.ts';
import { conversationContext } from '@/utils/report-conversation.ts';
import { comparisonScopeHash } from '@/service/tasks.ts';
import { ownedTask } from '@/service/tasks.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ACTIVE = ['queued', 'running', 'recovering', 'cancel_requested'] as const;
const usage = { searches: 0, pages: 0, inputTokens: 0, outputTokens: 0, estimated: true };

export function toRun(run: StoredRun) {
    return parseContract(RunSchema, {
        id: run.id,
        taskId: run.taskId,
        taskVersionId: run.taskVersionId,
        parentRunId: run.parentRunId,
        baselineRunId: run.baselineRunId,
        mode: run.mode,
        status: run.status,
        outcome: run.outcome,
        trigger: run.trigger,
        budget: run.budgetJson,
        usage: run.usageJson,
        coverage: run.coverageJson,
        queuedAt: run.queuedAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        failureCode: run.failureCode,
    });
}

function commandBody(input: RunCommandInput | undefined) {
    const parsed = parseContract(RunCommandInputSchema, input ?? {});
    return {
        mode: parsed.mode ?? 'live',
        ...(parsed.searchMode !== undefined ? { searchMode: parsed.searchMode } : {}),
        ...(parsed.outputFormat !== undefined ? { outputFormat: parsed.outputFormat } : {}),
        ...(parsed.outputFormats !== undefined ? { outputFormats: parsed.outputFormats } : {}),
        ...(parsed.agentProviderId !== undefined
            ? { agentProviderId: parsed.agentProviderId }
            : {}),
    } as const;
}

/** New work uses its effective collection config; unchanged retries retain their frozen scope. */
export function runComparisonScopeHash(
    config: TaskConfig,
    mode: 'live' | 'demo',
    inherited: { config?: TaskConfig; scope?: string; questionId?: string } = {},
): string {
    const collectionKey = (value: TaskConfig) =>
        JSON.stringify([selectedOutputFormats(value).sort(), value.searchMode ?? 'auto']);
    if (
        inherited.scope &&
        (!inherited.config || collectionKey(config) === collectionKey(inherited.config))
    )
        return inherited.scope;
    const scope = comparisonScopeHash(config);
    return effectiveRunScopeHash(
        inherited.questionId
            ? sha256(
                  JSON.stringify({
                      namespace: 'question-followup-v1',
                      questionId: inherited.questionId,
                      scope,
                  }),
              )
            : scope,
        mode,
    );
}

/** Run 业务规则与事务编排；不包含请求对象、Elysia 或数据库查询。 */
export function createRunService(services: ApiServices) {
    const repo = createRunRepo(services);

    async function requireRun(userId: string, runId: string) {
        if (!UUID.test(runId)) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
        const run = await repo.findRun(runId, userId);
        if (!run) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
        return run;
    }

    async function freezeFollowupSearch(
        store: RunStore,
        userId: string,
        selection: ReportFollowupSearch,
    ) {
        if (selection.searchMode === 'searxng') return null;
        const record = await store.findSearchConfiguration(userId);
        if (!record?.protocol || !record.encryptedApiKey || !record.baseUrl || !record.contentMode)
            throw new ApiError(
                422,
                'SEARCH_API_NOT_CONFIGURED',
                '请先保存可用的账号 Search API 配置',
            );
        if (record.revision !== selection.searchConfigRevision)
            throw new ApiError(
                409,
                'SEARCH_CONFIGURATION_CONFLICT',
                '搜索配置已更新，请重新读取后再确认',
            );
        if (record.protocol === 'perplexity')
            throw new ApiError(
                422,
                'SEARCH_API_READING_UNSUPPORTED',
                '所选 Search API 不支持独立网页读取',
            );
        if (record.protocol === 'custom_json' && !record.customTemplate)
            throw new ApiError(
                422,
                'SEARCH_API_NOT_CONFIGURED',
                '请先保存可用的自定义 Search API 配置',
            );
        try {
            if (!openCredential(record.encryptedApiKey, userId, record.id).trim())
                throw new Error();
        } catch {
            throw new ApiError(
                422,
                'SEARCH_CREDENTIAL_INVALID',
                '搜索密钥无法读取，请重新保存 Search API',
            );
        }
        return reportSearchConfigurationHash(record);
    }

    async function createRun(
        taskId: string,
        userId: string,
        input: RunCommandInput | undefined,
        idempotencyKey: string,
        parentRunId: string | null = null,
        taskVersionId?: string,
        followup?: { questionId: string; reportRunId: string; context?: ReportConversationContext },
        inheritedConfig?: TaskConfig,
        inheritedScope?: string,
        inheritedContext?: ReportConversationContext,
        merge?: { reportId: string; reportIds: string[] },
        options?: {
            draft?: { report: Report; input: ReportFollowupInput; selection: ReportFollowupSearch };
            inheritedSearchHash?: string | null;
        },
    ) {
        if (!UUID.test(taskId)) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
        const command = commandBody(input);
        const draft = options?.draft;
        const scope = draft
            ? `report:${draft.report.id}:request-followup`
            : merge
              ? `report:${merge.reportId}:merge`
              : followup
                ? `question:${followup.questionId}:${followup.context?.operation === 'revise' ? 'revision' : 'followup'}`
                : `run:${taskId}:${parentRunId ? 'retry' : 'create'}`;
        const keyHash = sha256(idempotencyKey);
        const payloadHash = sha256(
            JSON.stringify({
                taskId,
                parentRunId,
                ...command,
                ...(merge ? { merge } : {}),
                ...(draft
                    ? {
                          question: draft.input.question,
                          afterQuestionId: draft.input.afterQuestionId,
                          searchSelection: draft.selection,
                      }
                    : {}),
                ...(followup
                    ? {
                          questionId: followup.questionId,
                          ...(followup.context?.operation === 'revise'
                              ? { operation: 'revise' }
                              : {}),
                      }
                    : {}),
            }),
        );
        try {
            return await repo.transaction(async (store) => {
                // 所有启动命令先锁定同一任务，串行决定幂等重放、活动复用及配置快照。
                if (!(await store.lockTask(taskId, userId)).length)
                    throw new ApiError(404, 'NOT_FOUND', '资源不存在');
                if (draft) await store.reportQuestions.lockReport(userId, draft.report.id);
                const existing = await store.findIdempotency(userId, scope, keyHash);
                if (existing) {
                    if (existing.payloadHash !== payloadHash)
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_PAYLOAD_MISMATCH',
                            '同一幂等键不能提交不同执行参数',
                        );
                    if (!existing.resourceId)
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_PENDING',
                            '相同执行命令仍在处理中，请稍后重试',
                        );
                    const reused = await store.findRun(existing.resourceId, userId);
                    if (!reused)
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_PENDING',
                            '执行命令记录正在恢复，请稍后重试',
                        );
                    const question = draft
                        ? await store.reportQuestions.findResearchRequest(
                              userId,
                              draft.report.id,
                              reused.id,
                          )
                        : undefined;
                    if (draft && !question)
                        throw new ApiError(409, 'FOLLOWUP_UNAVAILABLE', '补查轮次不可用');
                    return { run: reused, reused: true, question };
                }
                let searchHash = options?.inheritedSearchHash;
                let draftContext: ReportConversationContext | undefined;
                let draftQuestion;
                if (draft) {
                    const latest = await store.reportQuestions.latest(userId, draft.report.id);
                    requireConversationHead(latest, draft.input.afterQuestionId);
                    searchHash = await freezeFollowupSearch(store, userId, draft.selection);
                    const history = await store.reportQuestions.list(userId, draft.report.id);
                    draftQuestion = await store.reportQuestions.insert(
                        userId,
                        draft.report.id,
                        draft.input.question,
                        services.clock(),
                        latest,
                    );
                    draftContext = parseContract(ReportConversationContextSchema, {
                        ...conversationContext(
                            draft.report,
                            draftQuestion.id,
                            draftQuestion.question,
                            history.map((row) => ({
                                id: row.id,
                                question: row.question,
                                ...(row.answerJson
                                    ? {
                                          answer: parseContract(
                                              QuestionAnswerSchema,
                                              row.answerJson,
                                          ),
                                      }
                                    : {}),
                            })),
                        ),
                        searchSelection: draft.selection,
                    });
                }
                const question = followup
                    ? await store.findQuestion(followup.questionId, userId, followup.reportRunId)
                    : draftQuestion;
                if (followup && (!question || !question.answerJson))
                    throw new ApiError(404, 'NOT_FOUND', '问题不存在或尚未完成');
                const linkedQuestionRun =
                    followup?.context?.operation === 'revise'
                        ? question?.revisionRunId
                        : question?.followupRunId;
                if (linkedQuestionRun) {
                    const linked = await store.findRun(linkedQuestionRun, userId);
                    if (!linked) throw new ApiError(409, 'FOLLOWUP_UNAVAILABLE', '后续执行不可用');
                    return { run: linked, reused: true };
                }
                const task = await ownedTask(taskId, userId, store);
                if (task.status === 'archived')
                    throw new ApiError(409, 'TASK_ARCHIVED', '已归档任务不能启动新执行');
                const version = await store.findVersion(
                    taskVersionId ?? task.currentVersionId!,
                    userId,
                    task.id,
                );
                if (!version) throw new ApiError(409, 'TASK_VERSION_MISSING', '任务配置版本不可用');
                const baseConfig = parseContract(
                    TaskConfigSchema,
                    inheritedConfig ?? version.configJson,
                );
                let config =
                    question || merge
                        ? parseContract(TaskConfigSchema, {
                              ...baseConfig,
                              goal: merge
                                  ? '合并原报告与选定续作，基于保存证据生成完整的中文报告，合并重复内容，保留条件、真实分歧和未解决的问题。'
                                  : question!.question,
                              focusPoints: [],
                              schedule: { frequency: 'manual' },
                          })
                        : baseConfig;
                if (command.outputFormats !== undefined)
                    config = {
                        ...config,
                        outputFormat: command.outputFormats[0]!,
                        outputFormats: command.outputFormats,
                    };
                else if (command.outputFormat !== undefined) {
                    const { outputFormats: _previousFormats, ...singleConfig } = config;
                    config = { ...singleConfig, outputFormat: command.outputFormat };
                }
                if (command.agentProviderId !== undefined) {
                    const { agentProviderId: _previous, ...rest } = config;
                    config =
                        command.agentProviderId === null
                            ? rest
                            : { ...rest, agentProviderId: command.agentProviderId };
                }
                if (command.searchMode !== undefined)
                    config = { ...config, searchMode: command.searchMode };
                if (
                    config.agentProviderId &&
                    !(await store.findAgentProvider(userId, config.agentProviderId))
                )
                    throw new ApiError(
                        422,
                        'AGENT_PROVIDER_UNAVAILABLE',
                        '所选执行Agent配置不可用，请重新选择',
                    );
                const idempotency = await store.createIdempotency({
                    userId,
                    scope,
                    keyHash,
                    payloadHash,
                    expiresAt: new Date(services.clock().getTime() + 24 * 60 * 60 * 1000),
                });
                const active = await store.findActiveRun(task.id, userId);
                if (active) {
                    if (followup || merge || draft || inheritedContext?.searchSelection)
                        throw new ApiError(
                            409,
                            'RUN_ALREADY_ACTIVE',
                            '该任务已有活动执行，请结束后再确认后续研究',
                        );
                    await store.completeIdempotency(idempotency.id, active.id);
                    return { run: active, reused: true };
                }
                const run = await store.createRun({
                    userId,
                    taskId: task.id,
                    taskVersionId: version.id,
                    comparisonScopeHash: runComparisonScopeHash(config, command.mode, {
                        config: inheritedConfig ?? baseConfig,
                        scope: inheritedScope,
                        questionId: question?.id,
                    }),
                    mode: command.mode,
                    trigger:
                        followup || merge || draft ? 'followup' : parentRunId ? 'retry' : 'manual',
                    ...(question ||
                    merge ||
                    inheritedConfig ||
                    command.agentProviderId !== undefined ||
                    command.searchMode !== undefined ||
                    command.outputFormat !== undefined ||
                    command.outputFormats !== undefined
                        ? { followupConfigJson: config }
                        : {}),
                    parentRunId,
                    budgetJson: config.budget,
                    feedbackSnapshotJson: await store.feedbackSnapshot(userId, task.id),
                    conversationContextJson:
                        draftContext ?? followup?.context ?? inheritedContext ?? null,
                    searchConfigurationHash: searchHash,
                    usageJson: usage,
                });
                await store.enqueue(run);
                if (question && !draft) {
                    const linked = await store.linkQuestion(
                        question.id,
                        userId,
                        run.id,
                        followup?.context?.operation,
                    );
                    if (linked.count !== 1)
                        throw new ApiError(409, 'FOLLOWUP_ALREADY_LINKED', '问题已有关联执行');
                }
                await store.completeIdempotency(idempotency.id, run.id);
                const linkedQuestion =
                    draftQuestion && draftContext
                        ? await store.reportQuestions.linkResearchRequest(
                              draftQuestion,
                              run.id,
                              draftContext,
                          )
                        : undefined;
                return { run, reused: false, question: linkedQuestion };
            });
        } catch (error) {
            if (!repo.isUniqueConflict(error)) throw error;
            const existing = await repo.findIdempotency(userId, scope, keyHash);
            if (existing && existing.payloadHash !== payloadHash)
                throw new ApiError(
                    409,
                    'IDEMPOTENCY_PAYLOAD_MISMATCH',
                    '同一幂等键不能提交不同执行参数',
                );
            if (!draft && existing?.payloadHash === payloadHash && existing.resourceId) {
                const reused = await repo.requireRun(existing.resourceId, userId);
                return { run: reused, reused: true };
            }
            throw new ApiError(409, 'RUN_ALREADY_ACTIVE', '该任务已有未终结执行，请等待完成后再试');
        }
    }

    return {
        async list(userId: string, taskId: string, input: unknown) {
            await ownedTask(taskId, userId, repo);
            const query = parseContract(PageQuerySchema, input),
                scope = `runs:${taskId}`;
            let cursorId: string | undefined;
            if (query.cursor) {
                try {
                    const cursor = JSON.parse(
                        Buffer.from(query.cursor, 'base64url').toString('utf8'),
                    );
                    if (
                        !UUID.test(cursor.id) ||
                        cursor.scope !== scope ||
                        typeof cursor.time !== 'string'
                    )
                        throw new Error();
                    const anchor = await repo.findRun(cursor.id, userId);
                    if (
                        !anchor ||
                        anchor.taskId !== taskId ||
                        anchor.queuedAt.toISOString() !== cursor.time
                    )
                        throw new Error();
                    cursorId = cursor.id;
                } catch {
                    throw new ApiError(400, 'INVALID_CURSOR', '执行历史游标无效或与任务不一致');
                }
            }
            const limit = Math.min(query.limit ?? 50, 100),
                rows = await repo.listRuns(userId, taskId, limit + 1, cursorId),
                page = rows.slice(0, limit),
                last = page.at(-1);
            return parseContract(RunListResponseSchema, {
                items: page.map(toRun),
                nextCursor:
                    rows.length > limit && last
                        ? Buffer.from(
                              JSON.stringify({
                                  id: last.id,
                                  time: last.queuedAt.toISOString(),
                                  scope,
                              }),
                          ).toString('base64url')
                        : null,
            });
        },
        async create(
            userId: string,
            taskId: string,
            input: RunCommandInput | undefined,
            key: string,
        ) {
            const result = await createRun(taskId, userId, input, key);
            return { run: toRun(result.run), reused: result.reused };
        },
        async followup(
            userId: string,
            reportRunId: string,
            questionId: string,
            key: string,
            context?: ReportConversationContext,
            outputFormats?: OutputFormat[],
        ) {
            const parent = await requireRun(userId, reportRunId);
            if (parent.mode !== 'live')
                throw new ApiError(
                    409,
                    'LEGACY_DEMO_RUN',
                    '历史演示报告不能创建后续研究，请从任务页启动真实执行',
                );
            const result = await createRun(
                parent.taskId,
                userId,
                {
                    mode: parent.mode,
                    ...(outputFormats ? { outputFormats: [...outputFormats] } : {}),
                },
                key,
                parent.id,
                parent.taskVersionId,
                {
                    questionId,
                    reportRunId,
                    ...(context
                        ? { context: parseContract(ReportConversationContextSchema, context) }
                        : {}),
                },
            );
            return { run: toRun(result.run), reused: result.reused };
        },
        async requestFollowup(
            userId: string,
            report: Report,
            input: ReportFollowupInput,
            key: string,
        ) {
            const parent = await requireRun(userId, report.runId);
            if (parent.mode !== 'live')
                throw new ApiError(409, 'LEGACY_DEMO_RUN', '历史演示报告不能创建后续研究');
            const selection: ReportFollowupSearch =
                input.searchMode === 'api'
                    ? { searchMode: 'api', searchConfigRevision: input.searchConfigRevision }
                    : { searchMode: 'searxng' };
            const result = await createRun(
                parent.taskId,
                userId,
                { searchMode: input.searchMode, outputFormats: input.outputFormats },
                key,
                parent.id,
                parent.taskVersionId,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { draft: { report, input, selection } },
            );
            if (!result.question) throw new ApiError(409, 'FOLLOWUP_UNAVAILABLE', '补查轮次不可用');
            return { question: result.question, run: toRun(result.run), reused: result.reused };
        },
        async get(userId: string, runId: string) {
            return toRun(await requireRun(userId, runId));
        },
        async merge(
            userId: string,
            reportRunId: string,
            key: string,
            context: ReportConversationContext,
            outputFormats?: OutputFormat[],
        ) {
            const parent = await requireRun(userId, reportRunId);
            if (parent.mode !== 'live')
                throw new ApiError(409, 'LEGACY_DEMO_RUN', '演示报告不能合并成果');
            const frozen = parseContract(ReportConversationContextSchema, context);
            if (!frozen.merge || frozen.operation !== 'revise')
                throw new ApiError(422, 'INVALID_MERGE', '合并上下文无效');
            const result = await createRun(
                parent.taskId,
                userId,
                { mode: 'live', ...(outputFormats ? { outputFormats } : {}) },
                key,
                parent.id,
                parent.taskVersionId,
                undefined,
                parent.followupConfigJson
                    ? parseContract(TaskConfigSchema, parent.followupConfigJson)
                    : undefined,
                effectiveRunScopeHash(
                    sha256(`report-merge:${frozen.reportId}:${frozen.merge.reportIds.join(',')}`),
                    'live',
                ),
                frozen,
                { reportId: frozen.reportId, reportIds: frozen.merge.reportIds },
            );
            return { run: toRun(result.run), reused: result.reused };
        },
        async cancel(userId: string, runId: string, transaction?: DatabaseTransaction) {
            if (!UUID.test(runId)) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
            const cancel = async (store: RunStore) => {
                await store.lockRun(runId, userId);
                const run = await store.findRun(runId, userId);
                if (!run) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
                if (
                    run.status === 'cancel_requested' ||
                    !ACTIVE.includes(run.status as (typeof ACTIVE)[number])
                )
                    return { run, reused: true };
                const updated = await store.requestCancel(run.id, services.clock());
                await store.createOutbox({
                    userId,
                    aggregateId: run.id,
                    eventType: 'run.cancel_requested',
                    dedupeKey: `run-${run.id}-cancel`,
                    payload: { runId: run.id },
                });
                return { run: updated, reused: false };
            };
            const result = await (transaction
                ? cancel(createRunStore(transaction))
                : repo.transaction(cancel));
            return { run: toRun(result.run), reused: result.reused };
        },
        async retry(
            userId: string,
            runId: string,
            input: RunCommandInput | undefined,
            key: string,
        ) {
            const old = await requireRun(userId, runId);
            if (!(old.status === 'failed' || old.status === 'canceled'))
                throw new ApiError(409, 'RUN_NOT_RETRYABLE', '当前执行状态不允许重试');
            const context = old.conversationContextJson
                ? parseContract(ReportConversationContextSchema, old.conversationContextJson)
                : undefined;
            const command = commandBody(input);
            if (
                context?.searchSelection &&
                (command.mode !== old.mode ||
                    command.searchMode !== undefined ||
                    command.outputFormat !== undefined ||
                    command.outputFormats !== undefined ||
                    command.agentProviderId !== undefined)
            )
                throw new ApiError(
                    409,
                    'FOLLOWUP_CONFIGURATION_FROZEN',
                    '补查重试沿用确认时的执行配置',
                );
            const result = await createRun(
                old.taskId,
                userId,
                input,
                key,
                old.id,
                old.taskVersionId,
                undefined,
                old.followupConfigJson
                    ? parseContract(TaskConfigSchema, old.followupConfigJson)
                    : undefined,
                old.mode === commandBody(input).mode
                    ? old.comparisonScopeHash
                    : old.followupConfigJson
                      ? sha256(
                            JSON.stringify({
                                namespace: 'question-followup-mode-v1',
                                previous: old.comparisonScopeHash,
                                mode: commandBody(input).mode,
                            }),
                        )
                      : undefined,
                context,
                undefined,
                context?.searchSelection
                    ? { inheritedSearchHash: old.searchConfigurationHash }
                    : undefined,
            );
            return { run: toRun(result.run), reused: result.reused };
        },
    };
}
