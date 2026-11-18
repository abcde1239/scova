import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
    comparisonBatches,
    comparisonOutputLimits,
    comparisonFromExtractions,
    comparisonOperation,
    comparisonRepairPages,
    comparisonSourceCoverage,
    comparisonReceipt,
    comparisonReceiptMatchesOutput,
} from '../src/report/comparison/extraction.ts';
import type { AgentContext, AgentPage, ComparisonExtraction } from '../src/types.ts';
import type { StructuredInput } from '@scova/connectors';

function fixture() {
    const context = { runId: 'run', mode: 'live', comparisonScopeHash: 'scope' } as AgentContext;
    const pages: AgentPage[] = Array.from({ length: 4 }, (_, i) => ({
        id: `read-${i}`,
        kind: 'read_page',
        mode: 'live',
        questionIds: ['q0'],
        url: `https://example.org/${i}`,
        fetchedUrl: `https://example.org/${i}`,
        originalUrl: `https://example.org/${i}`,
        text: 'Price 40. Deadline November 15.',
        title: 'Public notice',
        contentHash: createHash('sha256').update('Price 40. Deadline November 15.').digest('hex'),
        extractionVersion: 'test-v1',
        collectedAt: '2026-11-05T00:00:00Z',
        truncated: false,
        untrusted: true,
    }));
    const fact = (predicate = 'price', quote = 'Price 40.', value = '40') => ({
        subject: 'item',
        predicate,
        quote,
        value,
        relevance: 'relevant',
        importance: 'important',
        relation: null,
    });
    const receipt = (
        index: number,
        entries: { pageId: string; facts: unknown[] }[],
        repair = false,
    ): ComparisonExtraction => ({
        operationKey: comparisonOperation(index, repair),
        response: {
            mode: 'live',
            data: { pages: entries },
            usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        },
    });
    return { context, pages, fact, receipt };
}

describe('partial comparison extraction', () => {
    it('reconstructs legacy prefix coverage at 32k without rejecting already persisted receipts', () => {
        const { context, pages, fact, receipt } = fixture();
        const primary = receipt(0, [{ pageId: 'read-0', facts: [fact()] }]);
        const source = { ...pages[0]!, text: pages[0]!.text.padEnd(32_000, ' ') };
        expect(comparisonFromExtractions(context, [source], [primary]).gaps).toEqual([]);
        source.text += 'tail';
        expect(comparisonFromExtractions(context, [source], [primary]).gaps.join(' ')).toContain(
            '旧比较记录缺少完整输入覆盖证明',
        );
        expect(comparisonReceiptMatchesOutput(primary, primary.response)).toBe(true);
    });

    it('reconstructs clipped coverage from receipts and accepts proven full long-page input', () => {
        const { context, pages, fact, receipt } = fixture();
        const primary = receipt(0, [{ pageId: 'read-0', facts: [fact()] }]);
        const source = { ...pages[0]!, text: pages[0]!.text.padEnd(50_000, ' ') };
        primary.sourceCoverage = { version: 1, pages: [{ pageId: source.id, clipped: false }] };
        expect(comparisonFromExtractions(context, [source], [primary]).gaps).toEqual([]);
        primary.sourceCoverage.pages[0]!.clipped = true;
        expect(comparisonFromExtractions(context, [source], [primary]).gaps.join(' ')).toContain(
            '比较输入受预算限制',
        );
    });

    it('derives input coverage and preserves legacy replay without assigning new input coverage to old results', () => {
        const { receipt } = fixture();
        const response = receipt(0, []).response;
        const input = {
            untrustedSources: [
                { pageId: 'read-0', text: 'full' },
                { pageId: 'read-1', excerpts: ['head', 'tail'] },
            ],
        } as StructuredInput;
        const coverage = comparisonSourceCoverage(input);
        expect(coverage).toEqual({
            version: 1,
            pages: [
                { pageId: 'read-0', clipped: false },
                { pageId: 'read-1', clipped: true },
            ],
        });
        expect(comparisonReceipt('compare-facts-v1', response, input).sourceCoverage).toEqual(
            coverage,
        );
        const legacy = comparisonReceipt(
            'compare-facts-v1',
            { ...response, sourceCoverage: null },
            input,
        );
        expect(legacy).toEqual({ operationKey: 'compare-facts-v1', response });
        expect(comparisonReceiptMatchesOutput(legacy, response)).toBe(true);
    });

    it('authenticates coverage against immutable Worker model output including tampering and stripped metadata', () => {
        const { receipt } = fixture();
        const primary = receipt(0, []);
        const coverage = { version: 1 as const, pages: [{ pageId: 'read-0', clipped: true }] };
        const output = { ...primary.response, sourceCoverage: structuredClone(coverage) };
        primary.sourceCoverage = structuredClone(coverage);
        expect(comparisonReceiptMatchesOutput(primary, output)).toBe(true);
        primary.sourceCoverage.pages[0]!.clipped = false;
        expect(comparisonReceiptMatchesOutput(primary, output)).toBe(false);
        delete primary.sourceCoverage;
        expect(comparisonReceiptMatchesOutput(primary, output)).toBe(false);
        primary.sourceCoverage = coverage;
        expect(comparisonReceiptMatchesOutput(primary, primary.response)).toBe(false);
    });

    it.each(['foreign-page', 'duplicate-page', 'version', 'clipped-type'] as const)(
        'rejects %s coverage metadata',
        (kind) => {
            const { context, pages, fact, receipt } = fixture();
            const primary = receipt(0, [{ pageId: 'read-0', facts: [fact()] }]);
            const coverage = { version: 1, pages: [{ pageId: 'read-0', clipped: false }] };
            if (kind === 'foreign-page') coverage.pages[0]!.pageId = 'read-99';
            if (kind === 'duplicate-page') coverage.pages.push({ ...coverage.pages[0]! });
            if (kind === 'version') coverage.version = 99;
            if (kind === 'clipped-type')
                (coverage.pages[0] as unknown as Record<string, unknown>).clipped = 'false';
            primary.sourceCoverage = coverage as NonNullable<
                ComparisonExtraction['sourceCoverage']
            >;
            expect(() =>
                comparisonFromExtractions(context, pages.slice(0, 1), [primary]),
            ).toThrow();
        },
    );
    it('assigns ten-page output by batch size while keeping the old worst-case reservation', () => {
        const limits = comparisonOutputLimits(10, 16000);
        expect(limits).toEqual([
            { initial: 7200, repair: 7200 },
            { initial: 7200, repair: 7200 },
            { initial: 7200, repair: 7200 },
            { initial: 2400, repair: 2400 },
        ]);
    });
    it('preserves single-batch limits and bounds all supported page counts and small budgets', () => {
        expect(comparisonOutputLimits(0, 16000)).toEqual([]);
        expect(comparisonOutputLimits(3, 16000)).toEqual([{ initial: 16000, repair: 32000 }]);
        for (let count = 1; count <= 20; count++) {
            for (const stage of [100, 1000, 15999, 16000]) {
                const limits = comparisonOutputLimits(count, stage);
                const oldTotal = 3 * Math.floor(stage / limits.length) * limits.length;
                if (Math.floor(stage / limits.length) >= 256)
                    expect(limits.every((l) => l.initial >= 256)).toBe(true);
                expect(
                    limits.reduce((sum, l) => sum + l.initial + l.repair, 0),
                ).toBeLessThanOrEqual(oldTotal);
                expect(limits.every((l) => l.repair >= l.initial)).toBe(true);
            }
        }
    });
    it('bounds a repair that returns additional valid facts instead of failing the whole generation', () => {
        const { context, pages, fact, receipt } = fixture();
        const primary = receipt(0, [
            {
                pageId: 'read-0',
                facts: [
                    ...Array.from({ length: 11 }, (_, i) => fact(`p${i}`)),
                    fact('broken', 'Price 99.', '99'),
                ],
            },
        ]);
        const repair = receipt(
            0,
            [{ pageId: 'read-0', facts: Array.from({ length: 12 }, (_, i) => fact(`r${i}`)) }],
            true,
        );
        const result = comparisonFromExtractions(context, pages.slice(0, 1), [primary, repair]);
        expect(result.manifest!.pages[0]!.facts).toHaveLength(12);
        expect(result.gaps.length).toBeGreaterThan(0);
        expect(result.uncertain).toHaveLength(1);
    });
    it('keeps valid neighbors and a traceable uncertain value when one quote cannot be located', () => {
        const { context, pages, fact, receipt } = fixture();
        const first = receipt(
            0,
            pages.slice(0, 3).map((p) => ({
                pageId: p.id,
                facts: [
                    fact(),
                    ...(p.id === 'read-1'
                        ? [fact('deadline', 'Claimed November 20.', 'November 20')]
                        : []),
                ],
            })),
        );
        const second = receipt(1, [{ pageId: 'read-3', facts: [fact()] }]);
        const before = structuredClone(first);
        expect(comparisonBatches(pages).map((b) => b.length)).toEqual([3, 1]);
        expect(
            comparisonRepairPages(context, pages.slice(0, 3), first.response).map((p) => p.id),
        ).toEqual(['read-1']);
        const result = comparisonFromExtractions(context, pages, [first, second]);
        expect(first).toEqual(before);
        expect(result.manifest!.pages.flatMap((p) => p.facts)).toHaveLength(4);
        expect(result.uncertain).toEqual([
            expect.objectContaining({
                pageId: 'read-1',
                newValue: 'November 20',
                kind: 'uncertain',
                newCitations: [],
                important: false,
            }),
        ]);
        expect(result.gaps.join(' ')).toContain('待核实');
    });
    it('merges only a corrected pending fact, preserving previously accepted facts and page identities', () => {
        const { context, pages, fact, receipt } = fixture();
        const primary = receipt(0, [
            { pageId: 'read-0', facts: [fact(), fact('deadline', 'November 20', 'November 20')] },
        ]);
        const repair = receipt(
            0,
            [
                {
                    pageId: 'read-0',
                    facts: [fact('deadline', 'Deadline November 15.', 'November 15')],
                },
            ],
            true,
        );
        const result = comparisonFromExtractions(context, pages.slice(0, 1), [primary, repair]);
        expect(result.gaps).toEqual([]);
        expect(result.uncertain).toEqual([]);
        expect(result.manifest!.pages[0]!.facts.map((f) => [f.id, f.value])).toEqual([
            ['fact-0-0', '40'],
            ['fact-0-1', 'November 15'],
        ]);
    });
    it('keeps unobserved batch pages incomplete and never treats a missing or empty repair as proof', () => {
        const { context, pages, fact, receipt } = fixture();
        const primary = receipt(0, [
            { pageId: 'read-0', facts: [fact('price', 'Price 99.', '99')] },
        ]);
        const repair = receipt(0, [{ pageId: 'read-0', facts: [] }], true);
        const result = comparisonFromExtractions(context, pages, [primary, repair]);
        expect(result.manifest!.pages).toHaveLength(4);
        expect(result.manifest!.pages.every((p) => p.facts.length === 0)).toBe(true);
        expect(result.gaps.join(' ')).toContain('3个来源');
        expect(result.uncertain[0]!.newValue).toBe('99');
    });
    it.each(['duplicate', 'foreign-stage', 'mode'] as const)(
        'rejects %s receipt identity while keeping invalid quotes out of evidence',
        (kind) => {
            const { context, pages, fact, receipt } = fixture();
            const entry = receipt(0, [{ pageId: 'read-0', facts: [fact()] }]);
            const receipts = [entry];
            if (kind === 'duplicate') receipts.push(structuredClone(entry));
            if (kind === 'foreign-stage') entry.operationKey = 'compare-facts-batch-99-v2';
            if (kind === 'mode') entry.response.mode = 'demo';
            expect(() => comparisonFromExtractions(context, pages, receipts)).toThrow();
        },
    );
});
