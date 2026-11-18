import { object } from '../utils/guards.ts';
import { isConflictReviewOperation } from './conflict-review.ts';
import type { AgentCandidate, AgentClaim, AgentPage, ComparisonExtraction } from '../types.ts';
import type { PlannedRequirement } from '../report/artifacts/index.ts';

export type GapAction = 'rebind' | 'repair' | 'search' | 'read' | 'conflict';
type FieldCheck = {
    requirementId: string;
    status: 'supported' | 'binding_missing' | 'evidence_missing' | 'conflict';
    query: string;
    reason: string;
};

export function fieldChecksSchema(ids: string[]) {
    return {
        type: 'array',
        minItems: ids.length,
        maxItems: ids.length,
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['requirementId', 'status', 'query', 'reason'],
            properties: {
                requirementId: { type: 'string', ...(ids.length ? { enum: ids } : {}) },
                status: {
                    type: 'string',
                    enum: ['supported', 'binding_missing', 'evidence_missing', 'conflict'],
                },
                query: { type: 'string', maxLength: 200 },
                reason: { type: 'string', minLength: 1, maxLength: 500 },
            },
        },
    };
}

/** A field diagnosis must belong to its receipt's explicit frozen artifact targets. */
export function fieldChecks(receipts: ComparisonExtraction[], requirements: PlannedRequirement[]) {
    const latest = new Map<string, FieldCheck>();
    for (const receipt of receipts) {
        const data = receipt.response.data;
        if (!object(data) || !Array.isArray(data.fieldChecks) || !Array.isArray(data.artifacts))
            continue;
        const ids = data.artifacts.flatMap((a) =>
            object(a) && Array.isArray(a.requirements)
                ? a.requirements.flatMap((r) =>
                      object(r) &&
                      typeof r.id === 'string' &&
                      requirements.some((p) => p.id === r.id && p.format === a.format)
                          ? [r.id]
                          : [],
                  )
                : [],
        );
        if (data.fieldChecks.length !== ids.length || new Set(ids).size !== ids.length) continue;
        const checks: FieldCheck[] = [];
        for (const check of data.fieldChecks) {
            if (
                !object(check) ||
                Object.keys(check).some(
                    (key) => !['requirementId', 'status', 'query', 'reason'].includes(key),
                ) ||
                typeof check.requirementId !== 'string' ||
                !ids.includes(check.requirementId) ||
                checks.some((c) => c.requirementId === check.requirementId) ||
                !['supported', 'binding_missing', 'evidence_missing', 'conflict'].includes(
                    String(check.status),
                ) ||
                typeof check.query !== 'string' ||
                check.query.length > 200 ||
                typeof check.reason !== 'string' ||
                !check.reason.trim() ||
                check.reason.length > 500 ||
                (check.status === 'evidence_missing' ? !check.query.trim() : !!check.query)
            )
                break;
            checks.push(check as unknown as FieldCheck);
        }
        if (checks.length === ids.length)
            for (const check of checks) latest.set(check.requirementId, check);
    }
    return latest;
}

export function gapActions(
    candidate: AgentCandidate,
    requirements: PlannedRequirement[],
    receipts: ComparisonExtraction[],
    verifyModelAnswers = false,
) {
    const checks = fieldChecks(receipts, requirements);
    return (candidate.coverage.artifacts ?? []).flatMap((artifact) =>
        (artifact.coverage?.requirements ?? []).flatMap((field) => {
            if (
                !field.required ||
                field.status === 'supported' ||
                (!verifyModelAnswers && field.status === 'model_answered')
            )
                return [];
            const check = checks.get(field.id);
            const conflict = field.claimIndexes.some(
                (i) => candidate.claims[i]?.kind === 'conflict',
            );
            const data = [...receipts]
                .reverse()
                .map((r) => r.response.data)
                .find(
                    (data) =>
                        object(data) &&
                        Array.isArray(data.artifacts) &&
                        data.artifacts.some(
                            (a) =>
                                object(a) &&
                                Array.isArray(a.requirements) &&
                                a.requirements.some((r) => object(r) && r.id === field.id),
                        ),
                );
            const binding =
                object(data) && Array.isArray(data.artifacts)
                    ? data.artifacts
                          .flatMap((a) =>
                              object(a) && Array.isArray(a.requirements) ? a.requirements : [],
                          )
                          .find((r) => object(r) && r.id === field.id)
                    : undefined;
            // Broken indexes and invalid quotes take precedence over a model's missing-source diagnosis.
            const broken =
                object(binding) &&
                Array.isArray(binding.claimIndexes) &&
                binding.claimIndexes.some((i) => {
                    const claim =
                        object(data) && Array.isArray(data.claims) && Number.isInteger(i)
                            ? data.claims[i]
                            : undefined;
                    if (!object(claim)) return true;
                    if (claim.kind === 'insufficient' || claim.kind === 'model_answer')
                        return false;
                    return (
                        !Array.isArray(claim.citations) ||
                        !claim.citations.length ||
                        claim.citations.some(
                            (c) =>
                                !object(c) ||
                                typeof c.quote !== 'string' ||
                                !c.quote ||
                                !candidate.pages.some(
                                    (p) => p.id === c.pageId && p.text.includes(c.quote as string),
                                ),
                        )
                    );
                });
            const reviewed = receipts.some((r) => {
                const data = r.response.data;
                return (
                    isConflictReviewOperation(r.operationKey) &&
                    object(data) &&
                    object(data.conflictReview) &&
                    data.conflictReview.requirementId === field.id &&
                    data.conflictReview.resolution === 'unresolved'
                );
            });
            const missingBodies = verifyModelAnswers && !candidate.pages.length;
            const action: GapAction =
                reviewed && check?.status === 'evidence_missing'
                    ? 'search'
                    : conflict || check?.status === 'conflict'
                      ? 'conflict'
                      : missingBodies
                        ? 'search'
                        : broken
                          ? 'repair'
                          : check?.status === 'evidence_missing'
                            ? 'search'
                            : check
                              ? 'rebind'
                              : 'repair';
            return [
                {
                    requirementId: field.id,
                    questionIds: field.questionIds,
                    object: field.object,
                    field: field.field,
                    action,
                    query:
                        action === 'search'
                            ? check?.query ||
                              [field.object, field.field].filter(Boolean).join(' ').slice(0, 200)
                            : '',
                    reason: missingBodies
                        ? '没有可用于综合的正文，先取得字段所需材料。'
                        : (check?.reason ?? '尚无合法字段诊断，优先修复综合结构。'),
                },
            ];
        }),
    );
}

/** Explicit user obligations override a planner's stable-knowledge classification. Unknown is closed. */
export function allowsKnowledge(
    requirement: PlannedRequirement | undefined,
    questions: { id: string; text: string }[],
    goal = '',
) {
    if (requirement?.verification !== 'stable') return false;
    const text = [
        requirement.field,
        ...questions.filter((q) => requirement.questionIds.includes(q.id)).map((q) => q.text),
        goal,
    ].join(' ');
    return !/最新|实时|今日|今天|现价|当前价格|截至|精确|准确数值|具体数值|具体日期|指定出处|指定文献|逐字引用|\b(?:latest|current price|today|real.time|exact|benchmark score|sample size|specified source|verbatim|doi)\b/iu.test(
        text,
    );
}

/** Each accepted statement retains its binding, qualifications and immutable text selectors. */
export function propositionEvidence(
    claims: AgentClaim[],
    pages: AgentPage[],
    artifacts: AgentCandidate['coverage']['artifacts'],
) {
    return claims.flatMap((claim, claimIndex) => {
        if (claim.kind === 'insufficient') return [];
        const requirementIds = (artifacts ?? []).flatMap((a) =>
            (a.coverage?.requirements ?? [])
                .filter((r) => r.claimIndexes.includes(claimIndex))
                .map((r) => r.id),
        );
        return [
            {
                claimIndex,
                requirementIds,
                conditions: claim.assessment?.conditions ?? '',
                support:
                    claim.kind === 'model_answer'
                        ? ('none' as const)
                        : (claim.assessment?.support ?? ('unknown' as const)),
                passages: claim.citations.flatMap((citation) => {
                    const page = pages.find((p) => p.id === citation.pageId);
                    const start = page?.text.indexOf(citation.quote) ?? -1;
                    return page && start >= 0
                        ? [
                              {
                                  pageId: page.id,
                                  contentHash: page.contentHash,
                                  start,
                                  end: start + citation.quote.length,
                              },
                          ]
                        : [];
                }),
            },
        ];
    });
}

export const verificationInstructions = `For each frozen requirement, classify verification: stable for general concepts or mechanisms; current for live/current facts; exact for exact quantities, dates or empirical results; source_required for a user-specified source, citation or verbatim passage. A missing or uncertain classification never grants knowledge fallback. Keep the user's exact obligations; never relabel a live price or exact benchmark as stable to fill a gap. knowledgePlan is a candidate answer outline and verification route, not evidence.`;
export const fieldCheckInstructions = `Return fieldChecks exactly once per requested requirementId. Inspect supplied passages for that specific proposition, object, version and conditions: supported means sufficient passages and a valid binding; binding_missing means the material is already supplied but extraction/association/binding needs work; evidence_missing means the necessary material is absent, with one short complementary query naming the exact missing proposition (not the whole task); conflict means incompatible evidence, preserving both sides. query is empty except evidence_missing. Do not label JSON/quote/binding failure or excerpt clipping as absent external evidence. Never invent extra obligations. On repair, rebind existing material or correct the failed structure before requesting new sources. The application decides the action and retains completed answers.`;
