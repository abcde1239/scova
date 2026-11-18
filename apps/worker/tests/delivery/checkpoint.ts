import type { AgentCandidate } from '@scova/agent-core';

/** Restore bodies only for pure candidate projection; keep persisted references and attacks intact. */
export function checkpointWithBodies<T>(state: T, pages: AgentCandidate['pages']): T {
    const copy = structuredClone(state) as T & { pages: AgentCandidate['pages'] };
    copy.pages = copy.pages.map((page) => {
        if (typeof page.text === 'string') return page;
        const body = pages.find((candidate) => candidate.id === page.id)?.text;
        if (body === undefined) throw new Error(`Missing fixture body for ${page.id}`);
        return { ...page, text: body };
    });
    return copy;
}
