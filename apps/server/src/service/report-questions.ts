import { type ReportQuestion as StoredQuestion } from '@scova/db';
import {
    ConnectorError,
    estimateModelInputTokens,
    withDeadline,
    type StructuredInput,
} from '@scova/connectors';
import {
    parseContract,
    ReportQuestionInputSchema,
    ReportQuestionSchema,
    QuestionAnswerSchema,
    type QuestionAnswer,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createReportService } from '@/service/reports.ts';
import { createRunService } from '@/service/runs.ts';
import { createQuestionBudgetRepo, createReportQuestionRepo } from '@/repo/report-questions.ts';
import {
    questionModelSchema,
    questionPrompt,
    validateQuestionAnswer,
} from '@/utils/report-questions.ts';
import { ApiError } from '@/utils/errors.ts';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function dto(row: StoredQuestion) {
    if (!row.answerJson)
        throw new ApiError(409, 'QUESTION_PENDING', '问题尚未完成，不会重复调用模型');
    return parseContract(ReportQuestionSchema, {
        id: row.id,
        reportId: row.reportId,
        question: row.question,
        answer: row.answerJson,
        followupRunId: row.followupRunId,
        createdAt: row.createdAt.toISOString(),
    });
}
export function createReportQuestionService(services: ApiServices) {
    const repo = createReportQuestionRepo(services),
        budgets = createQuestionBudgetRepo(services),
        reports = createReportService(services);
    async function owned(userId: string, reportId: string, id: string) {
        if (!uuid.test(id) || !uuid.test(reportId))
            throw new ApiError(404, 'NOT_FOUND', '资源不存在');
        const row = await repo.find(userId, reportId, id);
        if (!row) throw new ApiError(404, 'NOT_FOUND', '资源不存在');
        return row;
    }
    return {
        async create(
            userId: string,
            reportId: string,
            body: unknown,
            key: string,
            requestSignal: AbortSignal,
            reauthorize: () => Promise<unknown>,
        ) {
            const input = parseContract(ReportQuestionInputSchema, body);
            const report = await reports.get(userId, reportId);
            const claim = await repo.claim(userId, reportId, input.question, key);
            if (claim.reused) return dto(claim.row);
            const usage: QuestionAnswer['usage'] = {
                attempts: 0,
                inputTokens: 0,
                outputTokens: 0,
                estimated: false,
            };
            const insufficient = (reason: QuestionAnswer['reason']): QuestionAnswer => ({
                status: 'insufficient',
                statements: [],
                reason,
                needsResearch: true,
                usage: { ...usage },
            });
            const writes = new Set<Promise<unknown>>();
            const errors: unknown[] = [];
            const write = <T>(p: Promise<T>) => {
                writes.add(p);
                void p.then(
                    () => writes.delete(p),
                    (error: unknown) => {
                        errors.push(error);
                        writes.delete(p);
                    },
                );
                return p;
            };
            let answer: QuestionAnswer;
            let publicError: ApiError | undefined;
            try {
                answer = await withDeadline(
                    services.reportQuestionPolicy.timeoutMs,
                    requestSignal,
                    async (signal) => {
                        const alive = () => {
                            if (signal.aborted) throw signal.reason;
                        };
                        alive();
                        const budget = await write(budgets.begin(userId, signal));
                        alive();
                        if (!report.evidence.length) return insufficient('insufficient_evidence');
                        const model = await services.reportQuestionModel(userId);
                        if (!model) return insufficient('model_unavailable');
                        // 限制上下文；截断只会减少可用引用，不会引入未授权资料。
                        const evidence = report.evidence
                            .slice(0, 24)
                            .map((e) => ({ id: e.id, quote: e.quote.slice(0, 4000) }));
                        const policy = services.reportQuestionPolicy;
                        const modelInput: StructuredInput = {
                            prompt: questionPrompt,
                            schema: questionModelSchema,
                            untrustedSources: [{ question: input.question, evidence }],
                            maxInputTokens: policy.maxInputTokens,
                            maxOutputTokens: Math.min(
                                policy.maxOutputTokens,
                                policy.outputTokensPerAttempt,
                            ),
                        };
                        const reservedInput = estimateModelInputTokens(modelInput);
                        if (reservedInput > policy.maxInputTokens)
                            return insufficient('insufficient_evidence');
                        modelInput.maxInputTokens = reservedInput;
                        let reservation:
                            | Awaited<ReturnType<typeof budget.reserveAttempt>>
                            | undefined;
                        let started = false;
                        const result = await model.generateStructured(modelInput, {
                            signal,
                            timeoutMs: policy.timeoutMs,
                            beforeAttempt: async (kind) => {
                                alive();
                                if (kind !== 'model' || started)
                                    throw new ConnectorError(
                                        'budget_exceeded',
                                        '问答最多一次模型尝试',
                                    );
                                started = true;
                                await write(
                                    (async () => {
                                        reservation = await budget.reserveAttempt(
                                            reservedInput,
                                            modelInput.maxOutputTokens,
                                        );
                                        Object.assign(usage, {
                                            attempts: 1,
                                            inputTokens: reservedInput,
                                            outputTokens: modelInput.maxOutputTokens,
                                            estimated: true,
                                        });
                                    })(),
                                );
                                alive();
                            },
                        });
                        alive();
                        if (
                            !reservation ||
                            result.mode !== 'live' ||
                            typeof result.usage?.estimated !== 'boolean'
                        )
                            throw new Error('模型模式或计量无效');
                        await write(
                            reservation.settle(result.usage.inputTokens, result.usage.outputTokens),
                        );
                        Object.assign(usage, result.usage);
                        alive();
                        try {
                            return validateQuestionAnswer(result.data, evidence, { ...usage });
                        } catch {
                            return insufficient('invalid_output');
                        }
                    },
                );
            } catch (error) {
                await Promise.allSettled(writes);
                publicError =
                    error instanceof ApiError
                        ? error
                        : errors.find((e): e is ApiError => e instanceof ApiError);
                answer = insufficient(requestSignal.aborted ? 'aborted' : 'model_failed');
            }
            // 旧请求取消、会话撤销不会把回答提交到新会话上下文。
            if (requestSignal.aborted) answer = insufficient('aborted');
            try {
                await reauthorize();
            } catch (error) {
                await repo.finish(claim.row, insufficient('aborted'));
                throw error;
            }
            if (requestSignal.aborted) answer = insufficient('aborted');
            const row = await repo.finish(claim.row, parseContract(QuestionAnswerSchema, answer));
            if (publicError) throw publicError;
            return dto(row);
        },
        async get(userId: string, reportId: string, id: string) {
            return dto(await owned(userId, reportId, id));
        },
        async followup(userId: string, reportId: string, id: string, key: string) {
            const row = await owned(userId, reportId, id);
            dto(row);
            const report = await reports.get(userId, reportId);
            return createRunService(services).followup(userId, report.runId, row.id, key);
        },
    };
}
