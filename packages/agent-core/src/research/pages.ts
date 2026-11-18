import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PAGE_TEXT_CHAR_LIMIT } from '@scova/connectors';
import {
    AgentError,
    type AgentContext,
    type AgentDependencies,
    type AgentPage,
    type AgentPageRef,
} from '../types.ts';
import { MAX_PAGES, allowed, type ResearchState } from './state.ts';

const invalid = () => new AgentError('INVALID_STATE', '检查点正文与不可变读取回执不一致');
const reference = ({ text: _text, ...ref }: AgentPage): AgentPageRef => ref;

/** ResearchState is the hydrated domain view; the graph transport omits bodies under pagePolicy. */
export function checkpointWithoutPageText(state: ResearchState): ResearchState {
    if (!state.pagePolicy) return state;
    return { ...state, pages: state.pages.map(reference) as AgentPage[] };
}

export function assertPageText(state: ResearchState): void {
    if (state.pagePolicy && state.pages.some((page) => typeof page.text !== 'string'))
        throw invalid();
}

/** Only load receipt bodies: matching metadata alone does not authorize replacement content. */
export async function hydrateCheckpointPages(
    context: AgentContext,
    state: ResearchState,
    loadPages: AgentDependencies['loadPages'],
): Promise<ResearchState> {
    if (!state || typeof state !== 'object' || !Array.isArray(state.pages)) throw invalid();
    if (!state.pagePolicy) return structuredClone(state);
    if (state.pagePolicy !== 1 || !loadPages || state.pages.length > MAX_PAGES) throw invalid();
    const refs = state.pages.map(reference);
    if (new Set(refs.map((page) => page.id)).size !== refs.length) throw invalid();
    const pages = refs.length ? await loadPages(structuredClone(refs)) : [];
    if (
        pages.length !== refs.length ||
        pages.some(
            (page, index) =>
                !isDeepStrictEqual(reference(page), refs[index]) ||
                typeof page.text !== 'string' ||
                !page.text.trim() ||
                page.text.length > PAGE_TEXT_CHAR_LIMIT ||
                page.mode !== context.mode ||
                page.kind !== 'read_page' ||
                !allowed(context, page.url) ||
                !allowed(context, page.fetchedUrl) ||
                createHash('sha256').update(page.text, 'utf8').digest('hex') !== page.contentHash,
        )
    )
        throw invalid();
    return { ...structuredClone(state), pages: structuredClone(pages) };
}
