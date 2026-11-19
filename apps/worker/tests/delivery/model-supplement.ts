import { type StructuredInput } from '@scova/connectors';
import type { ModelResponse } from '@scova/connectors';
import type { LiveResearchOptions } from './live-options.ts';

export function deliverySupplementResponse<T>(
    options: LiveResearchOptions,
    input: StructuredInput,
): ModelResponse<T> | undefined {
    if (Object.hasOwn(input.schema.properties ?? {}, 'conflictReview')) {
        const data = JSON.parse(
            input.prompt.split('Untrusted frozen data: ')[1]!.split('\nUse outputFormat')[0]!,
        ) as {
            requirement: { id: string; format: string };
            prior: {
                hash: string;
                claim: { citations: { pageId: string; quote: string }[] };
            }[];
        };
        const { requirement, prior } = data;
        const quotes = prior
            .flatMap((p) => p.claim.citations)
            .filter(
                (q, i, all) =>
                    all.findIndex((c) => c.pageId === q.pageId && c.quote === q.quote) === i,
            );
        const query = '公共公告 同一轮申请 截止日期 原始更正通知';
        return {
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data: {
                conflictReview: {
                    requirementId: requirement.id,
                    priorClaimHashes: prior.map((p) => p.hash),
                    resolution: 'unresolved',
                    reason: '同一申请期限仍有冲突',
                    query,
                    sides: quotes.map((q) => ({
                        ...q,
                        subject: '申请截止日期',
                        comparator: '同一轮申请',
                        conditions: '尚未明确是否同一公告版本',
                        assertion: q.quote,
                    })),
                },
                claims: [],
                artifacts: [
                    {
                        format: requirement.format,
                        requirements: [{ id: requirement.id, text: '', claimIndexes: [] }],
                        document: null,
                    },
                ],
                fieldChecks: [
                    {
                        requirementId: requirement.id,
                        status: 'evidence_missing',
                        query,
                        reason: '需查更正通知',
                    },
                ],
                evidenceLinks: [],
            } as T,
        };
    }
    if (Object.hasOwn((input.schema.properties ?? {}) as object, 'answers')) {
        const canAnswer =
            !!options.modelAnswers &&
            (!/^Draft reliable Chinese answers/m.test(input.prompt) || !!options.draftAnswers);
        const schema = input.schema as {
            properties: {
                answers: {
                    items: { properties: { requirementId: { enum: string[] } } };
                };
            };
        };
        return {
            mode: 'live',
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
            data: {
                answers: schema.properties.answers.items.properties.requirementId.enum.map(
                    (requirementId) => ({
                        requirementId,
                        canAnswer,
                        text: canAnswer
                            ? '申请期限取决于具体公告；可先按资格、材料清单与截止日期逐项核对，不能从通用知识确定本次具体日期。'
                            : '',
                        reason: canAnswer
                            ? '能回答一般核对方法，具体日期仍未知'
                            : '缺少可可靠回答的已知信息',
                    }),
                ),
            } as T,
        };
    }
}
