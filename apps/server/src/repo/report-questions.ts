import {
    queryRows,
    sql as querySql,
    and,
    eq,
    isNull,
    lte,
    desc,
    inArray,
    lt,
    or,
    type ReportQuestion,
    type DatabaseExecutor,
} from '@scova/db';
import * as tables from '@scova/db';
import { createHash } from 'node:crypto';
import type { QuestionAnswer, ReportConversationContext } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { ApiError } from '@/utils/errors.ts';
import { createTaskDraftRepo } from '@/repo/task-drafts.ts';
import { firstRow, requireRow } from '@/utils/database.ts';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function createQuestionBudgetRepo(services: ApiServices) {
    const budget = createTaskDraftRepo({
        redis: () => services.redis(),
        sqliteState: services.sqliteState ? () => services.sqliteState!() : undefined,
        clock: () => services.clock(),
        taskDraftPolicy: services.reportQuestionPolicy,
    });
    const translate = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
            return await work();
        } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            const converted = new ApiError(
                error.status,
                error.status === 429 ? 'QUESTION_RATE_LIMITED' : 'QUESTION_SERVICE_UNAVAILABLE',
                error.status === 429 ? '报告问答额度已用尽，请稍后重试' : '问答预算服务暂不可用',
            );
            converted.retryAfterSeconds = error.retryAfterSeconds;
            throw converted;
        }
    };
    return {
        async begin(userId: string, signal: AbortSignal) {
            const window = await translate(() => budget.begin(userId, signal));
            return {
                async reserveAttempt(inputTokens: number, outputTokens: number) {
                    const reservation = await translate(() =>
                        window.reserveAttempt(inputTokens, outputTokens),
                    );
                    return {
                        inputTokens,
                        outputTokens,
                        settle: (input: number, output: number) =>
                            translate(() => reservation.settle(input, output)),
                    };
                },
            };
        },
    };
}

export function createReportQuestionStore(database: DatabaseExecutor) {
    return {
        async lockReport(userId: string, reportId: string) {
            const rows = await queryRows<{ id: string }>(
                database,
                querySql`SELECT id FROM reports WHERE id=${reportId}::uuid AND user_id=${userId}::uuid FOR NO KEY UPDATE`,
            );
            if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
        },
        latest(userId: string, reportId: string) {
            return database.query.reportQuestions.findFirst({
                where: and(
                    eq(tables.reportQuestions.userId, userId),
                    eq(tables.reportQuestions.reportId, reportId),
                ),
                orderBy: [desc(tables.reportQuestions.createdAt), desc(tables.reportQuestions.id)],
            });
        },
        insert(
            userId: string,
            reportId: string,
            question: string,
            now: Date,
            latest?: ReportQuestion,
        ) {
            return database
                .insert(tables.reportQuestions)
                .values({
                    userId,
                    reportId,
                    question,
                    createdAt: new Date(
                        Math.max(now.getTime(), (latest?.createdAt.getTime() ?? 0) + 1),
                    ),
                })
                .returning()
                .then(firstRow);
        },
        linkResearchRequest(
            row: ReportQuestion,
            runId: string,
            context: ReportConversationContext,
        ) {
            return database
                .update(tables.reportQuestions)
                .set({ followupRunId: runId, contextJson: context })
                .where(
                    and(
                        eq(tables.reportQuestions.id, row.id),
                        eq(tables.reportQuestions.userId, row.userId),
                    ),
                )
                .returning()
                .then(firstRow);
        },
        findResearchRequest(userId: string, reportId: string, runId: string) {
            return database.query.reportQuestions.findFirst({
                where: and(
                    eq(tables.reportQuestions.userId, userId),
                    eq(tables.reportQuestions.reportId, reportId),
                    eq(tables.reportQuestions.followupRunId, runId),
                    isNull(tables.reportQuestions.answerJson),
                ),
            });
        },
        list(userId: string, reportId: string, limit = 101, before?: ReportQuestion) {
            return database.query.reportQuestions
                .findMany({
                    where: and(
                        eq(tables.reportQuestions.userId, userId),
                        eq(tables.reportQuestions.reportId, reportId),
                        ...(before
                            ? [
                                  or(
                                      lt(tables.reportQuestions.createdAt, before.createdAt),
                                      and(
                                          eq(tables.reportQuestions.createdAt, before.createdAt),
                                          lt(tables.reportQuestions.id, before.id),
                                      ),
                                  ),
                              ]
                            : []),
                    ),
                    orderBy: [
                        desc(tables.reportQuestions.createdAt),
                        desc(tables.reportQuestions.id),
                    ],
                    limit,
                })
                .then((rows) => rows.reverse());
        },
    };
}

export function requireConversationHead(
    latest: ReportQuestion | undefined,
    afterQuestionId?: string | null,
) {
    if (latest && !latest.answerJson && !latest.followupRunId)
        throw new ApiError(409, 'CONVERSATION_BUSY', '上一轮仍在处理中，请先读取会话');
    if (afterQuestionId !== undefined && (latest?.id ?? null) !== afterQuestionId)
        throw new ApiError(409, 'CONVERSATION_CHANGED', '会话已有新消息，请刷新历史后再发送');
}

export function createReportQuestionRepo(services: Pick<ApiServices, 'db' | 'clock'>) {
    return {
        async round(userId: string, reportId: string, row: ReportQuestion) {
            const rows = await queryRows<{ count: string }>(
                services.db(),
                querySql`SELECT count(*)::text AS count FROM report_questions WHERE user_id=${userId}::uuid AND report_id=${reportId}::uuid AND (created_at,id)<=(${row.createdAt},${row.id}::uuid)`,
            );
            return Number(rows[0]?.count ?? 0);
        },
        conversationRuns(userId: string, reportId: string, questionIds: string[]) {
            if (!questionIds.length) return Promise.resolve([]);
            return services.db().query.runs.findMany({
                where: and(
                    eq(tables.runs.userId, userId),
                    querySql`${tables.runs.conversationContextJson}->>'reportId'=${reportId}`,
                    inArray(
                        querySql<string>`${tables.runs.conversationContextJson}->>'questionId'`,
                        questionIds,
                    ),
                ),
                orderBy: [tables.runs.queuedAt, tables.runs.id],
            });
        },
        async expire(userId: string, reportId: string, timeoutMs: number, answer: QuestionAnswer) {
            await services
                .db()
                .update(tables.reportQuestions)
                .set({ answerJson: answer })
                .where(
                    and(
                        eq(tables.reportQuestions.userId, userId),
                        eq(tables.reportQuestions.reportId, reportId),
                        isNull(tables.reportQuestions.answerJson),
                        isNull(tables.reportQuestions.followupRunId),
                        lte(
                            tables.reportQuestions.createdAt,
                            new Date(services.clock().getTime() - timeoutMs - 30_000),
                        ),
                    ),
                );
        },
        async claim(
            userId: string,
            reportId: string,
            question: string,
            key: string,
            afterQuestionId?: string | null,
        ) {
            const scope = `report:${reportId}:question`;
            const keyHash = hash(key);
            const payloadHash = hash(
                JSON.stringify({
                    reportId,
                    question,
                    ...(afterQuestionId !== undefined ? { afterQuestionId } : {}),
                }),
            );
            return services.db().transaction(async (tx) => {
                // 锁报告仅串行化幂等认领，不持锁等待模型。
                const store = createReportQuestionStore(tx);
                await store.lockReport(userId, reportId);
                const old = await tx.query.idempotencyRecords
                    .findFirst({
                        where: and(
                            and(
                                eq(tables.idempotencyRecords.userId, userId),
                                eq(tables.idempotencyRecords.scope, scope),
                                eq(tables.idempotencyRecords.keyHash, keyHash),
                            ),
                        ),
                    })
                    .then((row) => row ?? null);
                if (old) {
                    if (old.payloadHash !== payloadHash)
                        throw new ApiError(
                            409,
                            'IDEMPOTENCY_PAYLOAD_MISMATCH',
                            '同一幂等键不能提交不同问题',
                        );
                    const row = old.resourceId
                        ? await tx.query.reportQuestions
                              .findFirst({
                                  where: and(
                                      eq(tables.reportQuestions.id, old.resourceId),
                                      eq(tables.reportQuestions.userId, userId),
                                      eq(tables.reportQuestions.reportId, reportId),
                                  ),
                              })
                              .then((row) => row ?? null)
                        : null;
                    if (!row || !row.answerJson)
                        throw new ApiError(
                            409,
                            'QUESTION_PENDING',
                            '问题仍在处理中；不重复调用模型',
                        );
                    return { row, reused: true };
                }
                const latest = await store.latest(userId, reportId);
                requireConversationHead(latest, afterQuestionId);
                const row = await store.insert(
                    userId,
                    reportId,
                    question,
                    services.clock(),
                    latest,
                );
                await tx
                    .insert(tables.idempotencyRecords)
                    .values({
                        userId: userId,
                        scope: scope,
                        keyHash: keyHash,
                        payloadHash: payloadHash,
                        resourceId: row.id,
                        expiresAt: new Date(services.clock().getTime() + 86400000),
                    })
                    .returning()
                    .then(firstRow);
                return { row, reused: false };
            });
        },
        list(userId: string, reportId: string, limit = 101, before?: ReportQuestion) {
            return createReportQuestionStore(services.db()).list(userId, reportId, limit, before);
        },
        artifacts(userId: string, runIds: string[]) {
            if (!runIds.length) return Promise.resolve([]);
            return services.db().query.reports.findMany({
                where: and(
                    eq(tables.reports.userId, userId),
                    inArray(tables.reports.runId, runIds),
                ),
                columns: { id: true, runId: true, title: true },
                orderBy: [tables.reports.publishedAt, tables.reports.id],
                limit: 200,
            });
        },
        async activeRun(userId: string, runIds: string[]) {
            if (!runIds.length) return false;
            return !!(await services.db().query.runs.findFirst({
                where: and(
                    eq(tables.runs.userId, userId),
                    inArray(tables.runs.id, runIds),
                    inArray(tables.runs.status, [
                        'queued',
                        'running',
                        'recovering',
                        'cancel_requested',
                    ]),
                ),
                columns: { id: true },
            }));
        },
        async saveContext(row: ReportQuestion, context: ReportConversationContext) {
            await services
                .db()
                .update(tables.reportQuestions)
                .set({ contextJson: context })
                .where(
                    and(
                        eq(tables.reportQuestions.id, row.id),
                        eq(tables.reportQuestions.userId, row.userId),
                        isNull(tables.reportQuestions.answerJson),
                    ),
                )
                .returning()
                .then(firstRow);
        },
        find(userId: string, reportId: string, id: string) {
            return services
                .db()
                .query.reportQuestions.findFirst({
                    where: and(
                        eq(tables.reportQuestions.id, id),
                        eq(tables.reportQuestions.userId, userId),
                        eq(tables.reportQuestions.reportId, reportId),
                    ),
                })
                .then((row) => row ?? null);
        },
        async finish(row: ReportQuestion, answer: QuestionAnswer) {
            return services.db().transaction(async (tx) => {
                const updated = await tx
                    .update(tables.reportQuestions)
                    .set({ answerJson: answer })
                    .where(
                        and(
                            eq(tables.reportQuestions.id, row.id),
                            eq(tables.reportQuestions.userId, row.userId),
                            isNull(tables.reportQuestions.answerJson),
                        ),
                    )
                    .returning()
                    .then((rows) => ({ count: rows.length }));
                if (updated.count !== 1)
                    throw new ApiError(409, 'QUESTION_ALREADY_FINISHED', '问题已结束');
                const ids = [
                    ...new Set(
                        answer.statements.flatMap((s) => s.citations.map((c) => c.evidenceId)),
                    ),
                ];
                if (ids.length)
                    await tx
                        .insert(tables.questionEvidence)
                        .values(
                            ids.map((evidenceId) => ({
                                userId: row.userId,
                                questionId: row.id,
                                evidenceId,
                            })),
                        )
                        .returning({ id: tables.questionEvidence.id })
                        .then((rows) => ({ count: rows.length }));
                await tx
                    .update(tables.idempotencyRecords)
                    .set({ status: 'completed', responseCode: 201 })
                    .where(
                        and(
                            eq(tables.idempotencyRecords.userId, row.userId),
                            eq(tables.idempotencyRecords.resourceId, row.id),
                            eq(tables.idempotencyRecords.scope, `report:${row.reportId}:question`),
                        ),
                    )
                    .returning()
                    .then((rows) => ({ count: rows.length }));
                return tx.query.reportQuestions
                    .findFirst({ where: and(eq(tables.reportQuestions.id, row.id)) })
                    .then(requireRow);
            });
        },
    };
}
