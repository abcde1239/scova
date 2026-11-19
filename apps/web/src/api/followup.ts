import {
    ContractValidationError,
    IdempotencyHeadersSchema,
    QuestionFollowupInputSchema,
    RunCommandResponseSchema,
    UuidSchema,
    parseContract,
    type Report,
    type ReportQuestion,
    type Run,
    type OutputFormat,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';
import type { SessionLifecycle } from '@/api/session';
import { validateQuestion } from '@/utils/report/questions';

export function invalidFollowup(message: string): never {
    throw new ContractValidationError([{ path: '/followup', message }]);
}
export function followupParent(run: Run, report: Report) {
    if (
        run.id !== report.runId ||
        run.taskId !== report.taskId ||
        run.taskVersionId !== report.taskVersionId ||
        run.mode !== report.mode
    )
        invalidFollowup('原执行与报告身份、版本或模式不一致');
    return run;
}
export function followupAttempt(
    report: Report,
    question: ReportQuestion,
    parent: Run,
    key: string = crypto.randomUUID(),
    operation: 'research' | 'revise' = 'research',
    outputFormats?: OutputFormat[],
) {
    validateQuestion(question, report);
    followupParent(parent, report);
    if (parent.mode !== 'live') invalidFollowup('历史演示报告不能创建后续研究');
    parseContract(IdempotencyHeadersSchema, { 'idempotency-key': key });
    return Object.freeze({
        reportId: report.id,
        questionId: question.id,
        question: question.question,
        parentRunId: parent.id,
        taskId: parent.taskId,
        taskVersionId: parent.taskVersionId,
        mode: parent.mode,
        budget: Object.freeze({ ...parent.budget }),
        key,
        ...(operation === 'revise' ? { operation } : {}),
        ...(outputFormats?.length ? { outputFormats: Object.freeze([...outputFormats]) } : {}),
    });
}
export type FollowupAttempt = ReturnType<typeof followupAttempt>;
export function followupRun(
    run: Run,
    expected: Pick<FollowupAttempt, 'parentRunId' | 'taskId' | 'taskVersionId' | 'budget'> & {
        mode: Run['mode'];
    },
    linkedId?: string | null,
) {
    if (
        run.id === expected.parentRunId ||
        (linkedId && run.id !== linkedId) ||
        run.parentRunId !== expected.parentRunId ||
        run.taskId !== expected.taskId ||
        run.taskVersionId !== expected.taskVersionId ||
        run.mode !== expected.mode ||
        run.trigger !== 'followup' ||
        Object.entries(expected.budget).some(
            ([key, value]) => Reflect.get(run.budget, key) !== value,
        )
    )
        invalidFollowup('后续执行与原问题、父执行、版本、模式或预算不一致');
    return run;
}
export const followupEndpoint = defineApiEndpoint<{
    params: { reportId: string; questionId: string };
    body: { confirm: true; operation?: 'research' | 'revise'; outputFormats?: OutputFormat[] };
    data: ReturnType<typeof parseContract<typeof RunCommandResponseSchema>>;
}>({
    method: 'POST',
    path: '/reports/:reportId/questions/:questionId/followup',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const params = value as Record<string, unknown> | undefined;
                return {
                    reportId: parseContract(UuidSchema, params?.reportId),
                    questionId: parseContract(UuidSchema, params?.questionId),
                };
            },
        },
        body: modelValidator(QuestionFollowupInputSchema),
    },
    validator: modelValidator(RunCommandResponseSchema),
});
export async function requestFollowup(
    scope: ReturnType<SessionLifecycle['capture']>,
    attempt: FollowupAttempt,
    signal: AbortSignal,
    linkedId?: string | null,
) {
    const response = await scope.request(
        followupEndpoint,
        {
            params: { reportId: attempt.reportId, questionId: attempt.questionId },
            body: {
                confirm: true,
                ...('operation' in attempt ? { operation: attempt.operation } : {}),
                ...(attempt.outputFormats ? { outputFormats: [...attempt.outputFormats] } : {}),
            },
        },
        { signal, idempotencyKey: attempt.key },
    );
    if (response.status !== 202) invalidFollowup('后续执行命令 HTTP 状态不一致');
    followupRun(response.data.run, attempt, linkedId);
    if (!response.data.reused && response.data.run.status !== 'queued')
        invalidFollowup('首次后续执行未返回入队状态');
    return response;
}
