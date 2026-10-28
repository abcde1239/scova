import { queryRows, sql as querySql, and, eq, isNull, type ReportQuestion } from '@scova/db';
import * as tables from '@scova/db';
import { createHash } from 'node:crypto';
import type { QuestionAnswer } from '@scova/models';
import type { ApiServices } from '@/app/services';
import { ApiError } from '@/utils/errors.ts';
import { createTaskDraftRepo } from '@/repo/task-drafts.ts';
import { firstRow, requireRow } from '@/utils/database.ts';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function createQuestionBudgetRepo(services: ApiServices) {
    const budget = createTaskDraftRepo({
        redis: () => services.redis(),
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

export function createReportQuestionRepo(services: Pick<ApiServices, 'db' | 'clock'>) {
    return {
        async claim(userId: string, reportId: string, question: string, key: string) {
            const scope = `report:${reportId}:question`;
            const keyHash = hash(key);
            const payloadHash = hash(JSON.stringify({ reportId, question }));
            return services.db().transaction(async (tx) => {
                // 锁报告仅串行化幂等认领，不持锁等待模型。
                const locked = await queryRows<{ id: string }>(
                    tx,
                    querySql`SELECT id FROM reports WHERE id=${reportId}::uuid AND user_id=${userId}::uuid FOR NO KEY UPDATE`,
                );
                if (!locked.length) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
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
                const row = await tx
                    .insert(tables.reportQuestions)
                    .values({ userId: userId, reportId: reportId, question: question })
                    .returning()
                    .then(firstRow);
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
