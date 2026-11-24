import {
    ContractValidationError,
    IdempotencyHeadersSchema,
    ReportQuestionInputSchema,
    UuidSchema,
    parseContract,
    type QuestionAnswer,
    type Report,
    type ReportQuestion,
} from '@scova/models';
import { CommunicationError } from 'requestlane';
import type { ApiResponse } from '@/api/client';
import { toApiError } from '@/api/errors';
import type { ReportQuestionDetail } from '@/api/report-questions';

export function invalidQuestion(message: string): never {
    throw new ContractValidationError([{ path: '/answer', message }]);
}
export function questionSelection(value: unknown): { id?: string; error?: string } {
    if (value === undefined) return {};
    try {
        return { id: parseContract(UuidSchema, value).toLowerCase() };
    } catch {
        return { error: '回答地址无效：questionId 必须是一个有效标识，且不能重复。' };
    }
}
export function questionTextError(question: string) {
    try {
        parseContract(ReportQuestionInputSchema, { question });
        return '';
    } catch {
        return question.length > 2000 ? '问题不能超过 2000字。' : '请输入非空白问题。';
    }
}
export function questionAttempt(
    reportId: string,
    question: string,
    key: string = crypto.randomUUID(),
    afterQuestionId?: string | null,
    agentProviderId?: string,
) {
    parseContract(UuidSchema, reportId);
    const input = parseContract(ReportQuestionInputSchema, {
        question,
        ...(afterQuestionId !== undefined ? { afterQuestionId } : {}),
        ...(agentProviderId ? { agentProviderId } : {}),
    });
    parseContract(IdempotencyHeadersSchema, { 'idempotency-key': key });
    return Object.freeze({
        reportId,
        key,
        ...input,
    });
}
export type QuestionAttempt = ReturnType<typeof questionAttempt>;

/** Shared DTO validation is necessary but does not prove cross-field or evidence consistency. */
function validateQuestionIdentity(
    value: Pick<ReportQuestion, 'id' | 'reportId' | 'question'>,
    report: Report,
    expected: { id?: string; question?: string },
) {
    if (
        value.reportId.toLowerCase() !== report.id.toLowerCase() ||
        (expected.id && value.id.toLowerCase() !== expected.id.toLowerCase()) ||
        (expected.question !== undefined && value.question !== expected.question)
    )
        invalidQuestion('回答与当前报告、问题或原始问题文本不一致');
}
export function validateQuestionDetail<T extends ReportQuestionDetail>(
    value: T,
    report: Report,
    expected: { id?: string; question?: string } = {},
): T {
    if ('searchSelection' in value) {
        validateQuestionIdentity(value, report, expected);
    } else {
        validateQuestion(value, report, expected);
    }
    return value;
}
export function validateQuestion(
    value: ReportQuestion,
    report: Report,
    expected: { id?: string; question?: string } = {},
) {
    validateQuestionIdentity(value, report, expected);
    const answer = value.answer;
    if (answer.status === 'answered') {
        if (answer.reason !== 'evidence_answer' || !answer.statements.length)
            invalidQuestion('回答状态与原因不一致');
    } else if (
        answer.reason === 'evidence_answer' ||
        answer.statements.length ||
        !answer.needsResearch
    )
        invalidQuestion('证据不足状态与原因或内容不一致');
    const evidence = new Map(report.evidence.map((item) => [item.id.toLowerCase(), item.quote]));
    for (const statement of answer.statements) {
        for (const citation of statement.citations) {
            if (
                !citation.quote.trim() ||
                !evidence.get(citation.evidenceId.toLowerCase())?.includes(citation.quote)
            )
                invalidQuestion('回答引用不属于当前报告或不是逐字连续原文');
        }
        if (
            !statement.text.trim() ||
            (statement.kind !== 'inference' &&
                !statement.citations.some((citation) => citation.quote.includes(statement.text)))
        )
            invalidQuestion('回答内容不是所列引用的逐字摘录');
    }
    return value;
}
export function questionResponse<T extends ReportQuestionDetail>(
    response: ApiResponse<T>,
    report: Report,
    expected: { id?: string; question?: string } = {},
    status = 200,
) {
    if (response.status !== status) invalidQuestion('回答 HTTP 状态不一致');
    validateQuestionDetail(response.data, report, expected);
    return response;
}
export const questionReasons: Record<QuestionAnswer['reason'], string> = {
    evidence_answer: '已从报告现有证据提取回答',
    insufficient_evidence: '报告现有证据不足以回答此问题。',
    model_unavailable: '未配置可用的问答模型，暂时无法提取回答。',
    model_failed: '本次模型调用失败，未获得可核验的回答。',
    invalid_output: '模型输出未通过原文核验，未作为回答展示。',
    aborted: '本次问答已中止，未获得可核验的回答。',
};
export function questionReadError(cause: unknown) {
    const error = toApiError(cause);
    if ([401, 403, 404].includes(error.status ?? 0)) return '回答不存在或当前账号无法访问。';
    if (error.code === 'QUESTION_PENDING') return '问题仍在处理中，请稍后明确读取本次结果。';
    if (['validation', 'protocol'].includes(error.kind))
        return '回答身份、结构或原文核验失败，暂时无法展示。';
    return '回答暂时无法读取，请重试。';
}
export function questionRetryAt(cause: unknown, now = Date.now()) {
    const error = toApiError(cause);
    const original = error.cause;
    const value =
        original instanceof CommunicationError
            ? original.response?.headers['retry-after']
            : undefined;
    if (![429, 503].includes(error.status ?? 0) || !value) return undefined;
    if (/^\d+$/u.test(value)) {
        const seconds = Number(value);
        return Number.isSafeInteger(seconds) && Number.isSafeInteger(now + seconds * 1000)
            ? now + seconds * 1000
            : undefined;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toUTCString() === value
        ? Math.max(now, time)
        : undefined;
}
