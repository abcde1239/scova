import { object } from '../utils/guards.ts';

export function knowledgePlanSchema(questionIds: string[]) {
    return {
        type: 'array',
        maxItems: 10,
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['questionId', 'candidate', 'verify'],
            properties: {
                questionId: { type: 'string', enum: questionIds },
                candidate: { type: 'string', minLength: 1, maxLength: 600 },
                verify: { type: 'string', minLength: 1, maxLength: 300 },
            },
        },
    };
}

export function knowledgePlan(data: unknown, questionIds: string[]) {
    if (!object(data) || !Array.isArray(data.knowledgePlan) || data.knowledgePlan.length > 10)
        return [];
    return data.knowledgePlan.flatMap((entry) =>
        object(entry) &&
        typeof entry.questionId === 'string' &&
        questionIds.includes(entry.questionId) &&
        typeof entry.candidate === 'string' &&
        entry.candidate.trim() &&
        entry.candidate.length <= 600 &&
        typeof entry.verify === 'string' &&
        entry.verify.trim() &&
        entry.verify.length <= 300
            ? [{ questionId: entry.questionId, candidate: entry.candidate, verify: entry.verify }]
            : [],
    );
}

export const knowledgePlanInstructions = `Before choosing queries, use learned knowledge to outline up to ten tentative answer points in knowledgePlan, each with questionId, candidate and verify (what source evidence would confirm, qualify or refute it). These are UNVERIFIED search leads, never evidence, quotations or completed answers. Prioritize the user's exact conceptual mechanisms and original works, with complementary or disconfirming checks. Confirm any remembered reference through actual search; never invent a source or URL. Do not turn candidate details, evidence-quality commentary, fixed implementation parameters or exact benchmarks into required fields unless requested. Use [] if no reliable prior knowledge is available. Generate queries to verify these leads and the frozen questions within the existing budget.`;
