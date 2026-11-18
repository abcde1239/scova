import { describe, expect, it } from 'vite-plus/test';
import type { SearchResponse, ReadPage } from '@scova/connectors';
import { searchCheckpointResponse, searchReceiptMatchesOutput } from '../src/search/receipt.ts';

const response: SearchResponse = {
    kind: 'search_results',
    mode: 'live',
    provider: 'deepseek',
    query: '公告截止日期',
    searchedAt: '2026-11-13T00:00:00Z',
    results: [
        {
            kind: 'search_snippet',
            originalUrl: 'https://example.com/notice',
            url: 'https://example.com/notice',
            title: '公告',
            snippet: '申请截止日期',
            score: 1,
            engines: ['fixture'],
            page: {
                kind: 'read_page',
                mode: 'live',
                originalUrl: 'https://example.com/notice',
                fetchedUrl: 'https://example.com/notice',
                url: 'https://example.com/notice',
                title: '公告',
                text: '申请截止日期为十一月十五日。',
                contentHash: 'a'.repeat(64),
                extractionVersion: 'fixture-v1',
                collectedAt: '2026-11-13T00:00:00Z',
                truncated: false,
                untrusted: true,
            } satisfies ReadPage,
        },
    ],
    coverage: {
        complete: true,
        gaps: [],
        unresponsiveEngines: [],
        receivedResults: 1,
        returnedResults: 1,
        discardedResults: 0,
        totalResults: 1,
        truncated: false,
    },
};

describe('search checkpoint receipts', () => {
    it('omits only provider bodies without mutating the ledger; accepts full legacy receipts', () => {
        const ledger = structuredClone(response);
        const receipt = searchCheckpointResponse(ledger);
        expect(receipt.results[0]).not.toHaveProperty('page');
        expect(ledger).toEqual(response);
        expect(searchReceiptMatchesOutput(receipt, ledger)).toBe(true);
        expect(searchReceiptMatchesOutput(structuredClone(ledger), ledger)).toBe(true);
        const withoutBody = searchCheckpointResponse(ledger);
        expect(searchReceiptMatchesOutput(withoutBody, withoutBody)).toBe(true);
    });

    it.each([
        'query',
        'provider',
        'mode',
        'searchedAt',
        'coverage',
        'url',
        'snippet',
        'title',
        'score',
        'engines',
        'order',
        'page',
    ])('rejects altered %s even when page bodies were omitted', (field) => {
        const receipt = searchCheckpointResponse(structuredClone(response));
        if (field === 'coverage') receipt.coverage.complete = false;
        else if (field === 'order') receipt.results.push(structuredClone(receipt.results[0]!));
        else if (field === 'page')
            receipt.results[0]!.page = { ...response.results[0]!.page!, text: '篡改正文' };
        else if (['query', 'provider', 'mode', 'searchedAt'].includes(field))
            Object.assign(receipt, { [field]: 'altered' });
        else Object.assign(receipt.results[0]!, { [field]: 'altered' });
        expect(searchReceiptMatchesOutput(receipt, response)).toBe(false);
    });

    it.each([null, {}, { results: [null] }, { results: [42] }, { results: [[]] }])(
        'rejects malformed ledger output %j',
        (output) =>
            expect(searchReceiptMatchesOutput(searchCheckpointResponse(response), output)).toBe(
                false,
            ),
    );
});
