import { createHash } from 'node:crypto';
import {
    PAGE_TEXT_CHAR_LIMIT,
    validPageCollection,
    validPageLinks,
    type ReadPage,
} from '@scova/connectors';
import type { Usage } from '@scova/models';
import { AgentPersistenceError } from '@scova/shared/execution/agent';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const emptyUsage = (): Usage => ({
    searches: 0,
    pages: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: true,
});

export function readPage(value: unknown, mode: 'demo' | 'live'): ReadPage {
    const page = value as ReadPage | undefined;
    if (
        !page ||
        page.kind !== 'read_page' ||
        page.mode !== mode ||
        typeof page.text !== 'string' ||
        !page.text.trim() ||
        page.text.length > PAGE_TEXT_CHAR_LIMIT ||
        page.untrusted !== true ||
        typeof page.truncated !== 'boolean' ||
        !validPageCollection(page.collection) ||
        !validPageLinks(page.links) ||
        ![page.url, page.originalUrl, page.fetchedUrl].every(
            (url) => typeof url === 'string' && /^https?:\/\//.test(url),
        ) ||
        page.contentHash !== digest(page.text) ||
        !page.extractionVersion ||
        !Number.isFinite(Date.parse(page.collectedAt))
    )
        throw new AgentPersistenceError('INVALID_TOOL_RESULT');
    return page;
}
