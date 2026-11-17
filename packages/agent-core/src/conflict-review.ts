import { object } from './guards.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentClaim, ComparisonExtraction } from './types.ts';
import type { PlannedRequirement } from './report-artifacts.ts';

export const isConflictReviewOperation = (key: string) =>
    /^conflict-review-(?:[2-9]|[1-5][0-9]|6[0-4])-[a-f0-9]{16}-[01]$/.test(key);
export const conflictReviewOperation = (pass: number, id: string, attempt: number) =>
    `conflict-review-${pass}-${createHash('sha256').update(id).digest('hex').slice(0, 16)}-${attempt}`;
export const conflictFingerprint = (c: AgentClaim) =>
    createHash('sha256')
        .update(
            JSON.stringify([
                c.kind,
                c.outputFormat,
                c.text,
                c.questionIds,
                c.citations.map((q) => [q.pageId, q.quote]),
                c.assessment?.conditions ?? '',
            ]),
        )
        .digest('hex');

export function conflictReviewSchema(requirement: PlannedRequirement, prior: AgentClaim[]) {
    const text = { type: 'string', minLength: 1, maxLength: 500 };
    return {
        type: 'object',
        additionalProperties: false,
        required: ['requirementId', 'priorClaimHashes', 'resolution', 'reason', 'query', 'sides'],
        properties: {
            requirementId: { type: 'string', enum: [requirement.id] },
            priorClaimHashes: {
                type: 'array',
                minItems: prior.length,
                maxItems: prior.length,
                items: { type: 'string', enum: prior.map(conflictFingerprint) },
            },
            resolution: { type: 'string', enum: ['conditional', 'unresolved'] },
            reason: text,
            query: { type: 'string', maxLength: 200 },
            sides: {
                type: 'array',
                minItems: 2,
                maxItems: 10,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                        'pageId',
                        'quote',
                        'subject',
                        'comparator',
                        'conditions',
                        'assertion',
                    ],
                    properties: {
                        pageId: {
                            type: 'string',
                            enum: [
                                ...new Set(prior.flatMap((c) => c.citations.map((q) => q.pageId))),
                            ],
                        },
                        quote: { type: 'string', minLength: 1, maxLength: 2000 },
                        subject: text,
                        comparator: text,
                        conditions: text,
                        assertion: text,
                    },
                },
            },
        },
    };
}

/** Keep every old citation and its conditions. A successful review is still a model assessment. */
export function validConflictReview(
    data: unknown,
    requirement: PlannedRequirement,
    prior: AgentClaim[],
): boolean {
    if (!object(data) || !object(data.conflictReview)) return false;
    const review = data.conflictReview;
    const savedHashes = review.priorClaimHashes;
    const sides = review.sides;
    const hashes = prior.map(conflictFingerprint);
    if (
        !prior.length ||
        prior.some((c) => c.kind !== 'conflict') ||
        review.requirementId !== requirement.id ||
        Object.keys(review).some(
            (k) =>
                ![
                    'requirementId',
                    'priorClaimHashes',
                    'resolution',
                    'reason',
                    'query',
                    'sides',
                ].includes(k),
        ) ||
        !Array.isArray(savedHashes) ||
        savedHashes.length !== hashes.length ||
        new Set(savedHashes).size !== hashes.length ||
        !hashes.every((h) => savedHashes.includes(h)) ||
        !['conditional', 'unresolved'].includes(String(review.resolution)) ||
        typeof review.reason !== 'string' ||
        !review.reason.trim() ||
        review.reason.length > 500 ||
        typeof review.query !== 'string' ||
        review.query.length > 200 ||
        !Array.isArray(sides) ||
        sides.length < 2 ||
        sides.length > 10
    )
        return false;
    const citations = prior
        .flatMap((c) => c.citations)
        .filter((q, i, all) => all.findIndex((n) => isDeepStrictEqual(n, q)) === i);
    if (
        sides.length !== citations.length ||
        !citations.every(
            (q) =>
                sides.filter((s) => object(s) && s.pageId === q.pageId && s.quote === q.quote)
                    .length === 1,
        )
    )
        return false;
    if (
        sides.some(
            (s) =>
                !object(s) ||
                Object.keys(s).some(
                    (k) =>
                        ![
                            'pageId',
                            'quote',
                            'subject',
                            'comparator',
                            'conditions',
                            'assertion',
                        ].includes(k),
                ) ||
                ['subject', 'comparator', 'conditions', 'assertion'].some(
                    (k) => typeof s[k] !== 'string' || !s[k].trim() || s[k].length > 500,
                ),
        )
    )
        return false;
    if (
        !Array.isArray(data.claims) ||
        !Array.isArray(data.artifacts) ||
        data.artifacts.length !== 1 ||
        !object(data.artifacts[0])
    )
        return false;
    const artifact = data.artifacts[0];
    if (
        artifact.format !== requirement.format ||
        !Array.isArray(artifact.requirements) ||
        artifact.requirements.length !== 1 ||
        !object(artifact.requirements[0]) ||
        artifact.document !== null
    )
        return false;
    const binding = artifact.requirements[0];
    if (
        binding.id !== requirement.id ||
        !Array.isArray(data.fieldChecks) ||
        data.fieldChecks.length !== 1 ||
        !object(data.fieldChecks[0]) ||
        !Array.isArray(data.evidenceLinks)
    )
        return false;
    const check = data.fieldChecks[0];
    if (
        check.requirementId !== requirement.id ||
        typeof check.reason !== 'string' ||
        !check.reason.trim() ||
        check.reason.length > 500
    )
        return false;
    if (review.resolution === 'unresolved')
        return (
            !!review.query.trim() &&
            data.claims.length === 0 &&
            binding.text === '' &&
            isDeepStrictEqual(binding.claimIndexes, []) &&
            check.status === 'evidence_missing' &&
            check.query === review.query &&
            data.evidenceLinks.length === 0
        );
    const claim = data.claims[0];
    if (!object(claim) || !Array.isArray(claim.citations) || !object(claim.assessment))
        return false;
    const quotes = claim.citations,
        assessment = claim.assessment,
        text = claim.text;
    return (
        review.query === '' &&
        data.claims.length === 1 &&
        claim.kind === 'inference' &&
        claim.outputFormat === requirement.format &&
        Array.isArray(claim.questionIds) &&
        claim.questionIds.length === requirement.questionIds.length &&
        new Set(claim.questionIds).size === requirement.questionIds.length &&
        requirement.questionIds.every((id) => (claim.questionIds as unknown[]).includes(id)) &&
        typeof text === 'string' &&
        !!text.trim() &&
        text.length <= 2000 &&
        text === binding.text &&
        isDeepStrictEqual(binding.claimIndexes, [0]) &&
        quotes.length === citations.length &&
        citations.every((q) => quotes.some((n) => isDeepStrictEqual(n, q))) &&
        assessment.relevance === 'direct' &&
        assessment.support === 'direct' &&
        assessment.role === 'answer' &&
        assessment.gap === '' &&
        typeof assessment.conditions === 'string' &&
        sides.every(
            (s) =>
                object(s) &&
                text.includes(s.conditions as string) &&
                (assessment.conditions as string).includes(s.conditions as string),
        ) &&
        check.status === 'supported' &&
        check.query === ''
    );
}

/** Only an explicit authenticated review may retire a particular conflict from the main answer. */
export function resolvedConflictHashes(
    receipts: ComparisonExtraction[],
    requirements: PlannedRequirement[],
    claims: AgentClaim[],
) {
    return new Set(
        receipts.flatMap((r) => {
            const data = r.response.data;
            if (
                !isConflictReviewOperation(r.operationKey) ||
                !object(data) ||
                !object(data.conflictReview) ||
                data.conflictReview.resolution !== 'conditional' ||
                !Array.isArray(data.conflictReview.priorClaimHashes)
            )
                return [];
            const hashes = data.conflictReview.priorClaimHashes,
                id = data.conflictReview.requirementId;
            const requirement = requirements.find((p) => p.id === id);
            const prior = claims.filter(
                (c) => c.kind === 'conflict' && hashes.includes(conflictFingerprint(c)),
            );
            return requirement && validConflictReview(data, requirement, prior)
                ? prior.map(conflictFingerprint)
                : [];
        }),
    );
}

export const conflictReviewPrompt = `Review a disputed field using the supplied original passages. Normalize each side into subject, comparator, conditions (task/dataset, version, time, metric and configuration), and assertion. Opposite directions with DIFFERENT comparators or configurations can both be true: planning cheaper than ReAct and LATS dearer than ReAct are not contradictory. Do not resolve a genuine same-subject/same-comparator/same-condition contradiction by voting, source count or learned knowledge. Preserve it as unresolved and give one complementary query naming the disputed proposition and missing conditions. If all sides can coexist AND the requested field can be answered from them, return conditional: one inference answering the whole field with EACH side's conditions copied verbatim into both claim.text and assessment.conditions. Preserve every original citation exactly. Return each supplied priorClaimHash once. Do not omit a side, invent a condition, generalize benchmark numbers, or declare a universal cost ordering. Unknown conditions must remain explicitly unknown; ambiguity is unresolved. Evidence links must authorize every cited passage for every requested question from its actual semantics. With unresolved return claims:[], empty field text/indexes, fieldChecks evidence_missing with query equal to the review query, evidenceLinks:[]; with conditional return one inference, one binding, fieldChecks supported. The review is a model semantic assessment, not independent fact verification.`;

export const conflictReviewRepairPrompt = `The previous response failed the field review contract. Rebuild it from the supplied original passages. For conditional: conflictReview.query and fieldChecks[0].query MUST be empty strings; fieldChecks[0].status MUST be supported; claims MUST contain exactly one inference with assessment.relevance=direct, support=direct, role=answer, gap="". Its questionIds MUST include every frozen field question exactly once. Set artifacts[0].requirements[0].text to the COMPLETE claim.text verbatim and claimIndexes:[0], document:null. Each side.conditions must be a short precise condition phrase; copy EACH phrase EXACTLY, including punctuation, into BOTH claim.text and assessment.conditions. Check these exact substring relationships before returning. Preserve ALL original quotes. For each quote outside a page's discovery IDs, include evidenceLinks for every needed question only if semantically supported; never infer authorization from topic overlap. Do not invent a default configuration or generalize a benchmark. If these passages do not establish enough to answer this field, return unresolved with zero claims, an empty binding, a concrete nonempty query in BOTH review and fieldChecks evidence_missing, and empty evidenceLinks. Never mix these two response branches.`;
