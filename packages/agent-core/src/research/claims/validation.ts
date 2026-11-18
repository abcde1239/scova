import { isDeepStrictEqual } from 'node:util';
import {
    evidenceLinks,
    citationSupportsQuestions,
    type EvidenceLink,
} from '../../evidence/links.ts';
import { readAssessment } from '../../report/value.ts';
import { type AgentClaim } from '../../types.ts';
import { type ResearchState, MAX_QUESTIONS, object, strings, unique } from '../state.ts';
import { linkedEvidence } from './schema.ts';
import { modelAnswerProjections } from './projections.ts';

export function validatedClaims(
    value: unknown,
    state: ResearchState,
    links: EvidenceLink[] = linkedEvidence(state),
): AgentClaim[] | null {
    if (
        !object(value) ||
        !Array.isArray(value.claims) ||
        !value.claims.length ||
        value.claims.length > (state.coveragePolicy ? 192 : 30)
    )
        return null;
    const claims: AgentClaim[] = [];
    let savedModelClaims: unknown[] | undefined;
    for (const item of value.claims) {
        if (object(item) && item.kind === 'model_answer') {
            savedModelClaims ??= modelAnswerProjections(state).flatMap((r) =>
                object(r.response.data) && Array.isArray(r.response.data.claims)
                    ? r.response.data.claims
                    : [],
            );
            if (!savedModelClaims.some((claim) => isDeepStrictEqual(claim, item))) return null;
            claims.push(item as unknown as AgentClaim);
            continue;
        }
        const assessment = object(item) ? readAssessment(item.assessment) : undefined;
        if (
            !object(item) ||
            !['fact', 'inference', 'conflict', 'insufficient'].includes(String(item.kind)) ||
            (state.gapKindPolicy && item.kind !== 'insufficient' && !assessment?.gapKind) ||
            typeof item.text !== 'string' ||
            !item.text.trim() ||
            item.text.length > 2000 ||
            (item.outputFormat !== undefined &&
                (typeof item.outputFormat !== 'string' ||
                    !['brief', 'list', 'comparison', 'research_report'].includes(
                        item.outputFormat,
                    ))) ||
            !strings(item.questionIds, MAX_QUESTIONS, 50) ||
            !Array.isArray(item.citations) ||
            item.citations.length > 10 ||
            item.questionIds.some(
                (id) => !state.questions.some((question) => question.id === id),
            ) ||
            (item.uncertainty !== undefined &&
                (item.kind !== 'insufficient' ||
                    !strings(item.uncertainty, 4, 40) ||
                    item.uncertainty.some(
                        (code) =>
                            ![
                                'quote_unmatched',
                                'missing_citation',
                                'question_scope',
                                'conflict_incomplete',
                            ].includes(code),
                    )))
        )
            return null;
        if (
            state.collectionPolicy &&
            item.kind !== 'insufficient' &&
            (item.kind !== 'fact' || assessment?.support !== 'direct')
        )
            return null;
        const citations: AgentClaim['citations'] = [];
        for (const citation of item.citations) {
            if (
                !object(citation) ||
                typeof citation.pageId !== 'string' ||
                typeof citation.quote !== 'string' ||
                !citation.quote.trim() ||
                citation.quote.length > 2000
            )
                return null;
            const page = state.pages.find((entry) => entry.id === citation.pageId);
            if (
                !page ||
                !page.text.includes(citation.quote) ||
                !citationSupportsQuestions(page, citation.quote, item.questionIds, links)
            )
                return null;
            citations.push({ pageId: citation.pageId, quote: citation.quote });
        }
        if (item.kind !== 'insufficient' && !citations.length) return null;
        if (
            item.kind === 'conflict' &&
            new Set(citations.map((citation) => citation.pageId)).size < 2
        )
            return null;
        // Exact source text is a fact; semantic conclusions beyond the quote must be labelled inference.
        if (
            item.kind === 'fact' &&
            !citations.some((citation) => citation.quote.includes(item.text as string))
        )
            return null;
        claims.push({
            ...(typeof item.outputFormat === 'string' &&
            ['brief', 'list', 'comparison', 'research_report'].includes(item.outputFormat)
                ? { outputFormat: item.outputFormat as AgentClaim['outputFormat'] }
                : {}),
            ...(assessment ? { assessment } : {}),
            kind: item.kind as AgentClaim['kind'],
            text: item.text,
            questionIds: unique(item.questionIds),
            citations,
            ...(item.uncertainty
                ? { uncertainty: item.uncertainty as AgentClaim['uncertainty'] }
                : {}),
        });
    }
    return claims;
}

export function softenClaim(item: unknown, state: ResearchState, links: EvidenceLink[]): unknown {
    if (
        !object(item) ||
        !['fact', 'inference', 'conflict', 'insufficient'].includes(String(item.kind)) ||
        typeof item.text !== 'string' ||
        !item.text.trim() ||
        item.text.length > 2000 ||
        !Array.isArray(item.citations) ||
        item.citations.length > 10 ||
        !strings(item.questionIds, MAX_QUESTIONS, 50)
    )
        return item;
    const uncertainty: NonNullable<AgentClaim['uncertainty']> = [];
    const citations: AgentClaim['citations'] = [];
    for (const c of item.citations) {
        const page =
            object(c) && typeof c.pageId === 'string'
                ? state.pages.find((p) => p.id === c.pageId)
                : undefined;
        if (
            !page ||
            !object(c) ||
            typeof c.quote !== 'string' ||
            !c.quote.trim() ||
            c.quote.length > 2000 ||
            !page.text.includes(c.quote)
        ) {
            uncertainty.push('quote_unmatched');
            continue;
        }
        citations.push({ pageId: page.id, quote: c.quote });
    }
    const questionIds = item.questionIds.filter(
        (id) =>
            state.questions.some((q) => q.id === id) &&
            citations.every((c) =>
                citationSupportsQuestions(
                    state.pages.find((p) => p.id === c.pageId)!,
                    c.quote,
                    [id],
                    links,
                ),
            ),
    );
    if (questionIds.length !== item.questionIds.length) uncertainty.push('question_scope');
    if (item.kind !== 'insufficient' && !citations.length) uncertainty.push('missing_citation');
    if (item.kind === 'conflict' && new Set(citations.map((c) => c.pageId)).size < 2)
        uncertainty.push('conflict_incomplete');
    const kind = uncertainty.length
        ? 'insufficient'
        : item.kind === 'fact' && !citations.some((c) => c.quote.includes(item.text as string))
          ? 'inference'
          : item.kind;
    const assessment = readAssessment(item.assessment);
    return {
        kind,
        ...(item.outputFormat !== undefined ? { outputFormat: item.outputFormat } : {}),
        text: item.text,
        citations,
        questionIds,
        ...(assessment ? { assessment } : {}),
        ...(uncertainty.length ? { uncertainty: unique(uncertainty) } : {}),
    };
}

export function partitionClaims(value: unknown, state: ResearchState, receiptOnly = false) {
    const links =
        state.evidencePolicy && receiptOnly
            ? evidenceLinks(
                  [{ response: { data: value } }],
                  state.pages,
                  state.questions.map((q) => q.id),
              )
            : linkedEvidence(state);
    const accepted: AgentClaim[] = [];
    const issues: NonNullable<ResearchState['claimIssues']> = [];
    if (
        !object(value) ||
        !Array.isArray(value.claims) ||
        !value.claims.length ||
        value.claims.length > 30
    )
        return {
            accepted,
            issues: [{ index: 0, code: 'invalid_structure', questionIds: [] as string[] }],
        };
    value.claims.forEach((item: unknown, index: number) => {
        if (
            state.collectionPolicy &&
            object(item) &&
            item.kind !== 'insufficient' &&
            (item.kind !== 'fact' ||
                readAssessment(item.assessment)?.support !== 'direct' ||
                !Array.isArray(item.citations) ||
                !item.citations.some(
                    (c) =>
                        object(c) &&
                        typeof c.quote === 'string' &&
                        typeof item.text === 'string' &&
                        c.quote.includes(item.text),
                ))
        ) {
            issues.push({ index, code: 'collection_direct_required', questionIds: [] });
            return;
        }
        const valid = validatedClaims(
            { claims: [state.softEvidence ? softenClaim(item, state, links) : item] },
            state,
            links,
        );
        if (valid) {
            accepted.push(...valid);
            const uncertainty = valid[0]?.uncertainty;
            if (uncertainty?.length)
                issues.push({
                    index,
                    code:
                        uncertainty[0] === 'quote_unmatched' ? 'quote_not_exact' : uncertainty[0]!,
                    questionIds: valid[0]!.questionIds,
                    hint: uncertainty.includes('question_scope')
                        ? `Claim was downgraded: every cited passage must support every claim questionId. Cited-source discovery scopes: ${JSON.stringify(valid[0]!.citations.map((c) => ({ pageId: c.pageId, questionIds: state.pages.find((p) => p.id === c.pageId)!.questionIds })))}. ${state.evidencePolicy ? 'Return an evidenceLinks entry in this response only if the exact passage semantically supports the requested question; include the citation and essential conditions. Otherwise split the claim or choose another source. Preserve discovery IDs.' : 'Split claims or choose sources authorized for the requested question; do not expand source scope.'} Recheck every quote verbatim.`.slice(
                              0,
                              1000,
                          )
                        : `Claim was downgraded and cannot enter the answer. Repair the exact contiguous quote, source scope or missing evidence. ${object(item) ? JSON.stringify(item.citations).slice(0, 700) : ''}`,
                });
            return;
        }
        let code = 'invalid_structure';
        if (object(item) && Array.isArray(item.citations)) {
            code = 'question_scope_mismatch';
            if (!item.citations.length && item.kind !== 'insufficient') code = 'missing_citation';
            else if (
                item.citations.some((c) => object(c) && !state.pages.some((p) => p.id === c.pageId))
            )
                code = 'unknown_page';
            else if (
                item.citations.some(
                    (c) =>
                        object(c) &&
                        typeof c.quote === 'string' &&
                        !state.pages.find((p) => p.id === c.pageId)?.text.includes(c.quote),
                )
            )
                code = 'quote_not_exact';
            else if (
                item.kind === 'fact' &&
                !item.citations.some(
                    (c) =>
                        object(c) &&
                        typeof c.quote === 'string' &&
                        typeof item.text === 'string' &&
                        c.quote.includes(item.text),
                )
            )
                code = 'fact_text_not_in_quote';
            else if (item.kind === 'conflict') code = 'incomplete_conflict';
        }
        if (state.gapKindPolicy && object(item) && !readAssessment(item.assessment)?.gapKind)
            code = 'missing_gap_kind';
        issues.push({
            index,
            code,
            questionIds:
                object(item) && strings(item.questionIds, MAX_QUESTIONS, 50)
                    ? item.questionIds.filter((id) => state.questions.some((q) => q.id === id))
                    : [],
        });
    });
    return { accepted, issues };
}
