import { object } from '../utils/guards.ts';
import type { AgentPage, ComparisonExtraction } from '../types.ts';

export interface EvidenceLink {
    pageId: string;
    questionId: string;
    quote: string;
    reason: string;
}

/** Discovery scope stays immutable. A new association covers only its saved verbatim span. */
export function evidenceLinks(
    receipts: { response: Pick<ComparisonExtraction['response'], 'data'> }[],
    pages: AgentPage[],
    questionIds: string[],
): EvidenceLink[] {
    return receipts.flatMap(({ response }) => {
        const data = response.data;
        if (!object(data) || !Array.isArray(data.evidenceLinks) || data.evidenceLinks.length > 30)
            return [];
        return data.evidenceLinks.flatMap((link) => {
            if (
                !object(link) ||
                Object.keys(link).some(
                    (key) => !['pageId', 'questionId', 'quote', 'reason'].includes(key),
                ) ||
                typeof link.pageId !== 'string' ||
                typeof link.questionId !== 'string' ||
                !questionIds.includes(link.questionId) ||
                typeof link.quote !== 'string' ||
                !link.quote.trim() ||
                link.quote.length > 2000 ||
                typeof link.reason !== 'string' ||
                !link.reason.trim() ||
                link.reason.length > 500 ||
                !pages.some(
                    (page) => page.id === link.pageId && page.text.includes(link.quote as string),
                )
            )
                return [];
            return [link as unknown as EvidenceLink];
        });
    });
}

export function citationSupportsQuestions(
    page: AgentPage,
    quote: string,
    questionIds: string[],
    links: EvidenceLink[],
): boolean {
    return questionIds.every(
        (id) =>
            page.questionIds.includes(id) ||
            links.some(
                (link) =>
                    link.pageId === page.id && link.questionId === id && link.quote.includes(quote),
            ),
    );
}

export function evidenceLinksSchema(pageIds: string[], questionIds: string[]) {
    return {
        type: 'array',
        maxItems: pageIds.length && questionIds.length ? 30 : 0,
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['pageId', 'questionId', 'quote', 'reason'],
            properties: {
                pageId: { type: 'string', ...(pageIds.length ? { enum: pageIds } : {}) },
                questionId: {
                    type: 'string',
                    ...(questionIds.length ? { enum: questionIds } : {}),
                },
                quote: { type: 'string', minLength: 1, maxLength: 2000 },
                reason: { type: 'string', minLength: 1, maxLength: 500 },
            },
        },
    };
}

export const evidenceLinkInstructions = `Source questionIds describe discovery, not exclusive semantic relevance. Inspect the actual supplied passages for the batch's fields. To cite a passage for a question outside its discovery IDs, return evidenceLinks with pageId, questionId, a contiguous verbatim quote covering the citation and essential conditions, and a specific semantic support reason. Only associate material that actually supports that question; a matching topic or word is insufficient. Unrelated passages receive no association. Never change source discovery IDs, invent quotations, or use learned knowledge as external evidence. Every cited source must support the claim's question, through its discovery IDs or an explicit passage association. Return evidenceLinks:[] when no new association is needed. The application verifies spans and authenticates the model receipt; semantic support remains a model assessment.`;
